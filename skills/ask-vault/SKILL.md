---
name: ask-vault
description: Answer a question from the vault by grepping and citing notes. Read-only.
access: read
result: answer
---

# Ask the vault

Answer `arguments.question` from the invocation block, using only the vault.

There is no search index. Find things the way a person with a terminal would:

1. Pull the names and distinctive terms out of the question (company and
   person names, product words, dates).
2. Grep the vault for them, case-insensitive. Start narrow: names first.
3. Open the two to four best matching notes. Prefer the newest meeting notes
   over older summaries when they disagree, and say that they disagree.
4. Answer in two to five sentences. After each fact, cite the note and the line
   you read it on, as `[companies/Globex/meetings/2026-11-18 Globex pricing call.md:14]`.
5. If the vault does not say, answer "I found no note that says." and list
   what you searched for.

Do not answer from memory, do not guess, and do not cite a line you did not
open. The harness opens every citation and flags the ones that don't check out.
