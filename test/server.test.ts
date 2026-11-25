import test from "node:test";
import assert from "node:assert/strict";
import { demoHarness } from "./helpers.ts";
import { createApp } from "../src/server/app.ts";
import { Scheduler } from "../src/scheduler.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("dashboard API: jobs, Run Now, runs, asks, approve", async () => {
  const h = demoHarness();
  const app = createApp(h, new Scheduler(h), "");
  const jobs = await (await app.request("/api/jobs")).json();
  assert.ok(jobs.some((j: { id: string; nextRunAt: string }) => j.id === "morning-briefing" && j.nextRunAt));

  assert.equal((await app.request("/api/jobs/file-inbox/run", { method: "POST" })).status, 202);
  assert.equal((await app.request("/api/jobs/nope/run", { method: "POST" })).status, 404);
  assert.equal((await app.request("/api/jobs/ask-vault/run", { method: "POST" })).status, 400);
  for (let i = 0; i < 50 && h.pendingAsks().length === 0; i++) await wait(50);

  const asks = await (await app.request("/api/asks")).json();
  assert.equal(asks.length, 3);
  const res = await app.request(`/api/asks/${asks[0].id}/approve`, { method: "POST" });
  assert.equal((await res.json()).status, "approved");
  assert.equal((await app.request(`/api/asks/${asks[0].id}/approve`, { method: "POST" })).status, 400);
  assert.equal((await app.request(`/api/asks/${asks[1].id}/delete`, { method: "POST" })).status, 404);

  const runs = await (await app.request("/api/runs?job=file-inbox")).json();
  assert.equal(runs[0].status, "waiting");
});

test("dashboard API: ask the vault and the static page", async () => {
  const h = demoHarness();
  const app = createApp(h, undefined, "");
  const res = await app.request("/api/ask-vault", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "What did Initech say about Q1 supply?" }),
  });
  const body = await res.json();
  assert.equal(body.grounded, true, JSON.stringify(body));
  const page = await app.request("/");
  assert.match(await page.text(), /<title>Vault Harness<\/title>/);
  assert.equal((await app.request("/../package.json")).status, 404);
  assert.equal((await app.request("/api/notes?path=../package.json")).status, 404);
});

test("dashboard API: a token, when set, is required", async () => {
  const h = demoHarness();
  const app = createApp(h, undefined, "s3cret");
  assert.equal((await app.request("/api/jobs")).status, 401);
  assert.equal((await app.request("/api/jobs", { headers: { authorization: "Bearer s3cret" } })).status, 200);
});
