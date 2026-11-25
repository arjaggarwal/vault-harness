import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDemoWorkspace, DEMO_NOW } from "../src/demo-setup.ts";
import { Harness } from "../src/harness.ts";

export function tmpdir(prefix = "harness-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function demoHarness(): Harness {
  const { config } = createDemoWorkspace(tmpdir());
  const h = new Harness(config);
  h.now = () => DEMO_NOW;
  return h;
}

export function badAgent(h: Harness, mode: string): void {
  h.config.providers = {
    mock: { command: process.execPath, args: [path.join(import.meta.dirname, "fixtures", "bad-agent.mjs")] },
  };
  process.env.BAD_AGENT_MODE = mode;
}
