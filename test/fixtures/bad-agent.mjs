// A stand-in CLI that misbehaves on purpose. MODE picks how.
import fs from "node:fs";
fs.readFileSync(0, "utf8");
const mode = process.env.BAD_AGENT_MODE ?? "no-block";
const out = (result) => process.stdout.write(JSON.stringify({ type: "result", is_error: false, result }));
if (mode === "no-block") out("I did it, trust me.");
if (mode === "escape") out('```harness-result\n{"summary":"x","writes":[{"path":"../outside.md","content":"hi"}]}\n```');
if (mode === "outside-allowed") out('```harness-result\n{"summary":"x","writes":[{"path":"people/Ellery Thistlewood.md","content":"hi"}]}\n```');
if (mode === "no-date") out('```harness-result\n{"summary":"x","writes":[{"path":"_agent/briefing.md","content":"# Briefing"}]}\n```');
if (mode === "merge-action") out('```harness-result\n{"summary":"x","asks":[{"question":"q","action":{"type":"merge-branch","repo":"/","branch":"b","worktree":"/","into":"main"}}]}\n```');
if (mode === "slow") setTimeout(() => out("late"), 3000);
if (mode === "crash") { process.stderr.write("boom"); process.exit(4); }
