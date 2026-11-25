# Vault Harness

A small reference harness for AI agents that work on an **Obsidian vault**. A daemon runs jobs
on a cron schedule. Some jobs are plain TypeScript. Others run a local AI CLI (**Claude Code** or
**Codex**) headless against a `SKILL.md`. An "ask the vault" agent answers questions by grepping
your notes and citing the lines it read. Anything that would move your notes or merge code waits
for your **approve / decline**, and coding tasks run in a **git worktree**, never in your
checkout. A tiny dashboard shows it all.

```bash
git clone <this repo> vault-harness && cd vault-harness
npm install
npm run demo            # the whole loop, against a made-up vault, no AI login needed
npm run demo -- --serve # same, then opens the dashboard at http://127.0.0.1:7788
npm test
```

## Where this comes from

I worked this design out in a private agent system I built for my own work between March and
November 2026. It ran jobs on my vault every day (a morning briefing, meeting filing, a to-do
sort) and answered questions from my notes. That system is tied to private data, so it can't be published.
This repo is a **clean reference implementation**, written new in November 2026. The design is the
same, the code is not: it is smaller and generic, and its demo vault is made up. The private
system's history is not in this repo.

## How it fits together

```
                    ┌────────────────────────────────────────────────────────────┐
 jobs.json ───────► │ Scheduler: one reconciler tick (20 s) over the minutes     │
 (cron, type)       │ since the last sweep, plus explicit catch-up at start      │
                    └──────────────────────────┬─────────────────────────────────┘
 Dashboard (Hono +  ── Run Now ──┐             │ runJob(id)        ┌─ CLI: harness run / ask / approve
 vanilla JS)                     ▼             ▼                   ▼
                    ┌────────────────────────────────────────────────────────────┐
                    │ Harness.runJob: overlap guard, run record, then by type:   │
                    │                                                            │
                    │  native ── TypeScript handler (sort-todos) ──► vault       │
                    │                                                            │
                    │  skill ─┬─ context builders (git log, changed notes, …)    │
                    │         ├─ prompt = invocation + rules + SKILL.md + context│
                    │         ├─ AI CLI, read-only tools, empty cwd,             │
                    │         │  vault granted with --add-dir                    │
                    │         └─ ```harness-result {summary, writes, asks}       │
                    │               │ validated: allowed folders, path guard,    │
                    │               │ sanity check ("is today's date in it?")    │
                    │               ├─► writes ──────────────────────► vault     │
                    │               └─► asks ──┐                                 │
                    └──────────────────────────┼─────────────────────────────────┘
                                               ▼
                    ┌────────────────────────────────────────────────────────────┐
                    │ Asks (state/asks.json): question + action as data          │
                    │ run parks as `waiting` ── you approve / decline ──►        │
                    │ action runs (move-note, write-note, merge-branch), run ends │
                    └────────────────────────────────────────────────────────────┘

 Code task:  git worktree add -b agent/<date>-<slug> ─► AI CLI (write access, cwd = worktree)
             ─► commits on the branch ─► ask "merge?" ─► merge + repo tests (undo on failure)
             ─► worktree and branch removed.   Decline: worktree and branch removed.

 Ask the vault:  AI CLI greps + reads (read-only) ─► answer with [note.md:LINE] citations
                 ─► harness opens every cited line ─► ✓ verified / ✗ flagged
```

| Piece | File | What it does |
|---|---|---|
| Scheduler | `src/scheduler.ts`, `src/cron.ts` | Five-field cron, a reconciler tick, explicit catch-up |
| Runner | `src/harness.ts` | One `runJob` for schedule, Run Now, CLI and demo; overlap guard; run records |
| Skills | `src/agents/skill.ts`, `skills/*/SKILL.md` | Prompt layers, SKILL.md frontmatter, write allow-list |
| Provider adapter | `src/providers/cli.ts` | argv for `claude -p` and `codex exec`, prompt on stdin, timeout, output parsing |
| Agent result | `src/agents/result.ts` | The `harness-result` contract and its validation |
| Vault helpers | `src/vault/vault.ts`, `src/vault/search.ts` | Path guard, atomic writes, owned sections, frontmatter, grep |
| Ask the vault | `src/agents/ask-vault.ts`, `skills/ask-vault` | Grep-and-cite agent, citation checker |
| Ask / approve | `src/asks.ts` | Asks as data, actions, finishing a waiting run |
| Code tasks | `src/worktree.ts` | Worktree, branch checks, merge with tests, cleanup |
| Dashboard | `src/server/app.ts`, `public/` | JSON API plus one static page; no build step |
| Mock CLI | `bin/mock-agent.mjs` | Stands in for `claude -p` in the demo and tests |

## The example jobs

| Job | Type | Schedule | What it does |
|---|---|---|---|
| `morning-briefing` | skill | weekdays 07:30 | Today's meetings from the daily note, the open thread from each company's last meeting, the top three to-dos → `_agent/briefing.md` |
| `sort-todos` | native | daily 07:00 | Sorts `tasks/todo.md` by #urgent / #high / #low and due date; moves checked items to Done. No AI call |
| `file-inbox` | skill | daily 21:00 | Proposes a home for each note in `Inbox/`. Every move is an ask |
| `weekly-changelog` | skill | Fridays 16:00 | This week's commits in your repos and the meetings in your vault → `_agent/changelog/` |
| `ask-vault` | skill | manual | Answers a question with cited lines |
| `code-task` | skill | manual | A small code change in a worktree, merged on your OK |

Jobs are declared in `jobs.json`:

```json
{ "id": "morning-briefing", "title": "Morning briefing", "type": "skill",
  "skill": "morning-briefing", "schedule": "30 7 * * 1-5", "catchUp": true, "timeoutSec": 600 }
```

A skill's frontmatter tells the harness how to treat its runs:

```yaml
---
name: morning-briefing
access: read                # read-only tools (write is for code tasks)
writes: [_agent/]           # the only folders its result may write to
expects: _agent/briefing.md # must exist after the run and mention today's date
context: [open-todos]       # TypeScript gathers this before the call
---
```

## Using it on your own vault

1. Copy `harness.config.example.json` to `harness.config.json`. Set `vault` to your vault
   and `repos` to any git repos for the changelog and code tasks.
2. Sign in to the CLI you use (`claude` or `codex`) as you normally would. The harness calls it
   headless and never sees an API key.
3. `npm start` runs the scheduler and the dashboard (on `127.0.0.1` only; set `HARNESS_TOKEN` to
   require a bearer token if you expose it).
4. Or drive it from the command line:

```bash
npm run -s harness -- jobs                       # jobs and their next run
npm run -s harness -- run morning-briefing       # Run Now
npm run -s harness -- ask "What did Globex ask for?"
npm run -s harness -- asks                       # what's waiting for you
npm run -s harness -- approve ask_…              # or decline
npm run -s harness -- code my-site "Fix the typo in the README"
```

The example skills expect a `daily/YYYY-MM-DD.md` note with a `## Meetings` section, a
`tasks/todo.md` with `## Open` and `## Done`, an `Inbox/` folder and one folder per company
under `companies/`. Edit the SKILL.md files to match your vault. They are prompts, not code.

## Design choices, and why

- **The agent proposes, the harness disposes.** Vault skills run with read-only tools and end
  with a JSON block of proposed writes and asks. The harness applies the writes itself, checks
  each path against the skill's allow-list and the vault guard, and refuses `..`, absolute paths,
  `.obsidian/`, and symlinks that lead out. Moves, renames and overwrites of your notes are asks.
- **Asks are data, not a paused process.** An ask stores its action (`move-note`,
  `merge-branch`, …) as JSON, and its run parks as `waiting`. Whoever answers (the dashboard,
  the CLI, a test) performs the action. A run can wait overnight and survive a restart.
- **Grep, not an index.** The ask-the-vault agent searches files the way you would in a
  terminal and cites `[note.md:LINE]`. In the private system, a keyword index and embeddings
  went stale, and in a week of use the agent opened none of the files the index suggested. Grep
  at question time is always current. The harness re-opens every citation and flags the ones that don't check out.
- **One reconciler tick, not a timer per job.** Per-job timers drift and can skip a slot after
  sleep. A sweep over "every minute since last time" cannot. Cron never replays a missed run, so
  catch-up is explicit and limited to jobs marked `catchUp`.
- **One path for every trigger.** Schedule, Run Now, CLI and demo all call the same `runJob`.
  A second run of a running job is recorded as `skipped`, not stacked.
- **Don't trust "done".** A skill can declare a file it must produce, and the harness checks the
  file exists and carries today's date. A reply without a valid result block fails the run, and
  its text is kept for you to read, never acted on.
- **Code runs in a worktree or not at all.** If the worktree can't be created, the task fails
  rather than touching your checkout. The agent commits on its branch and never merges. On your
  OK the harness merges, runs the repo's tests, and undoes the merge if they fail.
- **Mechanical steps are code.** Listing changed notes, reading git logs, parsing the to-do list:
  TypeScript does these before the model is called, so the prompt carries facts, not chores.
- **Isolation for the CLI.** It runs in an empty working folder (so no stray `CLAUDE.md` or
  `AGENTS.md` steers it), with the vault granted explicitly, its tools allow-listed, and the
  prompt on stdin. Note contents are data, never instructions; the shared prelude says so.

## What's left out

This is a reference, not a product. It has no file watcher triggers, no retry ladder, no
streaming of live run output to the dashboard, no multi-vault config, and no cross-process locks.
The state is two JSON files. Each would be a small addition on top of the same shapes.

## Development

```bash
npm test          # node:test, 46 cases: cron, vault guard, to-do sort, result contract,
                  # citations, asks, misbehaving agents, worktree merge/decline/undo, API
npm run typecheck
```

The tests use the mock CLI and a fixture that misbehaves on purpose: no result block, a path
escape, a write outside the allow-list, a missing date, a forbidden action, a crash and a
timeout. Each must fail the run without touching the vault.

The demo vault (`demo-vault/`) is fictional: Acme Widgets, its customer Globex, its supplier
Initech, and five made-up people.

Requires Node 20.11 or later and git.

## License

MIT. See [LICENSE](LICENSE).
