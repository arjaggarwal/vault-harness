// Command line: the same Harness the daemon uses.
//
//   harness daemon                 scheduler + dashboard
//   harness jobs                   list jobs and their next run
//   harness run <job>              run a job now
//   harness runs [job]             recent runs
//   harness ask "<question>"       ask the vault (grep + cite)
//   harness asks                   pending asks
//   harness approve|decline <id>   resolve an ask
//   harness code <repo> "<task>"   code task in a git worktree
//   harness grep <terms...>        rank notes for some terms (what a grep would find)

import { loadConfig } from "./config.ts";
import { Harness } from "./harness.ts";
import { Scheduler } from "./scheduler.ts";
import { startServer } from "./server/serve.ts";
import type { RunRecord } from "./types.ts";
import { queryTerms, searchNotes } from "./vault/search.ts";

const USAGE = `usage: harness <daemon|jobs|run|runs|ask|asks|approve|decline|code|grep> [...]`;

function printRun(r: RunRecord): void {
  console.log(`${r.status.padEnd(9)} ${r.jobId}  ${r.summary ?? ""}`);
  if (r.error) console.log(`  error: ${r.error}`);
  if (r.writes.length) console.log(`  wrote: ${r.writes.join(", ")}`);
  if (r.asks.length) console.log(`  waiting on: ${r.asks.join(", ")}  (harness asks)`);
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  const config = loadConfig();
  const harness = new Harness(config);

  switch (cmd) {
    case "daemon": {
      const scheduler = new Scheduler(harness);
      scheduler.start();
      startServer(harness, scheduler, config.port);
      console.log(`harness: vault ${config.vault}`);
      console.log(`harness: dashboard on http://127.0.0.1:${config.port}`);
      harness.onRun((r) => console.log(`[${new Date().toLocaleTimeString()}] ${r.status} ${r.jobId} ${r.summary ?? r.error ?? ""}`));
      return new Promise<number>(() => {}); // run until killed
    }
    case "jobs": {
      const scheduler = new Scheduler(harness);
      for (const j of harness.jobs) {
        const next = scheduler.nextRunAt(j.id);
        console.log(`${j.id.padEnd(18)} ${j.type.padEnd(6)} ${(j.schedule ?? "manual").padEnd(14)} ${next ? next.toLocaleString() : ""}`);
      }
      return 0;
    }
    case "run": {
      if (!rest[0]) throw new Error("usage: harness run <job>");
      printRun(await harness.runJob(rest[0], "manual"));
      return 0;
    }
    case "runs": {
      for (const r of harness.store.runs().filter((r) => !rest[0] || r.jobId === rest[0]).slice(0, 20)) printRun(r);
      return 0;
    }
    case "ask": {
      const q = rest.join(" ").trim();
      if (!q) throw new Error('usage: harness ask "<question>"');
      const res = await harness.askVault(q);
      console.log(res.answer.split("\n").filter((l) => !l.startsWith("✱")).join("\n").trim());
      console.log("");
      for (const c of res.citations) console.log(`${c.verified ? "✓" : "✗"} ${c.path}:${c.line}${c.verified ? "" : `  (${c.reason})`}`);
      return res.grounded ? 0 : 3;
    }
    case "asks": {
      const asks = harness.pendingAsks();
      if (asks.length === 0) console.log("nothing waiting");
      for (const a of asks) console.log(`${a.id}  ${a.question}${a.detail ? `\n    ${a.detail.split("\n").join("\n    ")}` : ""}`);
      return 0;
    }
    case "approve":
    case "decline": {
      if (!rest[0]) throw new Error(`usage: harness ${cmd} <ask id>`);
      const a = await harness.resolveAsk(rest[0], cmd);
      console.log(`${a.status}: ${a.result}`);
      return a.status === "failed" ? 1 : 0;
    }
    case "code": {
      const [repo, ...task] = rest;
      if (!repo || task.length === 0) throw new Error('usage: harness code <repo> "<task>"');
      printRun(await harness.codeTask(repo, task.join(" ")));
      return 0;
    }
    case "grep": {
      const terms = queryTerms(rest.join(" "));
      for (const m of searchNotes(harness.vault, terms)) {
        console.log(`${m.score.toString().padStart(3)}  ${m.path}  [${m.termsHit.join(", ")}]`);
        for (const hit of m.hits.slice(0, 3)) console.log(`       ${hit.line}: ${hit.text.slice(0, 100)}`);
      }
      return 0;
    }
    default:
      console.error(USAGE);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`harness: ${(err as Error).message}`);
    process.exit(1);
  },
);
