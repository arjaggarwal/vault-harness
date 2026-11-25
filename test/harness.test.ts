import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { demoHarness, badAgent } from "./helpers.ts";
import { Scheduler } from "../src/scheduler.ts";

test("native job sorts the to-do list; a second run is a no-op", async () => {
  const h = demoHarness();
  const run = await h.runJob("sort-todos");
  assert.equal(run.status, "succeeded");
  assert.deepEqual(run.writes, ["tasks/todo.md"]);
  const again = await h.runJob("sort-todos");
  assert.match(again.summary!, /already sorted/);
  assert.deepEqual(again.writes, []);
});

test("skill job: the agent proposes, the harness writes and checks the date", async () => {
  const h = demoHarness();
  const run = await h.runJob("morning-briefing");
  assert.equal(run.status, "succeeded", run.error);
  const briefing = h.vault.read("_agent/briefing.md");
  assert.match(briefing, /# Briefing for 2026-11-20/);
  assert.match(briefing, /Globex follow-up/);
  assert.match(briefing, /#urgent/);
});

test("asks: the run waits, approve performs the action, decline does not", async () => {
  const h = demoHarness();
  const run = await h.runJob("file-inbox");
  assert.equal(run.status, "waiting");
  assert.equal(run.asks.length, 3);
  const asks = h.pendingAsks();
  const globex = asks.find((a) => a.question.includes("globex"))!;
  const idea = asks.find((a) => a.question.includes("packaging"))!;
  const initech = asks.find((a) => a.question.includes("initech"))!;

  await h.resolveAsk(globex.id, "approve");
  assert.ok(h.vault.exists("companies/Globex/notes/globex warehouse visit.md"));
  assert.ok(!h.vault.exists("Inbox/globex warehouse visit.md"));
  assert.equal(h.store.getRun(run.id)!.status, "waiting", "still one pending");

  await h.resolveAsk(idea.id, "decline");
  assert.ok(h.vault.exists("Inbox/packaging idea.md"));
  await assert.rejects(h.resolveAsk(idea.id, "approve"), /already declined/);

  await h.resolveAsk(initech.id, "approve");
  const done = h.store.getRun(run.id)!;
  assert.equal(done.status, "succeeded");
  assert.match(done.summary!, /2 approved, 1 declined/);
  assert.ok(done.writes.includes("companies/Initech/notes/initech invoice question.md"));
});

test("asks survive a restart: a new Harness can resolve them", async () => {
  const h = demoHarness();
  const run = await h.runJob("file-inbox");
  const { Harness } = await import("../src/harness.ts");
  const fresh = new Harness(h.config);
  for (const a of fresh.pendingAsks()) await fresh.resolveAsk(a.id, "approve");
  assert.equal(fresh.store.getRun(run.id)!.status, "succeeded");
  assert.deepEqual(fresh.vault.listNotes("Inbox"), []);
});

test("an approved action that fails marks the ask and the run failed", async () => {
  const h = demoHarness();
  const run = await h.runJob("file-inbox");
  const ask = h.pendingAsks().find((a) => a.question.includes("globex"))!;
  h.vault.write("companies/Globex/notes/globex warehouse visit.md", "already here");
  const res = await h.resolveAsk(ask.id, "approve");
  assert.equal(res.status, "failed");
  assert.match(res.result!, /destination exists/);
  for (const a of h.pendingAsks()) await h.resolveAsk(a.id, "decline");
  assert.equal(h.store.getRun(run.id)!.status, "failed");
});

test("a second run of a running job is skipped, not stacked", async () => {
  const h = demoHarness();
  const [a, b] = await Promise.all([h.runJob("morning-briefing"), h.runJob("morning-briefing")]);
  assert.deepEqual([a.status, b.status].sort(), ["skipped", "succeeded"]);
});

for (const [mode, pattern] of [
  ["no-block", /no ```harness-result/],
  ["escape", /may not write \.\.\/outside\.md/],
  ["outside-allowed", /may not write people\//],
  ["no-date", /does not mention 2026-11-20/],
  ["merge-action", /may not propose a "merge-branch"/],
  ["crash", /exited 4: boom/],
] as const) {
  test(`a misbehaving agent fails the run: ${mode}`, async () => {
    const h = demoHarness();
    badAgent(h, mode);
    const before = h.vault.read("people/Ellery Thistlewood.md");
    const run = await h.runJob("morning-briefing");
    assert.equal(run.status, "failed");
    assert.match(run.error!, pattern);
    assert.equal(h.vault.read("people/Ellery Thistlewood.md"), before);
  });
}

test("a slow agent is killed at its timeout", async () => {
  const h = demoHarness();
  badAgent(h, "slow");
  h.config.jobs.find((j) => j.id === "morning-briefing")!.timeoutSec = 1;
  const run = await h.runJob("morning-briefing");
  assert.equal(run.status, "failed");
  assert.match(run.error!, /timed out after 1s/);
});

test("ask the vault: answer with verified citations", async () => {
  const h = demoHarness();
  const res = await h.askVault("What discount did Globex ask for?");
  assert.equal(res.grounded, true);
  assert.ok(res.citations.some((c) => c.text?.includes("4% discount")));
});

test("ask the vault: says so when the vault has nothing", async () => {
  const h = demoHarness();
  const res = await h.askVault("What is the zebra quota for Hooli?");
  assert.match(res.answer, /found no note/);
  assert.equal(res.grounded, false);
});

test("code task: worktree, commit, merge on approval with post-merge test", async () => {
  const h = demoHarness();
  const repo = h.config.repos["acme-site"].path;
  const run = await h.codeTask("acme-site", "Fix the typo in the README");
  assert.equal(run.status, "waiting", run.error);
  // The user's checkout is untouched until approval.
  assert.match(fs.readFileSync(`${repo}/README.md`, "utf8"), /wordlwide/);
  const ask = h.store.getAsk(run.asks[0])!;
  assert.equal(ask.action.type, "merge-branch");
  assert.match(ask.detail!, /README.md \| 2/);
  const res = await h.resolveAsk(ask.id, "approve");
  assert.equal(res.status, "approved", res.result);
  assert.match(fs.readFileSync(`${repo}/README.md`, "utf8"), /worldwide/);
  const branches = execFileSync("git", ["branch"], { cwd: repo, encoding: "utf8" });
  assert.doesNotMatch(branches, /agent\//, "branch removed after merge");
  assert.equal(h.store.getRun(run.id)!.status, "succeeded");
});

test("code task: decline removes the worktree and branch, main untouched", async () => {
  const h = demoHarness();
  const repo = h.config.repos["acme-site"].path;
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" });
  const run = await h.codeTask("acme-site", "Fix the typo in the README");
  const ask = h.store.getAsk(run.asks[0])!;
  const wt = (ask.action as { worktree: string }).worktree;
  assert.ok(fs.existsSync(wt));
  await h.resolveAsk(ask.id, "decline");
  assert.ok(!fs.existsSync(wt));
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }), head);
  assert.doesNotMatch(execFileSync("git", ["branch"], { cwd: repo, encoding: "utf8" }), /agent\//);
});

test("code task: a merge whose tests fail is undone", async () => {
  const h = demoHarness();
  const repo = h.config.repos["acme-site"].path;
  h.config.repos["acme-site"].test = ["node", "-e", "process.exit(1)"];
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" });
  const run = await h.codeTask("acme-site", "Fix the typo in the README");
  const res = await h.resolveAsk(run.asks[0], "approve");
  assert.equal(res.status, "failed");
  assert.match(res.result!, /tests failed after merge, merge undone/);
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }), head);
});

test("code task: no commits means nothing to ship", async () => {
  const h = demoHarness();
  const run = await h.codeTask("acme-site", "Rewrite everything in Rust");
  assert.equal(run.status, "succeeded");
  assert.match(run.summary!, /nothing to ship/);
  assert.equal(h.pendingAsks().length, 0);
});

test("scheduler: fires each matching job once per sweep and catches up a missed slot", async () => {
  const h = demoHarness();
  let now = new Date(2026, 10, 20, 6, 58);
  h.now = () => now;
  const s = new Scheduler(h, { catchUpDelayMs: 0 });
  now = new Date(2026, 10, 20, 7, 31, 10); // slept through 07:00 and 07:30
  const fired = s.tick();
  assert.deepEqual(fired.sort(), ["morning-briefing", "sort-todos"]);
  assert.deepEqual(s.tick(), [], "same minute again fires nothing");
  assert.deepEqual(s.nextRunAt("weekly-changelog"), new Date(2026, 10, 20, 16, 0));

  const h2 = demoHarness();
  h2.now = () => new Date(2026, 10, 20, 9, 0);
  const s2 = new Scheduler(h2, { catchUpDelayMs: 0 });
  assert.deepEqual(s2.overdue().sort(), ["morning-briefing", "sort-todos", "weekly-changelog"]);
  await s2.catchUp();
  assert.deepEqual(s2.overdue(), []);
  assert.equal(h2.store.runs().filter((r) => r.trigger === "catch-up").length, 3);
});
