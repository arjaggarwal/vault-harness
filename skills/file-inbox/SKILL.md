---
name: file-inbox
description: Propose a home for each note in Inbox/. Every move is an ask; nothing moves without a yes.
access: read
writes: [_agent/]
context: [inbox]
---

# File inbox notes

Each note in `Inbox/` (listed in the context below) needs a home. You propose
the moves; the harness asks the person and only moves what they approve.

## Steps

1. For each inbox note, read it and grep the vault for the companies and
   people it mentions.
2. Pick a destination:
   - about one company that has a folder under `companies/` →
     `companies/<Company>/notes/<same file name>`
   - an idea or a plan that is not about one company → `ideas/<same file name>`
   - unclear → leave it, and say why in the summary
3. Never rename the file and never overwrite an existing note. If the
   destination exists, leave the note and say so.
4. Write a short log of what you proposed to `_agent/inbox-log.md` with
   `"mode": "append"`, one line per note, starting with today's date.

## Output

One ask per note you want to move:

```
{ "question": "Move \"Inbox/x.md\" to companies/Globex/notes/?",
  "detail": "Mentions the Globex warehouse visit and the pallet spec.",
  "action": { "type": "move-note", "from": "Inbox/x.md", "to": "companies/Globex/notes/x.md" } }
```
