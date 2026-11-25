---
name: weekly-changelog
description: What changed this week, in the repos and the vault, as one note.
access: read
writes: [_agent/changelog/]
expects: _agent/changelog/latest.md
context: [git-log, changed-notes]
---

# Weekly changelog

Summarize the week from the two lists in the context below: commits in each
configured repo, and vault notes changed in the last seven days.

## Steps

1. Group the commits by repo. Turn each group into two to five plain-English
   bullets about what changed for a user, not a list of commit subjects.
2. From the changed notes, name the meetings that happened and any decision
   they record. Open a note only when its title is not enough.
3. Write the note twice, with the same content:
   - `_agent/changelog/<today>.md`
   - `_agent/changelog/latest.md` (the harness checks this one mentions today)

## Format

```
# Week ending <today>

## Shipped
### <repo>
- ...

## In the vault
- [[meeting note]]: one line on the decision or outcome

## Next week
- open threads that carry over (only ones the notes state)
```
