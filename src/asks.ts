// The ask/approve loop.
//
// A job that needs a person's OK does not block a process waiting for a click.
// It saves an Ask whose action is plain data, marks its run `waiting`, and
// returns. Whoever resolves the ask later (the dashboard, the CLI, a test)
// runs the action through `performAction`. When the last ask of a run is
// resolved, the run finishes. Because nothing lives only in memory, a run can
// wait overnight and survive a daemon restart.

import type { Ask, AskAction, RunRecord } from "./types.ts";
import type { Store } from "./store.ts";
import { newId } from "./store.ts";
import type { Vault } from "./vault/vault.ts";
import { mergeWorktree, removeWorktree } from "./worktree.ts";

export interface AskContext {
  store: Store;
  vault: Vault;
  /** Only repos listed in config may be merged into. */
  repos: Record<string, { path: string }>;
}

export function queueAsk(
  ctx: AskContext,
  run: RunRecord,
  q: { question: string; detail?: string; action: AskAction; onDecline?: AskAction },
): Ask {
  const ask: Ask = {
    id: newId("ask"),
    runId: run.id,
    jobId: run.jobId,
    question: q.question,
    detail: q.detail,
    action: q.action,
    onDecline: q.onDecline,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  ctx.store.saveAsk(ask);
  return ask;
}

export async function performAction(ctx: AskContext, action: AskAction): Promise<{ result: string; writes: string[] }> {
  switch (action.type) {
    case "none":
      return { result: "nothing to do", writes: [] };
    case "move-note":
      ctx.vault.move(action.from, action.to);
      return { result: `moved ${action.from} → ${action.to}`, writes: [action.to] };
    case "write-note":
      ctx.vault.write(action.path, action.content);
      return { result: `wrote ${action.path}`, writes: [action.path] };
    case "merge-branch": {
      assertKnownRepo(ctx, action.repo);
      const sha = await mergeWorktree(action.repo, action.branch, action.worktree, action.into, action.test);
      return { result: `merged ${action.branch} into ${action.into} at ${sha.slice(0, 7)}`, writes: [] };
    }
    case "remove-worktree": {
      assertKnownRepo(ctx, action.repo);
      await removeWorktree(action.repo, action.worktree, action.branch);
      return { result: `removed ${action.branch} and its worktree`, writes: [] };
    }
  }
  throw new Error(`unknown action ${(action as { type: string }).type}`);
}

function assertKnownRepo(ctx: AskContext, repo: string): void {
  if (!Object.values(ctx.repos).some((r) => r.path === repo)) throw new Error(`repo is not listed in config: ${repo}`);
}

export async function resolveAsk(ctx: AskContext, askId: string, decision: "approve" | "decline"): Promise<Ask> {
  const ask = ctx.store.getAsk(askId);
  if (!ask) throw new Error(`no ask ${askId}`);
  if (ask.status !== "pending") throw new Error(`ask ${askId} is already ${ask.status}`);

  let status: Ask["status"] = decision === "approve" ? "approved" : "declined";
  let result = "declined";
  let writes: string[] = [];
  try {
    const action = decision === "approve" ? ask.action : ask.onDecline;
    if (action) {
      const done = await performAction(ctx, action);
      writes = done.writes;
      result = decision === "approve" ? done.result : `declined; ${done.result}`;
    }
  } catch (err) {
    status = "failed";
    result = (err as Error).message;
  }
  const resolved = ctx.store.saveAsk({ ...ask, status, result, resolvedAt: new Date().toISOString() });
  finishRunIfDone(ctx, ask.runId, writes);
  return resolved;
}

/** A waiting run succeeds once none of its asks are pending (fails if an action failed). */
function finishRunIfDone(ctx: AskContext, runId: string, newWrites: string[]): void {
  const run = ctx.store.getRun(runId);
  if (!run) return;
  const asks = ctx.store.asks().filter((a) => a.runId === runId);
  const writes = [...run.writes, ...newWrites];
  if (asks.some((a) => a.status === "pending")) {
    ctx.store.updateRun(runId, { writes });
    return;
  }
  const failed = asks.filter((a) => a.status === "failed");
  const approved = asks.filter((a) => a.status === "approved").length;
  const declined = asks.filter((a) => a.status === "declined").length;
  ctx.store.updateRun(runId, {
    writes,
    status: failed.length ? "failed" : "succeeded",
    error: failed.length ? failed.map((a) => a.result).join("; ") : undefined,
    finishedAt: new Date().toISOString(),
    summary: `${run.summary ?? ""} (${approved} approved, ${declined} declined)`.trim(),
  });
}
