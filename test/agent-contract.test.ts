import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseAgentResult } from "../src/agents/result.ts";
import { checkCitations, extractCitations } from "../src/agents/ask-vault.ts";
import { buildArgv, parseClaudeJson } from "../src/providers/cli.ts";
import { loadSkill, buildPrompt, checkWrites } from "../src/agents/skill.ts";
import { Vault } from "../src/vault/vault.ts";

const ROOT = path.join(import.meta.dirname, "..");

test("parses the last harness-result block", () => {
  const r = parseAgentResult('thinking...\n```harness-result\n{"summary":"one"}\n```\nmore\n```harness-result\n{"summary":"two","writes":[]}\n```');
  assert.equal(r.summary, "two");
});

test("rejects a missing, malformed or unsafe result", () => {
  assert.throws(() => parseAgentResult("no block"), /no ```harness-result/);
  assert.throws(() => parseAgentResult("```harness-result\n{nope}\n```"), /not valid JSON/);
  assert.throws(() => parseAgentResult('```harness-result\n{"summary":""}\n```'), /needs a summary/);
  assert.throws(
    () => parseAgentResult('```harness-result\n{"summary":"x","asks":[{"question":"q","action":{"type":"merge-branch"}}]}\n```'),
    /may not propose/,
  );
});

test("skill writes are limited to the folders its SKILL.md declares", () => {
  const skill = loadSkill(path.join(ROOT, "skills"), "morning-briefing");
  assert.deepEqual(skill.writes, ["_agent/"]);
  checkWrites(skill, { summary: "x", writes: [{ path: "_agent/briefing.md", content: "" }] });
  assert.throws(() => checkWrites(skill, { summary: "x", writes: [{ path: "people/x.md", content: "" }] }), /may not write/);
  assert.throws(() => checkWrites(skill, { summary: "x", writes: [{ path: "_agentx/y.md", content: "" }] }), /may not write/);
});

test("prompt has the invocation block, the SKILL.md body and the contract, in order", () => {
  const skill = loadSkill(path.join(ROOT, "skills"), "weekly-changelog");
  const prompt = buildPrompt({
    skill,
    job: { id: "weekly-changelog", title: "", type: "skill", skill: "weekly-changelog" },
    run: { id: "run_1", jobId: "weekly-changelog", trigger: "manual", status: "running", startedAt: "", writes: [], asks: [] },
    vaultPath: "/vault",
    outputDir: "_agent",
    now: new Date(2026, 10, 20, 16, 0),
    context: [{ title: "commits", text: "abc fix" }],
  });
  const i = prompt.indexOf('"today": "2026-11-20"');
  const j = prompt.indexOf("# Weekly changelog");
  const k = prompt.indexOf("## Context: commits");
  const l = prompt.indexOf("```harness-result");
  assert.ok(i > 0 && i < j && j < k && k < l, "sections out of order");
});

test("citations: verified only when the note and the line are real", () => {
  const v = new Vault(path.join(ROOT, "demo-vault"));
  const pricing = "companies/Globex/meetings/2026-11-18 Globex pricing call.md";
  const res = checkCitations(
    v,
    `4% asked [${pricing}:14]. Made up [companies/Globex/nope.md:3]. Too far [${pricing}:999]. Sneaky [../../etc/passwd.md:1]. Again [${pricing}:14].`,
  );
  assert.equal(res.citations.length, 4, "duplicates collapse");
  assert.deepEqual(
    res.citations.map((c) => c.verified),
    [true, false, false, false],
  );
  assert.match(res.citations[0].text!, /4% discount/);
  assert.equal(res.grounded, false);
  assert.equal(checkCitations(v, `[${pricing}:14]`).grounded, true);
  assert.equal(checkCitations(v, "no citations at all").grounded, false);
  assert.deepEqual(extractCitations("[a b.md:3]"), [{ path: "a b.md", line: 3 }]);
});

test("provider argv: read-only tools, prompt on stdin, vault granted", () => {
  const claude = buildArgv({ provider: "claude", prompt: "p", cwd: "/w", access: "read", addDirs: ["/vault"] });
  assert.equal(claude.command, "claude");
  assert.deepEqual(claude.args.slice(0, 3), ["-p", "--output-format", "json"]);
  assert.equal(claude.args[claude.args.indexOf("--allowedTools") + 1], "Read,Grep,Glob,LS");
  assert.ok(!claude.args.includes("--permission-mode"));
  assert.deepEqual(claude.args.slice(-2), ["--add-dir", "/vault"]);
  assert.ok(!claude.args.includes("p"), "prompt must not be in argv");

  const codex = buildArgv({ provider: "codex", prompt: "p", cwd: "/wt", access: "write" }, {}, "/tmp/last");
  assert.deepEqual(codex.args, ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "-C", "/wt", "--output-last-message", "/tmp/last", "-"]);
});

test("claude JSON output: result text, or an error when is_error", () => {
  assert.equal(parseClaudeJson('{"type":"result","result":"hi","is_error":false}'), "hi");
  assert.throws(() => parseClaudeJson('{"type":"result","result":"bad login","is_error":true}'), /bad login/);
  assert.equal(parseClaudeJson("plain text"), "plain text");
});
