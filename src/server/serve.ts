import { serve } from "@hono/node-server";
import type { Harness } from "../harness.ts";
import type { Scheduler } from "../scheduler.ts";
import { createApp } from "./app.ts";

export function startServer(harness: Harness, scheduler: Scheduler | undefined, port: number, host = "127.0.0.1") {
  const app = createApp(harness, scheduler);
  return serve({ fetch: app.fetch, port, hostname: host });
}
