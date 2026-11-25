// The scheduler is a reconciler, not a set of timers.
//
// Every tick (20 s by default) it walks each minute since the last sweep and
// fires the jobs whose cron matches, each at most once per sweep. Per-job
// timers drift and can silently skip a slot after a sleep or a busy event
// loop; a sweep over the minutes since last time cannot. Gaps longer than a
// day (laptop closed over a weekend) are clamped, so waking up doesn't fire
// a backlog.
//
// Cron never replays a missed run on its own, so catch-up is explicit: at
// start, a job marked `catchUp` whose last scheduled slot passed with no run
// since is run once. Catch-up runs go one at a time, a little apart.

import { parseCron, matches, nextRun, previousRun } from "./cron.ts";
import type { CronSpec } from "./cron.ts";
import type { Harness } from "./harness.ts";

const MINUTE = 60_000;
const MAX_GAP = 24 * 60 * MINUTE;

export interface SchedulerOptions {
  tickMs?: number;
  catchUpDelayMs?: number;
}

export class Scheduler {
  private specs = new Map<string, CronSpec>();
  private lastSweep: number;
  private timer?: NodeJS.Timeout;
  readonly tickMs: number;
  readonly catchUpDelayMs: number;

  constructor(
    private readonly harness: Harness,
    opts: SchedulerOptions = {},
  ) {
    this.tickMs = opts.tickMs ?? 20_000;
    this.catchUpDelayMs = opts.catchUpDelayMs ?? 30_000;
    for (const job of harness.jobs) {
      if (job.schedule && job.enabled !== false) this.specs.set(job.id, parseCron(job.schedule));
    }
    this.lastSweep = floorMinute(harness.now().getTime());
  }

  start(): void {
    void this.catchUp();
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One sweep. Returns the job ids it fired (for tests and logs). */
  tick(): string[] {
    const now = floorMinute(this.harness.now().getTime());
    const from = Math.max(this.lastSweep + MINUTE, now - MAX_GAP);
    const fired = new Set<string>();
    for (let t = from; t <= now; t += MINUTE) {
      const d = new Date(t);
      for (const [id, spec] of this.specs) {
        if (!fired.has(id) && matches(spec, d)) fired.add(id);
      }
    }
    if (now > this.lastSweep) this.lastSweep = now;
    for (const id of fired) void this.harness.runJob(id, "schedule");
    return [...fired];
  }

  /** Jobs whose last scheduled slot was missed. */
  overdue(): string[] {
    const now = this.harness.now();
    const out: string[] = [];
    for (const job of this.harness.jobs) {
      const spec = this.specs.get(job.id);
      if (!spec || !job.catchUp) continue;
      const prev = previousRun(spec, now);
      if (!prev) continue;
      const last = this.harness.store.lastRun(job.id);
      if (!last || new Date(last.startedAt) < prev) out.push(job.id);
    }
    return out;
  }

  async catchUp(): Promise<string[]> {
    const ids = this.overdue();
    for (let i = 0; i < ids.length; i++) {
      if (i > 0 || this.catchUpDelayMs > 0) await sleep(this.catchUpDelayMs);
      await this.harness.runJob(ids[i], "catch-up");
    }
    return ids;
  }

  nextRunAt(jobId: string): Date | null {
    const spec = this.specs.get(jobId);
    return spec ? nextRun(spec, this.harness.now()) : null;
  }
}

function floorMinute(ms: number): number {
  return Math.floor(ms / MINUTE) * MINUTE;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms).unref?.());
}
