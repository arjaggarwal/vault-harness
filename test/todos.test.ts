import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sortTodoFile } from "../src/jobs/todos.ts";

const demo = fs.readFileSync(path.join(import.meta.dirname, "..", "demo-vault", "tasks", "todo.md"), "utf8");

test("sorts by priority then due date, and moves checked items to Done", () => {
  const res = sortTodoFile(demo);
  const open = res.text.split("## Done")[0].split("\n").filter((l) => l.startsWith("- ["));
  assert.match(open[0], /#urgent/);
  assert.match(open[1], /#high 📅 2026-11-24/);
  assert.match(open[2], /#high 📅 2026-12-01/);
  assert.match(open.at(-1)!, /#low/);
  assert.equal(res.movedToDone, 1);
  assert.match(res.text.split("## Done")[1], /Book the Globex pricing call/);
});

test("keeps every line, and children travel with their item", () => {
  const res = sortTodoFile(demo);
  const lines = (t: string) => t.split("\n").filter((l) => l.trim() !== "").sort();
  assert.deepEqual(lines(res.text), lines(demo));
  const out = res.text.split("\n");
  const i = out.findIndex((l) => l.includes("Initech Q1 steel"));
  assert.match(out[i + 1], /^\s+- Initech price goes up/);
});

test("sorting twice changes nothing", () => {
  const once = sortTodoFile(demo).text;
  const twice = sortTodoFile(once);
  assert.equal(twice.changed, false);
});
