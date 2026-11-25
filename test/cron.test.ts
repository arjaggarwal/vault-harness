import test from "node:test";
import assert from "node:assert/strict";
import { parseCron, matches, nextRun, previousRun } from "../src/cron.ts";

test("parses lists, ranges and steps", () => {
  const s = parseCron("*/15 9-17 * * 1-5");
  assert.deepEqual([...s.minute], [0, 15, 30, 45]);
  assert.deepEqual([...s.hour], [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual([...s.dayOfWeek], [1, 2, 3, 4, 5]);
});

test("7 means Sunday", () => {
  assert.ok(parseCron("0 0 * * 7").dayOfWeek.has(0));
});

test("rejects bad expressions", () => {
  assert.throws(() => parseCron("* * * *"), /5 fields/);
  assert.throws(() => parseCron("60 * * * *"), /outside/);
  assert.throws(() => parseCron("*/0 * * * *"), /bad step/);
});

test("weekday 07:30 matches Friday, not Saturday", () => {
  const s = parseCron("30 7 * * 1-5");
  assert.ok(matches(s, new Date(2026, 10, 20, 7, 30))); // Fri
  assert.ok(!matches(s, new Date(2026, 10, 21, 7, 30))); // Sat
});

test("day-of-month and day-of-week are OR'd when both are set", () => {
  const s = parseCron("0 12 1 * 5");
  assert.ok(matches(s, new Date(2026, 10, 20, 12, 0))); // a Friday, not the 1st
  assert.ok(matches(s, new Date(2026, 11, 1, 12, 0))); // the 1st, a Tuesday
  assert.ok(!matches(s, new Date(2026, 10, 19, 12, 0)));
});

test("next and previous run", () => {
  const s = parseCron("30 7 * * 1-5");
  const fri = new Date(2026, 10, 20, 8, 0);
  assert.deepEqual(nextRun(s, fri), new Date(2026, 10, 23, 7, 30)); // Monday
  assert.deepEqual(previousRun(s, fri), new Date(2026, 10, 20, 7, 30));
  assert.deepEqual(previousRun(s, new Date(2026, 10, 20, 7, 30)), new Date(2026, 10, 20, 7, 30));
});
