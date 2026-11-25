// Context builders: plain TypeScript that runs before a skill and puts facts
// into its prompt, so the model spends tokens on judgement, not on listing
// files or reading git logs.

import fs from "node:fs";
import type { Vault } from "../vault/vault.ts";
import { isoDate } from "./skill.ts";
import { git } from "../worktree.ts";
import type { RepoConfig } from "../config.ts";
import { parseTodos } from "../jobs/todos.ts";

export interface ContextInput {
  vault: Vault;
  now: Date;
  repos: Record<string, RepoConfig>;
}

type Builder = (c: ContextInput) => Promise<{ title: string; text: string }>;

const DAY = 86_400_000;

export const CONTEXT_BUILDERS: Record<string, Builder> = {
  /** Notes changed in the last seven days. */
  "changed-notes": async ({ vault, now }) => {
    const since = new Date(now.getTime() - 7 * DAY);
    const notes = vault.changedSince(since).filter((n) => !n.path.startsWith("_agent/"));
    return {
      title: "notes changed in the last 7 days",
      text: notes.map((n) => `- ${n.path} (${isoDate(n.mtime)})`).join("\n"),
    };
  },

  /** Commits in each configured repo over the last seven days. */
  "git-log": async ({ repos, now }) => {
    const since = new Date(now.getTime() - 7 * DAY).toISOString();
    const parts: string[] = [];
    for (const [name, repo] of Object.entries(repos)) {
      if (!fs.existsSync(repo.path)) continue;
      const log = await git(repo.path, "log", "--no-merges", `--since=${since}`, "--pretty=format:%h %ad %s", "--date=short").catch(() => "");
      parts.push(`### ${name}\n${log || "(no commits)"}`);
    }
    return { title: "commits in the last 7 days", text: parts.join("\n\n") };
  },

  /** Open items from the to-do list, already parsed. */
  "open-todos": async ({ vault }) => {
    const file = "tasks/todo.md";
    if (!vault.exists(file)) return { title: "open to-dos", text: "(no tasks/todo.md)" };
    const open = parseTodos(vault.read(file)).filter((t) => !t.done);
    return { title: "open to-dos", text: open.map((t) => t.raw.trim()).join("\n") };
  },

  /** The inbox listing, with each note's first lines. */
  "inbox": async ({ vault }) => {
    const notes = vault.listNotes("Inbox");
    const text = notes
      .map((p) => {
        const head = vault.read(p).split("\n").filter(Boolean).slice(0, 4).join(" / ");
        return `- ${p}: ${head.slice(0, 200)}`;
      })
      .join("\n");
    return { title: "inbox notes", text: text || "(inbox is empty)" };
  },
};

export async function buildContext(names: string[], input: ContextInput) {
  const out: Array<{ title: string; text: string }> = [];
  for (const name of names) {
    const b = CONTEXT_BUILDERS[name];
    if (!b) throw new Error(`unknown context builder "${name}"`);
    out.push(await b(input));
  }
  return out;
}
