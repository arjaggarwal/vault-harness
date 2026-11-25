// "Ask the vault": an agent that greps and cites. No index, no embeddings.
//
// The ask-vault skill runs on the AI CLI with read-only tools and the vault
// granted. It greps for the question's names and terms, opens the matching
// notes, and answers with a citation after each fact: [path/to/note.md:LINE].
//
// The harness does not take those citations on trust. `checkCitations` opens
// every cited note and line. A citation is verified only when the note exists
// and the line is real. Answers with unverified citations are flagged, so
// the dashboard can show them as such.

import fs from "node:fs";
import type { Vault } from "../vault/vault.ts";

export interface Citation {
  path: string;
  line: number;
  verified: boolean;
  /** The cited line, read back from the vault. */
  text?: string;
  reason?: string;
}

export interface VaultAnswer {
  answer: string;
  citations: Citation[];
  /** True when the answer has at least one citation and every one checked out. */
  grounded: boolean;
}

const CITE = /\[([^\[\]\n]+?\.md):(\d+)\]/g;

export function extractCitations(text: string): Array<{ path: string; line: number }> {
  const seen = new Set<string>();
  const out: Array<{ path: string; line: number }> = [];
  for (const m of text.matchAll(CITE)) {
    const key = `${m[1]}:${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: m[1].trim(), line: Number(m[2]) });
  }
  return out;
}

export function checkCitations(vault: Vault, answer: string): VaultAnswer {
  const citations: Citation[] = extractCitations(answer).map(({ path, line }) => {
    let abs: string;
    try {
      abs = vault.resolve(path);
    } catch (err) {
      return { path, line, verified: false, reason: (err as Error).message };
    }
    if (!fs.existsSync(abs)) return { path, line, verified: false, reason: "no such note" };
    const lines = fs.readFileSync(abs, "utf8").split("\n");
    if (line < 1 || line > lines.length) return { path, line, verified: false, reason: `note has ${lines.length} lines` };
    const text = lines[line - 1].trim();
    if (text === "") return { path, line, verified: false, reason: "cited line is blank" };
    return { path, line, verified: true, text };
  });
  return {
    answer: answer.trim(),
    citations,
    grounded: citations.length > 0 && citations.every((c) => c.verified),
  };
}
