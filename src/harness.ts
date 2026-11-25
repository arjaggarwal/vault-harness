// The harness: one object that owns the config, the store and the vault, and
// runs jobs. The scheduler, the dashboard, the CLI and the demo all call the
// same `runJob`, so there is no second, hidden path for "Run Now".

import fs from "node:fs";
import path from "node:path";
import type { HarnessConfig } from "./config.ts";
import { Store, newId } from "./store.ts";
import { Vault } from "./vault/vault.ts";
import type { Ask, JobDef, RunRecord } from "./types.ts";
import { NATIVE_HANDLERS } from "./jobs/native.ts";
import { loadSkill, buildPrompt, checkWrites, isoDate } from "./agents/skill.ts";
import { buildContext } from "./agents/context.ts";
import { parseAgentResult } from "./agents/result.ts";
import { runAgent } from "./providers/cli.ts";
import { queueAsk, resolveAsk } from "./asks.ts";
import type { AskContext } from "./asks.ts";
import { checkCitations } from "./agents/ask-vault.ts";
import type { VaultAnswer } from "./agents/ask-vault.ts";
import { createWorktree, inspectBranch, removeWorktree } from "./worktree.ts";

const OUTPUT_LIMIT = 20_000;

export type RunListener = (run: RunRecord) => void;

export class Harness {
  readonly store: Store;
  readonly vault: Vault;
  private readonly running = new Set<string>();
  private readonly listeners = new Set<RunListener>();
  /** Injected clock, so tests and the demo can pin "today". */
  now: () => Date = () => new Date();

  constructor(readonly config: HarnessConfig) {
    this.store = new Store(config.stateDir);
    this.vault = new Vault(config.vault);
  }

  get jobs(): JobDef[] {
    return this.config.jobs;
  }

  job(id: string): JobDef {
    const j = this.config.jobs.find((x) => x.id === id);
    if (!j) throw new Error(`no job "${id}"`);
    return j;
  }

  isRunning(jobId: string): boolean {
    return this.running.has(jobId);
  }

  onRun(fn: RunListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private save(run: RunRecord): RunRecord {
    this.store.saveRun(run);
    for (const fn of this.listeners) fn(run);
    return run;
  }

  private askContext(): AskContext {
    return { store: this.store, vault: this.vault, repos: this.config.repos };
  }

  private startRun(jobId: string, trigger: RunRecord["trigger"]): RunRecord {
    return this.save({
      id: newId("run"),
      jobId,
      trigger,
      status: "running",
      startedAt: this.now().toISOString(),
      writes: [],
      asks: [],
    });
  }

  private finish(run: RunRecord, patch: Partial<RunRecord>): RunRecord {
    const status = patch.status ?? (run.asks.length > 0 || (patch.asks?.length ?? 0) > 0 ? "waiting" : "succeeded");
    return this.save({
      ...run,
      ...patch,
      status,
      finishedAt: status === "waiting" ? undefined : this.now().toISOString(),
    });
  }

  /**
   * Run a job once. A second run of a job that is still running is recorded
   * as `skipped` rather than started, so a slow job never stacks up.
   */
  async runJob(jobId: string, trigger: RunRecord["trigger"] = "manual", args: Record<string, string> = {}): Promise<RunRecord> {
    const job = this.job(jobId);
    if (this.running.has(jobId)) {
      const t = this.now().toISOString();
      return this.save({
        id: newId("run"),
        jobId,
        trigger,
        status: "skipped",
        startedAt: t,
        finishedAt: t,
        summary: "already running",
        writes: [],
        asks: [],
      });
    }
    this.running.add(jobId);
    const run = this.startRun(jobId, trigger);
    try {
      if (job.type === "native") return await this.runNative(job, run, args);
      return await this.runSkill(job, run, args);
    } catch (err) {
      return this.finish(run, { status: "failed", error: (err as Error).message });
    } finally {
      this.running.delete(jobId);
    }
  }

  private async runNative(job: JobDef, run: RunRecord, args: Record<string, string>): Promise<RunRecord> {
    const handler = NATIVE_HANDLERS[job.handler!];
    if (!handler) throw new Error(`no native handler "${job.handler}"`);
    const res = await handler({ vault: this.vault, now: this.now(), args, outputDir: this.config.outputDir });
    const asks = (res.asks ?? []).map((a) => queueAsk(this.askContext(), run, a).id);
    return this.finish(run, { summary: res.summary, writes: res.writes ?? [], asks });
  }

  private agentWorkspace(): string {
    // An empty folder as the CLI's cwd: no project instructions get picked up
    // by accident, and the vault is granted explicitly.
    const dir = path.join(this.config.stateDir, "agent-workspace");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private async runSkill(job: JobDef, run: RunRecord, args: Record<string, string>): Promise<RunRecord> {
    const skill = loadSkill(this.config.skillsDir, job.skill!);
    const now = this.now();
    const context = await buildContext(skill.context, { vault: this.vault, now, repos: this.config.repos });
    const prompt = buildPrompt({
      skill,
      job,
      run,
      vaultPath: this.vault.root,
      outputDir: this.config.outputDir,
      now,
      args,
      context,
    });
    const reply = await runAgent(
      {
        provider: job.provider ?? this.config.defaultProvider,
        prompt,
        cwd: this.agentWorkspace(),
        addDirs: [this.vault.root],
        access: "read",
        timeoutSec: job.timeoutSec,
        env: { HARNESS_RUN_ID: run.id, HARNESS_JOB_ID: job.id, HARNESS_SKILL: skill.name },
      },
      this.config.providers,
    );
    const output = reply.text.slice(-OUTPUT_LIMIT);

    if (skill.result === "answer") {
      const summary = args.question ? `Q: ${args.question}` : reply.text.split("\n")[0];
      return this.finish(run, { summary: summary.slice(0, 200), output });
    }

    // A malformed result fails the run; its text is kept for the dashboard but never acted on.
    const result = parseAgentResult(reply.text);
    checkWrites(skill, result);
    const writes: string[] = [];
    for (const w of result.writes ?? []) {
      if (w.mode === "append") this.vault.append(w.path, w.content);
      else if (w.mode === "section") this.vault.writeSection(w.path, job.id, w.content);
      else this.vault.write(w.path, w.content);
      writes.push(w.path);
    }
    if (skill.expects) this.checkExpected(skill.expects, now);
    const asks = (result.asks ?? []).map((a) => queueAsk(this.askContext(), run, a).id);
    return this.finish(run, { summary: result.summary, writes, asks, output });
  }

  /** Don't trust the model's word that it worked: the expected file must exist and be today's. */
  private checkExpected(rel: string, now: Date): void {
    if (!this.vault.exists(rel)) throw new Error(`sanity check: ${rel} was not written`);
    if (!this.vault.read(rel).includes(isoDate(now))) throw new Error(`sanity check: ${rel} does not mention ${isoDate(now)}`);
  }

  // ---- asks ---------------------------------------------------------------

  pendingAsks(): Ask[] {
    return this.store.pendingAsks();
  }

  async resolveAsk(askId: string, decision: "approve" | "decline"): Promise<Ask> {
    const ask = await resolveAsk(this.askContext(), askId, decision);
    const run = this.store.getRun(ask.runId);
    if (run) for (const fn of this.listeners) fn(run);
    return ask;
  }

  // ---- ask the vault ------------------------------------------------------

  async askVault(question: string): Promise<VaultAnswer & { run: RunRecord }> {
    const run = await this.runJob("ask-vault", "manual", { question });
    if (run.status !== "succeeded") throw new Error(run.error ?? `ask-vault ${run.status}`);
    const answer = checkCitations(this.vault, run.output ?? "");
    return { ...answer, run };
  }

  // ---- code tasks ---------------------------------------------------------

  /**
   * Run a coding task in a fresh worktree of a configured repo. The run ends
   * `waiting` on a merge ask when the agent committed something.
   */
  async codeTask(repoName: string, task: string, trigger: RunRecord["trigger"] = "manual"): Promise<RunRecord> {
    const repo = this.config.repos[repoName];
    if (!repo) throw new Error(`no repo "${repoName}" in config`);
    const job = this.job("code-task");
    if (this.running.has(job.id)) throw new Error("a code task is already running");
    this.running.add(job.id);
    const run = this.startRun(job.id, trigger);
    let wt: Awaited<ReturnType<typeof createWorktree>> | undefined;
    try {
      wt = await createWorktree(repo.path, task, this.now());
      const skill = loadSkill(this.config.skillsDir, job.skill!);
      const prompt = buildPrompt({
        skill,
        job,
        run,
        vaultPath: this.vault.root,
        outputDir: this.config.outputDir,
        now: this.now(),
        args: { task, repo: repoName, branch: wt.branch, worktree: wt.path },
        context: [],
      });
      const reply = await runAgent(
        {
          provider: job.provider ?? this.config.defaultProvider,
          prompt,
          cwd: wt.path,
          access: "write",
          timeoutSec: job.timeoutSec,
          env: { HARNESS_RUN_ID: run.id, HARNESS_JOB_ID: job.id, HARNESS_SKILL: skill.name },
        },
        this.config.providers,
      );
      const report = await inspectBranch(wt);
      const output = reply.text.slice(-OUTPUT_LIMIT);
      if (report.dirty) {
        await removeWorktree(repo.path, wt.path, wt.branch);
        return this.finish(run, { status: "failed", error: "agent left uncommitted changes; branch removed", output });
      }
      if (report.commits === 0) {
        await removeWorktree(repo.path, wt.path, wt.branch);
        return this.finish(run, { summary: "nothing to ship: the agent made no commits", output });
      }
      const ask = queueAsk(this.askContext(), run, {
        question: `Merge ${wt.branch} into ${wt.base} in ${repoName}?`,
        detail: `${report.log}\n\n${report.diffStat}`,
        action: { type: "merge-branch", repo: repo.path, branch: wt.branch, worktree: wt.path, into: wt.base, test: repo.test },
        onDecline: { type: "remove-worktree", repo: repo.path, branch: wt.branch, worktree: wt.path },
      });
      return this.finish(run, {
        summary: `${report.commits} commit(s) on ${wt.branch}`,
        asks: [ask.id],
        output,
      });
    } catch (err) {
      if (wt) await removeWorktree(repo.path, wt.path, wt.branch).catch(() => {});
      return this.finish(run, { status: "failed", error: (err as Error).message });
    } finally {
      this.running.delete(job.id);
    }
  }
}
