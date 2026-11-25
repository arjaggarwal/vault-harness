---
name: morning-briefing
description: A one-page briefing for today, from the daily note, recent meetings and the to-do list.
access: read
writes: [_agent/]
expects: _agent/briefing.md
context: [open-todos]
---

# Morning briefing

Write today's briefing to `_agent/briefing.md`. It is read on a phone before
the first meeting, so keep it to one screen.

## Steps

1. Open today's daily note, `daily/<today>.md`. List today's meetings from its
   `## Meetings` section, with times.
2. For each company or person in those meetings, grep the vault for their name.
   Open the most recent meeting note about them and pull the one or two open
   threads worth remembering before the call (a promised number, an
   unanswered question). Link the note with `[[wiki links]]`.
3. From the open to-dos in the context below, pick the three that matter most
   today: #urgent and #high first, then anything due today or overdue.
4. If a meeting today has no prep material in the vault, say so in one line.

## Format

```
# Briefing for <today>

## Today
- 10:00 Meeting title: one line on what to have ready ([[source note]])

## Top three
- [ ] ...

## Heads-up
- anything due, overdue or missing
```

Write the whole note with `"mode": "replace"`. Mention <today> in the title
(the harness checks for it).
