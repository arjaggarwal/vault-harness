// Vault read/write helpers. Every path the agent hands us is vault-relative and
// goes through `resolve()`, which refuses anything that escapes the vault or
// touches the Obsidian/app folders. Writes are atomic, and "section" writes
// only replace the text between the harness's own markers, so anything a
// person adds to the same note survives the next run.

import fs from "node:fs";
import path from "node:path";

export type Frontmatter = Record<string, string | string[]>;

export interface Note {
  path: string;
  frontmatter: Frontmatter;
  body: string;
}

const BLOCKED_DIRS = [".obsidian", ".git", ".trash"];

export class VaultError extends Error {}

export class Vault {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Vault-relative path → absolute path, or throw. */
  resolve(rel: string): string {
    if (typeof rel !== "string" || rel.trim() === "") throw new VaultError("empty path");
    if (path.isAbsolute(rel)) throw new VaultError(`absolute paths are not allowed: ${rel}`);
    const abs = path.resolve(this.root, rel);
    const inside = abs === this.root || abs.startsWith(this.root + path.sep);
    if (!inside) throw new VaultError(`path escapes the vault: ${rel}`);
    const first = path.relative(this.root, abs).split(path.sep)[0];
    if (BLOCKED_DIRS.includes(first)) throw new VaultError(`path is in a protected folder: ${rel}`);
    // A symlink inside the vault must not lead outside it either.
    let probe = abs;
    while (!fs.existsSync(probe)) probe = path.dirname(probe);
    const real = fs.realpathSync(probe);
    const realRoot = fs.realpathSync(this.root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new VaultError(`path leads outside the vault through a link: ${rel}`);
    }
    return abs;
  }

  relative(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join("/");
  }

  exists(rel: string): boolean {
    return fs.existsSync(this.resolve(rel));
  }

  read(rel: string): string {
    return fs.readFileSync(this.resolve(rel), "utf8");
  }

  readNote(rel: string): Note {
    const { frontmatter, body } = parseFrontmatter(this.read(rel));
    return { path: rel, frontmatter, body };
  }

  write(rel: string, content: string): void {
    const abs = this.resolve(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.harness-tmp`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, abs);
  }

  writeNote(note: Note): void {
    this.write(note.path, serializeNote(note.frontmatter, note.body));
  }

  append(rel: string, text: string): void {
    const current = this.exists(rel) ? this.read(rel) : "";
    const sep = current === "" || current.endsWith("\n") ? "" : "\n";
    this.write(rel, current + sep + text + (text.endsWith("\n") ? "" : "\n"));
  }

  /**
   * Replace the harness-owned section of a note, between
   * `%% harness:<key>:start %%` and `%% harness:<key>:end %%`.
   * The section is appended if the note has none yet.
   */
  writeSection(rel: string, key: string, content: string): void {
    const start = `%% harness:${key}:start %%`;
    const end = `%% harness:${key}:end %%`;
    const block = `${start}\n${content.trimEnd()}\n${end}`;
    const current = this.exists(rel) ? this.read(rel) : "";
    const i = current.indexOf(start);
    const j = current.indexOf(end);
    let next: string;
    if (i >= 0 && j > i) {
      next = current.slice(0, i) + block + current.slice(j + end.length);
    } else {
      const sep = current === "" ? "" : current.endsWith("\n") ? "\n" : "\n\n";
      next = current + sep + block + "\n";
    }
    this.write(rel, next);
  }

  move(fromRel: string, toRel: string): void {
    const from = this.resolve(fromRel);
    const to = this.resolve(toRel);
    if (!fs.existsSync(from)) throw new VaultError(`no such note: ${fromRel}`);
    if (fs.existsSync(to)) throw new VaultError(`destination exists: ${toRel}`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
  }

  /** All Markdown files, vault-relative, sorted. */
  listNotes(dir = ""): string[] {
    const start = dir === "" ? this.root : this.resolve(dir);
    const out: string[] = [];
    const walk = (abs: string) => {
      if (!fs.existsSync(abs)) return;
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const child = path.join(abs, entry.name);
        if (entry.isDirectory()) walk(child);
        else if (entry.name.endsWith(".md")) out.push(this.relative(child));
      }
    };
    walk(start);
    return out.sort();
  }

  /** Notes changed since a time, newest first. */
  changedSince(since: Date): Array<{ path: string; mtime: Date }> {
    return this.listNotes()
      .map((p) => ({ path: p, mtime: fs.statSync(this.resolve(p)).mtime }))
      .filter((n) => n.mtime >= since)
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  }
}

// ---- frontmatter -----------------------------------------------------------
// A deliberately small YAML subset: `key: value`, `key: [a, b]` and
// block lists (`key:` followed by `  - item`). Enough for note metadata.

export function parseFrontmatter(text: string): { frontmatter: Frontmatter; body: string } {
  if (!text.startsWith("---\n")) return { frontmatter: {}, body: text };
  const end = text.indexOf("\n---", 4);
  if (end < 0) return { frontmatter: {}, body: text };
  const yaml = text.slice(4, end);
  const rest = text.slice(end + 4).replace(/^\r?\n/, "");
  const fm: Frontmatter = {};
  let listKey: string | null = null;
  for (const line of yaml.split("\n")) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) {
      (fm[listKey] as string[]).push(unquote(item[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, raw] = kv;
    if (raw === "") {
      fm[key] = [];
      listKey = key;
    } else if (raw.startsWith("[") && raw.endsWith("]")) {
      fm[key] = raw
        .slice(1, -1)
        .split(",")
        .map((s) => unquote(s.trim()))
        .filter(Boolean);
      listKey = null;
    } else {
      fm[key] = unquote(raw);
      listKey = null;
    }
  }
  return { frontmatter: fm, body: rest };
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function quoteIfNeeded(s: string): string {
  return /[:#\[\]{},]|^\s|\s$/.test(s) ? JSON.stringify(s) : s;
}

export function serializeNote(fm: Frontmatter, body: string): string {
  const keys = Object.keys(fm);
  if (keys.length === 0) return body;
  const lines = keys.map((k) => {
    const v = fm[k];
    if (Array.isArray(v)) return v.length === 0 ? `${k}: []` : `${k}:\n${v.map((x) => `  - ${quoteIfNeeded(x)}`).join("\n")}`;
    return `${k}: ${quoteIfNeeded(v)}`;
  });
  return `---\n${lines.join("\n")}\n---\n${body}`;
}
