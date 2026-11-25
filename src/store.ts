// A JSON-file store for runs and asks. One file per collection under the state
// directory, written atomically (temp file + rename) so a crash never leaves a
// half-written file. Fine for a single-user daemon; swap for SQLite if you
// need concurrent writers.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Ask, RunRecord } from "./types.ts";

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export class Store {
  readonly runsFile: string;
  readonly asksFile: string;
  /** Keep the run log bounded. */
  maxRuns = 500;

  constructor(readonly stateDir: string) {
    this.runsFile = path.join(stateDir, "runs.json");
    this.asksFile = path.join(stateDir, "asks.json");
  }

  // ---- runs -------------------------------------------------------------

  runs(): RunRecord[] {
    return readJson<RunRecord[]>(this.runsFile, []);
  }

  getRun(id: string): RunRecord | undefined {
    return this.runs().find((r) => r.id === id);
  }

  saveRun(run: RunRecord): RunRecord {
    const all = this.runs();
    const i = all.findIndex((r) => r.id === run.id);
    if (i >= 0) all[i] = run;
    else all.unshift(run);
    writeJsonAtomic(this.runsFile, all.slice(0, this.maxRuns));
    return run;
  }

  updateRun(id: string, patch: Partial<RunRecord>): RunRecord {
    const run = this.getRun(id);
    if (!run) throw new Error(`no run ${id}`);
    return this.saveRun({ ...run, ...patch });
  }

  lastRun(jobId: string): RunRecord | undefined {
    return this.runs().find((r) => r.jobId === jobId && r.status !== "skipped");
  }

  // ---- asks -------------------------------------------------------------

  asks(): Ask[] {
    return readJson<Ask[]>(this.asksFile, []);
  }

  getAsk(id: string): Ask | undefined {
    return this.asks().find((a) => a.id === id);
  }

  saveAsk(ask: Ask): Ask {
    const all = this.asks();
    const i = all.findIndex((a) => a.id === ask.id);
    if (i >= 0) all[i] = ask;
    else all.unshift(ask);
    writeJsonAtomic(this.asksFile, all);
    return ask;
  }

  pendingAsks(): Ask[] {
    return this.asks().filter((a) => a.status === "pending");
  }
}
