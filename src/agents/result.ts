// The contract between a skill and the harness: the agent proposes, the
// harness disposes. A skill does its reading with the CLI's own read-only
// tools, then ends its reply with one fenced block:
//
//   ```harness-result
//   { "summary": "...", "writes": [...], "asks": [...] }
//   ```
//
// The harness validates the block and applies writes itself, through the
// vault helpers and their path guards. Anything that needs a person's OK
// comes back as an ask instead of a write.

import type { AgentResult, AskAction } from "../types.ts";

const FENCE = /```harness-result\s*\n([\s\S]*?)\n```/g;

export class ResultError extends Error {}

export function parseAgentResult(text: string): AgentResult {
  const blocks = [...text.matchAll(FENCE)];
  if (blocks.length === 0) throw new ResultError("the agent's reply had no ```harness-result block");
  const raw = blocks[blocks.length - 1][1];
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    throw new ResultError(`harness-result is not valid JSON: ${(err as Error).message}`);
  }
  return validate(obj);
}

function validate(obj: unknown): AgentResult {
  if (!obj || typeof obj !== "object") throw new ResultError("harness-result must be an object");
  const o = obj as Record<string, unknown>;
  if (typeof o.summary !== "string" || o.summary.trim() === "") throw new ResultError("harness-result needs a summary");
  const writes = (o.writes ?? []) as AgentResult["writes"];
  const asks = (o.asks ?? []) as AgentResult["asks"];
  if (!Array.isArray(writes) || !Array.isArray(asks)) throw new ResultError("writes and asks must be arrays");
  for (const w of writes) {
    if (typeof w?.path !== "string" || typeof w?.content !== "string") throw new ResultError("each write needs path and content");
    if (w.mode && !["replace", "append", "section"].includes(w.mode)) throw new ResultError(`bad write mode ${w.mode}`);
  }
  for (const a of asks) {
    if (typeof a?.question !== "string") throw new ResultError("each ask needs a question");
    checkAction(a.action);
  }
  return { summary: o.summary.trim(), writes, asks };
}

/** Agents may only propose vault-level actions; merging code is the harness's own ask. */
function checkAction(action: AskAction | undefined): void {
  if (!action || typeof action !== "object") throw new ResultError("each ask needs an action");
  switch (action.type) {
    case "move-note":
      if (typeof action.from !== "string" || typeof action.to !== "string") throw new ResultError("move-note needs from and to");
      return;
    case "write-note":
      if (typeof action.path !== "string" || typeof action.content !== "string") throw new ResultError("write-note needs path and content");
      return;
    case "none":
      return;
    default:
      throw new ResultError(`agents may not propose a "${(action as { type: string }).type}" action`);
  }
}
