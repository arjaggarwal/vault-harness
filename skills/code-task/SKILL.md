---
name: code-task
description: Make a small code change in a git worktree and commit it on the branch. Never merge or push.
access: write
---

# Code task

You are in a fresh git worktree, on the branch named in the invocation block.
The task is `arguments.task`.

1. Read the repo's README and any test or check script before you change code.
2. Make the smallest change that does the task. Do not reformat unrelated code.
3. Run the repo's tests or checks if it has them.
4. Commit on the current branch with a clear message. Leave no uncommitted
   changes: the harness rejects a dirty worktree.
5. Never merge, rebase onto another branch, push, or delete branches. The
   harness asks the person and merges only after a yes.
6. End with a short summary: what changed, what is left, and the test result
   on one line.

If the task is unclear or would need more than a small change, make no commit
and explain why. The harness then reports "nothing to ship".
