// The dashboard: Hono for a small JSON API, plus one static page of vanilla JS.
// No build step. It binds to 127.0.0.1 by default; set HARNESS_TOKEN to
// require `Authorization: Bearer <token>` on the API if you expose it.

import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import type { Harness } from "../harness.ts";
import type { Scheduler } from "../scheduler.ts";
import { REPO_ROOT } from "../config.ts";

const PUBLIC = path.join(REPO_ROOT, "public");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

export function createApp(harness: Harness, scheduler?: Scheduler, token = process.env.HARNESS_TOKEN): Hono {
  const app = new Hono();

  app.use("/api/*", async (c, next) => {
    if (token && c.req.header("authorization") !== `Bearer ${token}`) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  app.get("/api/health", (c) => c.json({ ok: true, vault: harness.vault.root }));

  app.get("/api/jobs", (c) => {
    const runs = harness.store.runs();
    return c.json(
      harness.jobs.map((j) => {
        const last = runs.find((r) => r.jobId === j.id);
        return {
          ...j,
          running: harness.isRunning(j.id),
          nextRunAt: scheduler?.nextRunAt(j.id)?.toISOString() ?? null,
          lastRun: last ? { id: last.id, status: last.status, startedAt: last.startedAt, summary: last.summary } : null,
        };
      }),
    );
  });

  // Run Now: the same runJob the scheduler calls. It returns at once; the
  // dashboard polls /api/runs for the result.
  app.post("/api/jobs/:id/run", async (c) => {
    const id = c.req.param("id");
    try {
      harness.job(id);
    } catch {
      return c.json({ error: `no job ${id}` }, 404);
    }
    if (id === "ask-vault" || id === "code-task") return c.json({ error: `${id} needs input; use its own endpoint` }, 400);
    if (harness.isRunning(id)) return c.json({ error: "already running" }, 409);
    void harness.runJob(id, "manual");
    return c.json({ started: true }, 202);
  });

  app.get("/api/runs", (c) => {
    const job = c.req.query("job");
    const limit = Number(c.req.query("limit") ?? 50);
    const runs = harness.store.runs().filter((r) => !job || r.jobId === job);
    return c.json(runs.slice(0, limit));
  });

  app.get("/api/runs/:id", (c) => {
    const run = harness.store.getRun(c.req.param("id"));
    return run ? c.json(run) : c.json({ error: "not found" }, 404);
  });

  app.get("/api/asks", (c) => {
    const all = c.req.query("all") === "1";
    return c.json(all ? harness.store.asks().slice(0, 100) : harness.pendingAsks());
  });

  app.post("/api/asks/:id/:decision{approve|decline}", async (c) => {
    try {
      const ask = await harness.resolveAsk(c.req.param("id"), c.req.param("decision") as "approve" | "decline");
      return c.json(ask);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.post("/api/ask-vault", async (c) => {
    const body = await c.req.json<{ question?: string }>().catch(() => ({}) as { question?: string });
    const question = body.question?.trim();
    if (!question) return c.json({ error: "question is required" }, 400);
    try {
      const res = await harness.askVault(question);
      return c.json({ answer: res.answer, citations: res.citations, grounded: res.grounded, runId: res.run.id });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post("/api/code-task", async (c) => {
    const body = await c.req.json<{ repo?: string; task?: string }>().catch(() => ({}) as { repo?: string; task?: string });
    if (!body.repo || !body.task) return c.json({ error: "repo and task are required" }, 400);
    if (!harness.config.repos[body.repo]) return c.json({ error: `no repo ${body.repo}` }, 404);
    void harness.codeTask(body.repo, body.task).catch(() => {});
    return c.json({ started: true }, 202);
  });

  app.get("/api/repos", (c) => c.json(Object.keys(harness.config.repos)));

  app.get("/api/notes", (c) => {
    const p = c.req.query("path");
    if (!p) return c.json({ error: "path is required" }, 400);
    try {
      return c.json({ path: p, text: harness.vault.read(p) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  app.get("/*", (c) => {
    const rel = c.req.path === "/" ? "index.html" : c.req.path.slice(1);
    const file = path.resolve(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file)) return c.text("not found", 404);
    return c.body(fs.readFileSync(file), 200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  });

  return app;
}
