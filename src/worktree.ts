// Code tasks run in a git worktree, never in your checkout.
//
//   1. `git worktree add -b agent/<date>-<slug> <repo>/../.harness-worktrees/<repo>-<slug> <base>`
//   2. The AI CLI runs with write access, cwd = the worktree, and is told to
//      commit on the branch and never merge or push.
//   3. The harness checks the branch (no uncommitted changes, at least one
//      commit) and queues an ask with the diff stat.
//   4. Approve: merge into the base branch, run the repo's test command if one
//      is set, undo the merge if it fails, then remove the worktree and branch.
//      Decline: remove the worktree and branch.
//
// If the worktree cannot be created, the task fails. It never falls back to
// running in the shared checkout.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

export function slugify(text: string, max = 40): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "task";
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export interface Worktree {
  repo: string;
  branch: string;
  path: string;
  base: string;
}

export async function createWorktree(repo: string, task: string, now = new Date()): Promise<Worktree> {
  const base = await git(repo, "rev-parse", "--abbrev-ref", "HEAD");
  const name = `${stamp(now)}-${slugify(task)}`;
  const root = path.join(path.dirname(repo), ".harness-worktrees");
  fs.mkdirSync(root, { recursive: true });
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const branch = `agent/${name}${suffix}`;
    const wtPath = path.join(root, `${path.basename(repo)}-${name}${suffix}`);
    const taken = fs.existsSync(wtPath) || (await branchExists(repo, branch));
    if (taken) continue;
    await git(repo, "worktree", "add", "-b", branch, wtPath, base);
    return { repo, branch, path: wtPath, base };
  }
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

export interface BranchReport {
  commits: number;
  dirty: boolean;
  diffStat: string;
  log: string;
}

export async function inspectBranch(wt: Worktree): Promise<BranchReport> {
  const status = await git(wt.path, "status", "--porcelain");
  const count = Number(await git(wt.path, "rev-list", "--count", `${wt.base}..HEAD`));
  const diffStat = count > 0 ? await git(wt.path, "diff", "--stat", `${wt.base}...HEAD`) : "";
  const log = count > 0 ? await git(wt.path, "log", "--oneline", `${wt.base}..HEAD`) : "";
  return { commits: count, dirty: status !== "", diffStat, log };
}

/**
 * Merge an approved branch into `into`, run the optional test command, and
 * clean up. Returns the new HEAD sha. Throws (leaving `into` untouched) if the
 * merge or the tests fail.
 */
export async function mergeWorktree(
  repo: string,
  branch: string,
  worktree: string,
  into: string,
  testCommand?: string[],
): Promise<string> {
  const current = await git(repo, "rev-parse", "--abbrev-ref", "HEAD");
  if (current !== into) throw new Error(`checkout is on ${current}, expected ${into}; not merging`);
  if ((await git(repo, "status", "--porcelain")) !== "") throw new Error("checkout has uncommitted changes; not merging");
  const before = await git(repo, "rev-parse", "HEAD");
  try {
    await git(repo, "merge", "--no-ff", "-m", `Merge ${branch}`, branch);
  } catch (err) {
    await git(repo, "merge", "--abort").catch(() => {});
    throw new Error(`merge failed: ${(err as Error).message.split("\n")[0]}`);
  }
  if (testCommand && testCommand.length > 0) {
    try {
      await exec(testCommand[0], testCommand.slice(1), { cwd: repo });
    } catch (err) {
      await git(repo, "reset", "--hard", before);
      throw new Error(`tests failed after merge, merge undone: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  await removeWorktree(repo, worktree, branch);
  return git(repo, "rev-parse", "HEAD");
}

export async function removeWorktree(repo: string, worktree: string, branch: string): Promise<void> {
  if (fs.existsSync(worktree)) await git(repo, "worktree", "remove", "--force", worktree);
  await git(repo, "worktree", "prune");
  if (await branchExists(repo, branch)) await git(repo, "branch", "-D", branch);
}
