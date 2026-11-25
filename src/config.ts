// harness.config.json: where the vault is, where state goes, which AI CLI to
// use. Relative paths resolve against the config file's folder. Environment
// variables win, so the demo and tests can point a stock config elsewhere.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JobDef, ProviderName } from "./types.ts";
import type { ProviderOverrides } from "./providers/cli.ts";

export interface HarnessConfig {
  /** Absolute path of the Obsidian vault. */
  vault: string;
  /** Runs, asks and logs. Not inside the vault. */
  stateDir: string;
  /** SKILL.md folders. */
  skillsDir: string;
  /** Where the agent's visible outputs go, vault-relative. */
  outputDir: string;
  port: number;
  defaultProvider: ProviderName;
  providers: ProviderOverrides;
  /** Git repositories the changelog job reports on and code tasks may run in. */
  repos: Record<string, RepoConfig>;
  jobs: JobDef[];
}

export interface RepoConfig {
  path: string;
  /** Command run after an approved merge, e.g. ["npm", "test"]. A failure undoes the merge. */
  test?: string[];
}

interface RawConfig extends Partial<Omit<HarnessConfig, "jobs" | "repos">> {
  jobsFile?: string;
  repos?: Record<string, string | RepoConfig>;
}

export const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

export function loadConfig(file?: string): HarnessConfig {
  const configPath = path.resolve(file ?? process.env.HARNESS_CONFIG ?? path.join(REPO_ROOT, "harness.config.json"));
  const base = path.dirname(configPath);
  const raw: RawConfig = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
  const abs = (p: string) => (p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : path.resolve(base, p));

  const jobsFile = abs(raw.jobsFile ?? "jobs.json");
  const jobs: JobDef[] = fs.existsSync(jobsFile) ? JSON.parse(fs.readFileSync(jobsFile, "utf8")) : [];

  const repos: Record<string, RepoConfig> = {};
  for (const [name, r] of Object.entries(raw.repos ?? {})) {
    repos[name] = typeof r === "string" ? { path: abs(r) } : { ...r, path: abs(r.path) };
  }

  const provider = (process.env.HARNESS_PROVIDER as ProviderName | undefined) ?? raw.defaultProvider ?? "claude";

  return {
    vault: path.resolve(process.env.HARNESS_VAULT ?? abs(raw.vault ?? "demo-vault")),
    stateDir: path.resolve(process.env.HARNESS_STATE ?? abs(raw.stateDir ?? ".harness")),
    skillsDir: abs(raw.skillsDir ?? "skills"),
    outputDir: raw.outputDir ?? "_agent",
    port: Number(process.env.HARNESS_PORT ?? raw.port ?? 7788),
    defaultProvider: provider,
    providers: raw.providers ?? {},
    repos,
    jobs: validateJobs(jobs),
  };
}

export function validateJobs(jobs: JobDef[]): JobDef[] {
  const seen = new Set<string>();
  for (const j of jobs) {
    if (!/^[a-z0-9-]+$/.test(j.id)) throw new Error(`job id "${j.id}" must be lowercase letters, digits and dashes`);
    if (seen.has(j.id)) throw new Error(`duplicate job id "${j.id}"`);
    seen.add(j.id);
    if (j.type === "native" && !j.handler) throw new Error(`native job "${j.id}" needs a handler`);
    if (j.type === "skill" && !j.skill) throw new Error(`skill job "${j.id}" needs a skill`);
  }
  return jobs;
}
