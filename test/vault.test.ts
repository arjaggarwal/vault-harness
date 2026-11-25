import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Vault, parseFrontmatter, serializeNote } from "../src/vault/vault.ts";
import { grep, queryTerms, searchNotes } from "../src/vault/search.ts";
import { tmpdir } from "./helpers.ts";

function vault(): Vault {
  const root = tmpdir();
  fs.cpSync(path.join(import.meta.dirname, "..", "demo-vault"), root, { recursive: true });
  return new Vault(root);
}

test("path guard refuses escapes, absolute paths and protected folders", () => {
  const v = vault();
  assert.throws(() => v.resolve("../x.md"), /escapes/);
  assert.throws(() => v.resolve("companies/../../x.md"), /escapes/);
  assert.throws(() => v.resolve("/etc/hosts"), /absolute/);
  assert.throws(() => v.resolve(".obsidian/app.json"), /protected/);
  assert.throws(() => v.resolve(""), /empty/);
  assert.ok(v.resolve("companies/Globex/Globex.md").endsWith("Globex.md"));
});

test("path guard refuses a symlink that leads out of the vault", () => {
  const v = vault();
  const outside = tmpdir();
  fs.symlinkSync(outside, path.join(v.root, "escape"));
  assert.throws(() => v.write("escape/x.md", "hi"), /outside the vault/);
  assert.equal(fs.existsSync(path.join(outside, "x.md")), false);
});

test("frontmatter round trip", () => {
  const text = `---\ntype: meeting\nattendees: ["[[A B]]", "[[C D]]"]\ntags:\n  - one\n  - two\n---\n# Body\n`;
  const { frontmatter, body } = parseFrontmatter(text);
  assert.equal(frontmatter.type, "meeting");
  assert.deepEqual(frontmatter.attendees, ["[[A B]]", "[[C D]]"]);
  assert.deepEqual(frontmatter.tags, ["one", "two"]);
  assert.equal(body, "# Body\n");
  const again = parseFrontmatter(serializeNote(frontmatter, body));
  assert.deepEqual(again.frontmatter, frontmatter);
});

test("writeSection replaces only the harness's own block", () => {
  const v = vault();
  v.write("n.md", "# Note\n\nmine\n");
  v.writeSection("n.md", "job", "first");
  v.append("n.md", "added by a person");
  v.writeSection("n.md", "job", "second");
  const text = v.read("n.md");
  assert.match(text, /mine/);
  assert.match(text, /added by a person/);
  assert.match(text, /second/);
  assert.doesNotMatch(text, /first/);
});

test("move refuses to overwrite", () => {
  const v = vault();
  v.write("a.md", "a");
  v.write("b.md", "b");
  assert.throws(() => v.move("a.md", "b.md"), /exists/);
  v.move("a.md", "sub/a.md");
  assert.equal(v.read("sub/a.md"), "a");
});

test("query terms drop stop words and keep quoted phrases", () => {
  assert.deepEqual(queryTerms('What did Globex say about the "pallet spec"?'), ["pallet spec", "globex"]);
});

test("grep returns line numbers; search ranks the right note first", () => {
  const v = vault();
  const hits = grep(v, /4% discount/);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, "companies/Globex/meetings/2026-11-18 Globex pricing call.md");
  assert.equal(hits[0].line, 14);
  const ranked = searchNotes(v, queryTerms("Globex discount tiers"));
  assert.equal(ranked[0].path, "companies/Globex/meetings/2026-11-18 Globex pricing call.md");
});
