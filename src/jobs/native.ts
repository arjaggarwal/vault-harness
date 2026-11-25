// Native job handlers: TypeScript that runs in-process with no AI CLI.
// A handler gets the vault and returns what it did; it may also queue asks.

import type { Vault } from "../vault/vault.ts";
import type { AskAction } from "../types.ts";
import { sortTodoFile } from "./todos.ts";

export interface NativeContext {
  vault: Vault;
  now: Date;
  args: Record<string, string>;
  outputDir: string;
}

export interface NativeResult {
  summary: string;
  writes?: string[];
  asks?: Array<{ question: string; detail?: string; action: AskAction; onDecline?: AskAction }>;
}

export type NativeHandler = (ctx: NativeContext) => Promise<NativeResult>;

export const NATIVE_HANDLERS: Record<string, NativeHandler> = {
  "sort-todos": async ({ vault }) => {
    const file = "tasks/todo.md";
    if (!vault.exists(file)) return { summary: "no tasks/todo.md; nothing to sort" };
    const res = sortTodoFile(vault.read(file));
    // Rewrite only when something changed, so a synced vault doesn't churn.
    if (!res.changed) return { summary: `to-do list already sorted (${res.open} open)` };
    vault.write(file, res.text);
    return {
      summary: `sorted ${res.open} open items; moved ${res.movedToDone} finished item(s) to Done`,
      writes: [file],
    };
  },
};
