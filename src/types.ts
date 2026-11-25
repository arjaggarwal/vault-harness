// Shared shapes. Everything the harness stores is plain JSON so it can be read
// with `cat` and diffed in tests.

export type ProviderName = "claude" | "codex" | "mock";

/** A job as declared in jobs.json. */
export interface JobDef {
  id: string;
  title: string;
  /** `native` runs TypeScript in-process; `skill` runs a local AI CLI against a SKILL.md. */
  type: "native" | "skill";
  /** Five-field cron expression. Omit for manual-only jobs. */
  schedule?: string;
  /** Run once at startup if the last scheduled time was missed while the daemon was down. */
  catchUp?: boolean;
  /** Native jobs: name of the handler in src/jobs/native.ts. */
  handler?: string;
  /** Skill jobs: folder under skills/ holding SKILL.md. */
  skill?: string;
  provider?: ProviderName;
  /** Skill jobs: what the agent may do. `read` = read-only tools; `write` = may edit files in its cwd. */
  access?: "read" | "write";
  timeoutSec?: number;
  enabled?: boolean;
}

export type RunStatus = "running" | "waiting" | "succeeded" | "failed" | "skipped";

export interface RunRecord {
  id: string;
  jobId: string;
  trigger: "schedule" | "manual" | "catch-up" | "demo";
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  summary?: string;
  /** Vault-relative paths this run wrote. */
  writes: string[];
  /** Ask ids this run is waiting on. */
  asks: string[];
  error?: string;
  /** Raw agent output, trimmed, for the dashboard. */
  output?: string;
}

/**
 * What an approved ask does. Actions are data, not closures, so a run that is
 * waiting on the user survives a daemon restart: whoever resolves the ask
 * (dashboard, CLI, test) looks up the handler by `type` and runs it.
 */
export type AskAction =
  | { type: "move-note"; from: string; to: string }
  | { type: "write-note"; path: string; content: string }
  | { type: "merge-branch"; repo: string; branch: string; worktree: string; into: string; test?: string[] }
  | { type: "remove-worktree"; repo: string; branch: string; worktree: string }
  | { type: "none" };

export type AskStatus = "pending" | "approved" | "declined" | "failed";

export interface Ask {
  id: string;
  runId: string;
  jobId: string;
  question: string;
  /** Extra context shown under the question (a diff stat, a note preview). */
  detail?: string;
  action: AskAction;
  /** Run when the ask is declined (for example, remove a worktree). */
  onDecline?: AskAction;
  status: AskStatus;
  createdAt: string;
  resolvedAt?: string;
  result?: string;
}

/** What a skill run must end with: a fenced ```harness-result JSON block. */
export interface AgentResult {
  summary: string;
  writes?: Array<{ path: string; content: string; mode?: "replace" | "append" | "section" }>;
  asks?: Array<{ question: string; detail?: string; action: AskAction }>;
}
