// A tiny five-field cron parser: minute hour day-of-month month day-of-week.
// Supports `*`, lists (`1,15`), ranges (`1-5`), steps (`*/15`, `0-30/10`) and
// 0 or 7 for Sunday. Times are evaluated in the process's local time zone.
//
// It is small on purpose: the scheduler only needs "does this minute match?",
// "when is the next match?" and "when was the last match?" (for catch-up).

export interface CronSpec {
  source: string;
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /** True when day-of-month or day-of-week was restricted (classic cron OR rule). */
  domRestricted: boolean;
  dowRestricted: boolean;
}

const FIELDS: Array<[name: string, min: number, max: number]> = [
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["day-of-month", 1, 31],
  ["month", 1, 12],
  ["day-of-week", 0, 7],
];

function parseField(text: string, min: number, max: number, name: string): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const [rangeText, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`cron ${name}: bad step "${part}"`);
    let lo: number;
    let hi: number;
    if (rangeText === "*") {
      lo = min;
      hi = max;
    } else if (rangeText.includes("-")) {
      const [a, b] = rangeText.split("-").map(Number);
      lo = a;
      hi = b;
    } else {
      lo = Number(rangeText);
      hi = stepText === undefined ? lo : max;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`cron ${name}: "${part}" is outside ${min}-${max}`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron "${expr}": expected 5 fields, got ${parts.length}`);
  const sets = parts.map((p, i) => parseField(p, FIELDS[i][1], FIELDS[i][2], FIELDS[i][0]));
  const dow = sets[4];
  if (dow.has(7)) {
    dow.delete(7);
    dow.add(0);
  }
  return {
    source: expr,
    minute: sets[0],
    hour: sets[1],
    dayOfMonth: sets[2],
    month: sets[3],
    dayOfWeek: dow,
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*",
  };
}

export function matches(spec: CronSpec, d: Date): boolean {
  if (!spec.minute.has(d.getMinutes())) return false;
  if (!spec.hour.has(d.getHours())) return false;
  if (!spec.month.has(d.getMonth() + 1)) return false;
  const domOk = spec.dayOfMonth.has(d.getDate());
  const dowOk = spec.dayOfWeek.has(d.getDay());
  // Classic cron: when both day fields are restricted, either may match.
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

const MINUTE = 60_000;
const SEARCH_LIMIT = 366 * 24 * 60; // one year of minutes

function floorMinute(d: Date): Date {
  const out = new Date(d);
  out.setSeconds(0, 0);
  return out;
}

/** First matching minute strictly after `from`. */
export function nextRun(spec: CronSpec, from: Date): Date | null {
  let t = floorMinute(from).getTime() + MINUTE;
  for (let i = 0; i < SEARCH_LIMIT; i++, t += MINUTE) {
    const d = new Date(t);
    if (matches(spec, d)) return d;
  }
  return null;
}

/** Last matching minute at or before `from`. */
export function previousRun(spec: CronSpec, from: Date): Date | null {
  let t = floorMinute(from).getTime();
  for (let i = 0; i < SEARCH_LIMIT; i++, t -= MINUTE) {
    const d = new Date(t);
    if (matches(spec, d)) return d;
  }
  return null;
}
