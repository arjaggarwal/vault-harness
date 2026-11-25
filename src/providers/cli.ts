// Provider adapter: one function that runs a local AI CLI headless and returns
// its final text. The harness never calls a model API directly; it uses the
// CLI you are already signed in to, so auth, model choice and tool sandboxing
// stay with the CLI. The adapter's job is only to normalize argv, stdin, the
// working directory, timeouts and output parsing across providers.
//
// The prompt always goes in on stdin, never argv: prompts carry note excerpts
// and can be long.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderName } from "../types.ts";

export interface AgentCall {
  provider: ProviderName;
  prompt: string;
  /**
   * Working directory. For read-only vault work this is an empty scratch folder
   * (so no stray CLAUDE.md or AGENTS.md is picked up) and the vault comes in
   * through `addDirs`. For code tasks it is the worktree.
   */
  cwd: string;
  /** Extra folders the CLI may read (Claude: --add-dir). */
  addDirs?: string[];
  /** `read`: search/read tools only. `write`: may edit files under cwd. */
  access: "read" | "write";
  timeoutSec?: number;
  env?: Record<string, string>;
}

export interface AgentReply {
  text: string;
  exitCode: number;
  durationMs: number;
  stderr: string;
}

export interface ProviderCommand {
  command: string;
  args?: string[];
}

/** Overridable per provider in harness.config.json (`providers.claude.command`, …). */
export type ProviderOverrides = Partial<Record<ProviderName, ProviderCommand>>;

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");

const CLAUDE_TOOLS = {
  read: "Read,Grep,Glob,LS",
  write: "Read,Grep,Glob,LS,Edit,Write,MultiEdit",
};

export function buildArgv(
  call: AgentCall,
  overrides: ProviderOverrides = {},
  lastMessageFile?: string,
): { command: string; args: string[] } {
  const o = overrides[call.provider];
  switch (call.provider) {
    case "claude":
      return {
        command: o?.command ?? "claude",
        args: [
          ...(o?.args ?? []),
          "-p",
          "--output-format",
          "json",
          "--allowedTools",
          CLAUDE_TOOLS[call.access],
          ...(call.access === "write" ? ["--permission-mode", "acceptEdits"] : []),
          ...(call.addDirs ?? []).flatMap((d) => ["--add-dir", d]),
        ],
      };
    case "codex":
      // Codex's read-only sandbox can read any path; workspace-write limits
      // writes to -C. So `addDirs` needs no flag here.
      return {
        command: o?.command ?? "codex",
        args: [
          ...(o?.args ?? []),
          "exec",
          "--skip-git-repo-check",
          "--sandbox",
          call.access === "write" ? "workspace-write" : "read-only",
          "-C",
          call.cwd,
          ...(lastMessageFile ? ["--output-last-message", lastMessageFile] : []),
          "-",
        ],
      };
    case "mock":
      return {
        command: o?.command ?? process.execPath,
        args: [...(o?.args ?? [path.join(REPO_ROOT, "bin", "mock-agent.mjs")]), "--access", call.access],
      };
  }
}

/** Claude's `--output-format json` prints one object with a `result` field. */
export function parseClaudeJson(stdout: string): string {
  const trimmed = stdout.trim();
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj.result === "string") {
      if (obj.is_error) throw new Error(`agent reported an error: ${obj.result}`);
      return obj.result;
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("agent reported")) throw err;
  }
  return trimmed;
}

export function runAgent(call: AgentCall, overrides: ProviderOverrides = {}): Promise<AgentReply> {
  const lastMessageFile =
    call.provider === "codex" ? path.join(fs.mkdtempSync(path.join(os.tmpdir(), "harness-codex-")), "last.txt") : undefined;
  const { command, args } = buildArgv(call, overrides, lastMessageFile);
  const started = Date.now();
  const timeoutMs = (call.timeoutSec ?? 600) * 1000;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: call.cwd,
      env: { ...process.env, ...call.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`could not start ${command}: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      if (timedOut) return reject(new Error(`${call.provider} timed out after ${call.timeoutSec ?? 600}s`));
      if (code !== 0) {
        return reject(new Error(`${call.provider} exited ${code}: ${(stderr || stdout).trim().slice(-600)}`));
      }
      try {
        let text: string;
        if (call.provider === "codex" && lastMessageFile && fs.existsSync(lastMessageFile)) {
          text = fs.readFileSync(lastMessageFile, "utf8").trim();
          fs.rmSync(path.dirname(lastMessageFile), { recursive: true, force: true });
        } else if (call.provider === "codex") {
          text = stdout.trim();
        } else {
          text = parseClaudeJson(stdout); // claude and the mock share this shape
        }
        resolve({ text, exitCode: code ?? 0, durationMs, stderr });
      } catch (err) {
        reject(err);
      }
    });
    child.stdin.end(call.prompt);
  });
}
