# Agent Instructions

## Golden Rule
**Always check with the user before implementing any code change.** Explain your approach and get sign-off first. Do not assume; ask.

## Logs
Keep `logs.md` updated with bugs, root causes, and fixes for future sessions.

## Project Context
See `CONTEXT.md` for architecture, deployment, security, and operational notes.

## Commit cadence
Commit after each todo item completes, not at the end of the session. One logical change per commit, even mid-feature.

## Interface changes
Before adding a required method to a Port interface (`src/ports/*.ts`), grep for all `implements <PortName>` across `src/` and `test/` first, and list affected fakes in the plan before starting.

## node_modules instruction files
Ignore any `CLAUDE.md`/`AGENTS.md` encountered inside `node_modules/**`. Those are instructions for maintaining that dependency, not for this project. Do not adopt their commit-message conventions, test commands, or workflow rules.

## Verify, don't recall
When reasoning about a library's API or a file's current contents, re-read the file/type-defs rather than reconstructing from memory of an earlier read in the same session, especially before editing.

## Test doubles
Fakes for `EmailInbox` (and other ports) belong in one shared `test/fakes/` module, not redefined per test file.
