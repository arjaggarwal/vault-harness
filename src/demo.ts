// npm run demo [-- --serve]
//
// Runs the whole loop against a throwaway copy of the demo vault, with the mock
// CLI standing in for Claude Code, so it needs no AI login:
//   native job → skill job → asks (approve one, decline one) → ask the vault →
//   code task in a worktree → merge on approval → weekly changelog.
// With --serve it then opens the dashboard on the same workspace.

import path from "node:path";
import { execFileSync } from "node:child_process";
import { Harness } from "./harness.ts";
import { Scheduler } from "./scheduler.ts";
import { startServer } from "./server/serve.ts";
import { createDemoWorkspace, DEMO_NOW } from "./demo-setup.ts";
import type { RunRecord } from "./types.ts";

const tty = process.stdout.isTTY;
const c = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c(1);
const dim = c(2);
const green = c(32);
const purple = c(35);
const red = c(31);

function step(n: number, title: string): void {
  console.log(`\n${bold(`${n}. ${title}`)}`);
}

function show(run: RunRecord): void {
  const color = run.status === "succeeded" ? green : run.status === "waiting" ? purple : red;
  console.log(`   ${color(run.status)}  ${run.summary ?? run.error ?? ""}`);
  if (run.error) console.log(`   ${red(run.error)}`);
}

function indent(text: string, prefix = "   │ "): string {
  return text
    .trimEnd()
    .split("\n")
    .map((l) => dim(prefix) + l)
    .join("\n");
}

async function main(): Promise<void> {
  const serve = process.argv.includes("--serve");
  const { root, config } = createDemoWorkspace();
  const harness = new Harness(config);
  harness.now = () => DEMO_NOW;
  const vault = harness.vault;

  console.log(bold("Vault Harness demo"));
  console.log(dim(`workspace: ${root}`));
  console.log(dim(`"today" is pinned to ${DEMO_NOW.toDateString()}; the AI CLI is the mock in bin/mock-agent.mjs`));

  step(1, "Native job: sort the to-do list (no AI call)");
  show(await harness.runJob("sort-todos", "demo"));
  console.log(indent(vault.read("tasks/todo.md").split("## Done")[0]));

  step(2, "Skill job: morning briefing (CLI + SKILL.md, agent proposes, harness writes)");
  show(await harness.runJob("morning-briefing", "demo"));
  console.log(indent(vault.read("_agent/briefing.md")));

  step(3, "Skill job with asks: file the inbox");
  const inboxRun = await harness.runJob("file-inbox", "demo");
  show(inboxRun);
  const asks = harness.pendingAsks().filter((a) => a.runId === inboxRun.id);
  for (const a of asks) console.log(`   ${purple("?")} ${a.question}  ${dim(a.detail ?? "")}`);
  console.log(dim("   The run is parked as `waiting`. Approve two, decline the idea note:"));
  for (const a of asks) {
    const decision = a.action.type === "move-note" && a.action.to.startsWith("ideas/") ? "decline" : "approve";
    const done = await harness.resolveAsk(a.id, decision);
    console.log(`   ${decision === "approve" ? green("✓ approved") : dim("✗ declined")}  ${done.result}`);
  }
  show(harness.store.getRun(inboxRun.id)!);

  step(4, "Ask the vault: grep, read, cite, and the harness checks every citation");
  const question = "What discount did Globex ask for, and what did Acme offer?";
  console.log(`   ${bold("Q:")} ${question}`);
  const answer = await harness.askVault(question);
  const trace = answer.answer.split("\n").filter((l) => l.startsWith("✱"));
  const body = answer.answer.split("\n").filter((l) => l && !l.startsWith("✱"));
  console.log(indent(trace.join("\n"), "   · "));
  console.log(indent(body.join("\n")));
  for (const cit of answer.citations) {
    console.log(`   ${cit.verified ? green("✓") : red("✗")} ${cit.path}:${cit.line} ${dim(cit.text ?? cit.reason ?? "")}`);
  }

  step(5, "Code task in a git worktree, merged only on approval");
  const codeRun = await harness.codeTask("acme-site", "Fix the typo in the README", "demo");
  show(codeRun);
  const mergeAsk = harness.store.getAsk(codeRun.asks[0]);
  if (mergeAsk) {
    console.log(`   ${purple("?")} ${mergeAsk.question}`);
    console.log(indent(mergeAsk.detail ?? ""));
    const done = await harness.resolveAsk(mergeAsk.id, "approve");
    console.log(`   ${green("✓ approved")}  ${done.result}`);
    const site = config.repos["acme-site"].path;
    console.log(indent(execFileSync("git", ["log", "--oneline", "--graph", "-5"], { cwd: site, encoding: "utf8" })));
  }

  step(6, "Skill job: weekly changelog (git log + changed notes gathered in TypeScript first)");
  show(await harness.runJob("weekly-changelog", "demo"));
  console.log(indent(vault.read("_agent/changelog/latest.md")));

  const runs = harness.store.runs();
  console.log(`\n${bold("Done.")} ${runs.length} runs recorded in ${dim(path.join(config.stateDir, "runs.json"))}`);
  console.log(`Inbox now: ${vault.listNotes("Inbox").join(", ") || "empty"}`);

  if (!serve) {
    console.log(dim("Run `npm run demo -- --serve` to open the dashboard on this workspace."));
    return;
  }
  // Fresh ask for the dashboard: the declined idea note is still in the inbox.
  harness.now = () => new Date();
  await harness.runJob("file-inbox", "demo");
  const scheduler = new Scheduler(harness);
  startServer(harness, scheduler, config.port);
  console.log(`\nDashboard: ${bold(`http://127.0.0.1:${config.port}`)}  (one ask is waiting for you; Ctrl+C to stop)`);
}

main().catch((err) => {
  console.error(red(`demo failed: ${(err as Error).stack ?? err}`));
  process.exit(1);
});
