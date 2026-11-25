#!/usr/bin/env node
// A stand-in for `claude -p --output-format json`, so the demo and the tests run
// without an AI login. It reads the same prompt on stdin, does the skill's work
// with plain string matching (grep, not judgement), and prints the same JSON
// shape: { "type": "result", "result": "<text>", "is_error": false }.
//
// It is deliberately dumb: it shows the contract between the harness and an
// agent, not what a model would write. It prints a trace of the "tool calls" it
// made, so the demo output reads like a real run.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const prompt = fs.readFileSync(0, "utf8");
const access = process.argv.includes("--access") ? process.argv[process.argv.indexOf("--access") + 1] : "read";
const inv = JSON.parse(prompt.match(/## Invocation\n```json\n([\s\S]*?)\n```/)[1]);
const vault = inv.vault;
const today = inv.today;
const trace = [];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, out);
    else if (e.name.endsWith(".md")) out.push(abs);
  }
  return out;
}
const rel = (abs) => path.relative(vault, abs).split(path.sep).join("/");
const read = (p) => {
  trace.push(`✱ Read → ${p}`);
  return fs.readFileSync(path.join(vault, p), "utf8");
};
function grep(term, dir = "") {
  trace.push(`✱ Grep "${term}"${dir ? ` in ${dir}` : ""}`);
  const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const hits = [];
  for (const abs of walk(path.join(vault, dir))) {
    const p = rel(abs);
    if (p.startsWith("_agent/")) continue;
    fs.readFileSync(abs, "utf8")
      .split("\n")
      .forEach((text, i) => {
        if (re.test(text) || re.test(path.basename(p))) hits.push({ path: p, line: i + 1, text: text.trim() });
      });
  }
  return hits;
}
function contextSection(title) {
  const m = prompt.match(new RegExp(`## Context: ${title}\\n\\n([\\s\\S]*?)(?=\\n## |$)`));
  return m ? m[1].trim() : "";
}
function finish(text) {
  process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: [...trace, "", text].join("\n") }) + "\n");
}
function result(obj) {
  return "```harness-result\n" + JSON.stringify(obj, null, 2) + "\n```";
}
const companies = () => fs.readdirSync(path.join(vault, "companies")).filter((d) => !d.startsWith("."));

// ---------------------------------------------------------------------------

const skills = {
  "morning-briefing"() {
    const daily = `daily/${today}.md`;
    const meetings = fs.existsSync(path.join(vault, daily))
      ? read(daily)
          .split("## Meetings")[1]
          ?.split("\n## ")[0]
          .split("\n")
          .filter((l) => l.startsWith("- ")) ?? []
      : [];
    const lines = [];
    for (const m of meetings) {
      const company = companies().find((c) => m.toLowerCase().includes(c.toLowerCase()));
      if (!company) {
        lines.push(`${m} (no prep notes in the vault)`);
        continue;
      }
      const notes = grep(company, `companies/${company}/meetings`)
        .map((h) => h.path)
        .filter((p, i, a) => a.indexOf(p) === i)
        .sort();
      const latest = notes.at(-1);
      const open = latest
        ? read(latest)
            .split("\n")
            .filter((l) => l.startsWith("- [ ]"))
            .map((l) => l.slice(6))
        : [];
      const link = latest ? ` ([[${path.basename(latest, ".md")}]])` : "";
      lines.push(`${m}: open from last time: ${open[0] ?? "nothing recorded"}${link}`);
    }
    const todos = contextSection("open to-dos").split("\n").filter(Boolean);
    const rank = (t) => (/#urgent/.test(t) ? 0 : /#high/.test(t) ? 1 : /#low/.test(t) ? 3 : 2);
    const top = [...todos].sort((a, b) => rank(a) - rank(b)).slice(0, 3);
    const due = todos.filter((t) => (t.match(/📅 (\d{4}-\d{2}-\d{2})/)?.[1] ?? "9999") <= today);
    const content = [
      `# Briefing for ${today}`,
      "",
      "## Today",
      ...(lines.length ? lines : ["- No meetings in today's daily note."]),
      "",
      "## Top three",
      ...top,
      "",
      "## Heads-up",
      ...(due.length ? due.map((t) => `${t} (due)`) : ["- Nothing due or overdue."]),
      "",
    ].join("\n");
    return finish(
      `Briefing written: ${meetings.length} meeting(s), top three to-dos.\n\n` +
        result({
          summary: `Briefing for ${today}: ${meetings.length} meeting(s) and the top three to-dos.`,
          writes: [{ path: "_agent/briefing.md", content, mode: "replace" }],
        }),
    );
  },

  "file-inbox"() {
    const listed = contextSection("inbox notes")
      .split("\n")
      .map((l) => l.match(/^- (Inbox\/[^:]+\.md):/)?.[1])
      .filter(Boolean);
    const asks = [];
    const log = [];
    for (const from of listed) {
      const text = read(from);
      const name = path.basename(from);
      const company = companies().find((c) => new RegExp(`\\b${c}\\b`, "i").test(text + " " + name));
      if (company) grep(company);
      const to = company ? `companies/${company}/notes/${name}` : /idea/i.test(text + name) ? `ideas/${name}` : null;
      if (!to) {
        log.push(`- ${today} left ${from}: no clear home`);
        continue;
      }
      if (fs.existsSync(path.join(vault, to))) {
        log.push(`- ${today} left ${from}: ${to} already exists`);
        continue;
      }
      asks.push({
        question: `Move "${from}" to ${path.dirname(to)}/?`,
        detail: company ? `Mentions ${company}: "${text.split("\n")[0].slice(0, 120)}"` : "Reads as an idea, not about one company.",
        action: { type: "move-note", from, to },
      });
      log.push(`- ${today} proposed ${from} → ${to}`);
    }
    return finish(
      `Proposed ${asks.length} move(s).\n\n` +
        result({
          summary: `Proposed homes for ${asks.length} of ${listed.length} inbox note(s).`,
          writes: [{ path: "_agent/inbox-log.md", content: log.join("\n"), mode: "append" }],
          asks,
        }),
    );
  },

  "weekly-changelog"() {
    const commits = contextSection("commits in the last 7 days");
    const changed = contextSection("notes changed in the last 7 days")
      .split("\n")
      .map((l) => l.match(/^- (.+\.md) \(/)?.[1])
      .filter((p) => p && /meetings\//.test(p))
      .sort();
    const shipped = commits
      .split(/\n(?=### )/)
      .filter(Boolean)
      .flatMap((block) => {
        const [head, ...rows] = block.split("\n");
        return [head, ...rows.filter(Boolean).map((r) => `- ${r.replace(/^\w+ \d{4}-\d{2}-\d{2} /, "")}`)];
      });
    const vaultLines = changed.map((p) => {
      const decision = read(p)
        .split("\n")
        .find((l) => /decision|will|confirmed/i.test(l) && l.startsWith("- "));
      return `- [[${path.basename(p, ".md")}]]${decision ? `: ${decision.slice(2)}` : ""}`;
    });
    const content = [
      `# Week ending ${today}`,
      "",
      "## Shipped",
      ...(shipped.length ? shipped : ["- No commits this week."]),
      "",
      "## In the vault",
      ...(vaultLines.length ? vaultLines : ["- No meeting notes changed."]),
      "",
    ].join("\n");
    return finish(
      result({
        summary: `Changelog for the week ending ${today}: ${changed.length} meeting note(s).`,
        writes: [
          { path: `_agent/changelog/${today}.md`, content, mode: "replace" },
          { path: "_agent/changelog/latest.md", content, mode: "replace" },
        ],
      }),
    );
  },

  "ask-vault"() {
    const q = inv.arguments.question ?? "";
    const stop = new Set("what did does the and for with about from that this have has was were say said when where who how which our their they".split(" "));
    const terms = (q.toLowerCase().match(/[a-z0-9%][a-z0-9%-]+/g) ?? []).filter((w) => w.length >= 3 && !stop.has(w));
    // Names first, then the other terms.
    const names = terms.filter((t) => new RegExp(`\\b${t}\\b`, "i").test(companies().join(" ")));
    const scores = new Map();
    for (const t of [...names, ...terms.filter((t) => !names.includes(t))]) {
      for (const h of grep(t)) {
        const key = `${h.path}:${h.line}`;
        const s = scores.get(key) ?? { ...h, terms: new Set() };
        s.terms.add(t);
        scores.set(key, s);
      }
    }
    const lines = [...scores.values()]
      .filter((h) => h.text.startsWith("- ") && (names.length === 0 || names.some((n) => h.path.toLowerCase().includes(n))))
      .sort((a, b) => b.terms.size - a.terms.size || b.path.localeCompare(a.path))
      .slice(0, 3);
    if (lines.length === 0) return finish(`I found no note that says. I searched for: ${terms.join(", ")}.`);
    for (const p of new Set(lines.map((l) => l.path))) read(p);
    const answer = lines.map((l) => `${l.text.replace(/^- (\[[ x]\] )?/, "")} [${l.path}:${l.line}]`).join("\n");
    return finish(answer);
  },

  "code-task"() {
    if (access !== "write") return finish("This task needs write access; made no changes.");
    const task = inv.arguments.task ?? "";
    const readme = path.join(process.cwd(), "README.md");
    trace.push(`✱ Read → README.md`);
    if (/typo/i.test(task) && fs.existsSync(readme)) {
      const before = fs.readFileSync(readme, "utf8");
      const after = before.replace(/wordlwide/g, "worldwide");
      if (after !== before) {
        fs.writeFileSync(readme, after);
        trace.push(`✱ Edit → README.md`);
        execFileSync("node", ["check.mjs"], { cwd: process.cwd() });
        trace.push(`✱ Bash → node check.mjs (passed)`);
        execFileSync("git", ["commit", "-qam", "Fix typo in README"], { cwd: process.cwd() });
        trace.push(`✱ Bash → git commit`);
        return finish("Fixed the typo in README.md (wordlwide → worldwide).\nLeft: nothing.\nchecks: node check.mjs passed");
      }
    }
    return finish("The task was not clear enough for a small change; made no commit.");
  },
};

const fn = skills[inv.skill];
if (!fn) {
  process.stderr.write(`mock-agent: no mock for skill "${inv.skill}"\n`);
  process.exit(2);
}
fn();
