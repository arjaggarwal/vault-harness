// Grep over the vault. No index and no embeddings: plain files, searched when
// asked. Results carry line numbers so an answer can cite exactly where a fact
// came from, and they are ranked by how many distinct query terms a note hits
// (then by how often), with a bonus when a term is in the file name.

import fs from "node:fs";
import type { Vault } from "./vault.ts";

export interface GrepHit {
  path: string;
  line: number;
  text: string;
}

export interface NoteMatch {
  path: string;
  score: number;
  termsHit: string[];
  hits: GrepHit[];
}

const STOP = new Set(
  "a an and are as at be by did do does for from had has have how i in is it its last me my of on or our said say says the this to was we were what when where which who why will with you about any".split(
    " ",
  ),
);

/** Turn a question into search terms: lowercase words of 3+ letters, minus stop words. Quoted phrases stay whole. */
export function queryTerms(question: string): string[] {
  const terms: string[] = [];
  const phraseRe = /"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = phraseRe.exec(question))) terms.push(m[1].toLowerCase());
  const rest = question.replace(phraseRe, " ");
  for (const w of rest.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []) {
    const word = w.replace(/'s$/, "");
    if (word.length >= 3 && !STOP.has(word) && !terms.includes(word)) terms.push(word);
  }
  return terms;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Lines matching a regular expression, like `grep -n`. */
export function grep(vault: Vault, pattern: RegExp, opts: { dir?: string; limit?: number } = {}): GrepHit[] {
  const limit = opts.limit ?? 200;
  const hits: GrepHit[] = [];
  for (const rel of vault.listNotes(opts.dir ?? "")) {
    const lines = fs.readFileSync(vault.resolve(rel), "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      pattern.lastIndex = 0;
      if (pattern.test(lines[i])) {
        hits.push({ path: rel, line: i + 1, text: lines[i].trim() });
        if (hits.length >= limit) return hits;
      }
    }
  }
  return hits;
}

/** Rank notes for a set of terms. */
export function searchNotes(vault: Vault, terms: string[], opts: { dir?: string; maxNotes?: number } = {}): NoteMatch[] {
  if (terms.length === 0) return [];
  const res = terms.map((t) => new RegExp(`\\b${escapeRe(t)}`, "i"));
  const out: NoteMatch[] = [];
  for (const rel of vault.listNotes(opts.dir ?? "")) {
    const lines = fs.readFileSync(vault.resolve(rel), "utf8").split("\n");
    const termsHit = new Set<string>();
    const hits: GrepHit[] = [];
    lines.forEach((text, i) => {
      let lineHit = false;
      res.forEach((re, k) => {
        if (re.test(text)) {
          termsHit.add(terms[k]);
          lineHit = true;
        }
      });
      if (lineHit) hits.push({ path: rel, line: i + 1, text: text.trim() });
    });
    const nameBonus = terms.filter((t) => rel.toLowerCase().includes(t)).length;
    for (const t of terms) if (rel.toLowerCase().includes(t)) termsHit.add(t);
    if (termsHit.size === 0) continue;
    out.push({
      path: rel,
      score: termsHit.size * 10 + nameBonus * 3 + Math.min(hits.length, 10),
      termsHit: [...termsHit],
      hits,
    });
  }
  out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return out.slice(0, opts.maxNotes ?? 8);
}
