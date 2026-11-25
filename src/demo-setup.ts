// Builds a throwaway workspace for the demo and the tests: a copy of the demo
// vault, a tiny git repo for the code task and the changelog, and a config
// that points the harness at both with the mock CLI.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { REPO_ROOT, validateJobs } from "./config.ts";
import type { HarnessConfig } from "./config.ts";
import type { JobDef } from "./types.ts";

/** The demo's "today": Friday 2026-11-20, 07:30 local time. */
export const DEMO_NOW = new Date(2026, 10, 20, 7, 30);

const SITE_FILES: Record<string, string> = {
  "README.md": `# Acme Widgets website

The public site for Acme Widgets. Acme ships the Model 7 widget wordlwide.

Run \`node check.mjs\` before you commit.
`,
  "index.html": `<!doctype html>
<title>Acme Widgets</title>
<h1>Acme Widgets</h1>
<p>Model 7: the widget that fits.</p>
`,
  "check.mjs": `// A stand-in test suite: fails on known typos.
import fs from "node:fs";
const typos = ["wordlwide", "teh "];
const bad = ["README.md", "index.html"].flatMap((f) =>
  typos.filter((t) => fs.readFileSync(f, "utf8").includes(t)).map((t) => f + ": " + t),
);
if (bad.length) {
  console.error("typos found:\\n" + bad.join("\\n"));
  process.exit(1);
}
console.log("checks passed");
`,
};

function git(cwd: string, args: string[], date?: string): void {
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  if (!date) {
    delete env.GIT_AUTHOR_DATE;
    delete env.GIT_COMMITTER_DATE;
  }
  execFileSync("git", args, { cwd, env, stdio: "pipe" });
}

/** A small repo with a week of history before DEMO_NOW. */
export function createDemoRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "Demo Bot"]);
  git(dir, ["config", "user.email", "demo@example.com"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  const commits: Array<[string, string, Record<string, string>]> = [
    ["2026-11-16T10:00:00", "Add the site skeleton", { "index.html": SITE_FILES["index.html"].replace("<p>Model 7: the widget that fits.</p>\n", "") }],
    ["2026-11-17T14:20:00", "Add README and the typo check", { "README.md": SITE_FILES["README.md"], "check.mjs": SITE_FILES["check.mjs"] }],
    ["2026-11-19T09:05:00", "Add the Model 7 line to the home page", { "index.html": SITE_FILES["index.html"] }],
  ];
  for (const [date, msg, files] of commits) {
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", msg], date);
  }
  return dir;
}

export interface DemoWorkspace {
  root: string;
  config: HarnessConfig;
}

export function createDemoWorkspace(root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-harness-demo-"))): DemoWorkspace {
  const vault = path.join(root, "vault");
  fs.cpSync(path.join(REPO_ROOT, "demo-vault"), vault, { recursive: true });
  const site = createDemoRepo(path.join(root, "acme-site"));
  const jobs: JobDef[] = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "jobs.json"), "utf8"));
  const config: HarnessConfig = {
    vault,
    stateDir: path.join(root, "state"),
    skillsDir: path.join(REPO_ROOT, "skills"),
    outputDir: "_agent",
    port: Number(process.env.HARNESS_PORT ?? 7788),
    defaultProvider: "mock",
    providers: {},
    repos: { "acme-site": { path: site, test: ["node", "check.mjs"] } },
    jobs: validateJobs(jobs),
  };
  return { root, config };
}
