---
name: sync-upstream
description: Integrate upstream/main into the fork, then retire fork code upstream has made redundant.
disable-model-invocation: true
---

# Sync upstream

Ends at verified commits on a branch. Deploying them is `docs/runbooks/deploy.md`.

## The seam

Fork code sits in three places and the risk is not spread evenly across them:

| | Where | Risk |
|---|---|---|
| **Fork-only** | files upstream doesn't have — `components/custom/`, `*.fork.ts`, `routers/fork/`, `sh/`, `docs/` | none, until one shares a namespace upstream also adds to |
| **Upstream-only** | files the fork has never edited | none — take upstream's version whole |
| **Seam** | files both sides edit | the conflicts, and the silent breaks |

The fork's architecture exists to keep the seam small (`apps/start/src/config/README.md`), so the seam is normally a handful of files against a hundred incoming. Spend the session's attention there in that proportion.

A seam that auto-merges cleanly is not a seam that is safe. Git merges disjoint *lines*, not intent: upstream renaming a helper that the fork's other hunk in the same file calls produces a clean merge and a dead feature. Clean auto-merge lowers the odds; it never discharges step 4.

A **collision** is that same silent break one level up, where git does not even name the files. It needs no shared file — only both sides adding *different* files to one namespace something else enumerates: a directory that gets scanned, a number series. Nothing was touched twice, so the merge runs clean and its output never mentions it. `packages/db/code-migrations/` is the standing case: both sides number from the same series, so a fork `18-*.ts` and an upstream `18-*.ts` land in one directory and the order within a number stops being anyone's decision.

## 1. Map the surface

Derive it, never recall it — the fork moves between syncs:

```bash
git fetch upstream
MB=$(git merge-base HEAD upstream/main)
git diff --name-only $MB HEAD                    # the fork's whole surface
comm -12 <(git diff --name-only $MB HEAD | sort) \
         <(git diff --name-only $MB upstream/main | sort)   # the seam

# namespaces both sides added files to — the collisions
comm -12 <(git diff --diff-filter=A --name-only $MB HEAD | xargs -n1 dirname | sort -u) \
         <(git diff --diff-filter=A --name-only $MB upstream/main | xargs -n1 dirname | sort -u)
```

Read the fork's diff in **every seam file** now, before any conflict marker exists, and name what the fork is doing to each one. Resolving a hunk correctly requires knowing the intent it carries, and after the merge starts that intent is harder to read.

Done when every seam file has a stated fork intent, every collision namespace has a verdict, and the fork-only list is written down — it is the checklist step 4 spends.

## 2. Read what upstream brings

`git log --oneline HEAD..upstream/main`, then read the messages and diffs of the ones that land on the seam or near a fork feature.

Two outputs, both written down:

- **Forecast** — which seam files will conflict, and on what.
- **Superseded candidates** — upstream features that may make a fork feature redundant. Record them; act in step 6, never here.

## 3. Merge

`git merge upstream/main`, then resolve via **`resolving-merge-conflicts`**, with two fork overrides:

- Preserve both intents. Fork intent yields to upstream only when upstream's version covers it (step 6's coverage bar); otherwise the fork's hunk survives and adapts to upstream's new shape.
- Skip its format step — this repo defers formatting (`CLAUDE.md`).

## 4. Verify

**Regenerate first: `pnpm install && pnpm codegen`.** Node_modules and the Prisma client derive from files the merge just changed, so until they are rebuilt the checks grade the stale artifact rather than the merge — an added upstream dependency or a new Prisma enum value throws dozens of errors that have nothing to do with your resolution.

Then the mechanical pass: `pnpm typecheck`, then `pnpm test`. These catch renames and dangling imports, and nothing else — and the test workspace excludes `apps/start`, where most fork features live. The dashboard has no mechanical net at all.

Then the semantic pass, which is the one that matters. Walk the fork surface from step 1 and account for **every fork feature** — including the ones in files that never conflicted:

- Re-read each seam file whole. Does the fork's intent from step 1 still hold against upstream's new surrounding code?
- For each fork-only feature, trace its chain — component → registration slot → tRPC route → db service → schema. Upstream touching any link breaks it silently from a file the fork never edited.

Done when every fork feature is confirmed present and coherent, one by one. A green typecheck is the floor, not the criterion.

## 5. Commit the merge

The merge commit carries only what integrating upstream required, and step 4's regeneration is what quietly breaks that: `codegen` rewrites *tracked* artifacts from live sources, so they arrive carrying **drift** the merge never asked for. Diff the staged tree against `upstream/main` — everything that differs should be a fork file you recognise. Restore the drift-only ones (`git checkout upstream/main -- <path>`), and refresh them in their own commit if that is wanted.

State: what upstream brings and why it was wanted, what conflicted and how each was resolved, any collision left standing, that fork features are preserved, and any deploy-time step the merge introduces (migrations, new crons, env). Match the shape already in `git log --merges`.

## 6. Retire the superseded

For each candidate from step 2, one commit each, after the merge is committed and green.

**Coverage, not name-match.** Upstream shipping a "retention" widget does not mean it does what the fork's does. Enumerate what the fork's version actually provides and check upstream's against each item. A gap means keep the fork version, or narrow it to just the gap — retiring past a gap is a regression wearing a cleanup's clothes. Retire only on full coverage, verified by running both, not by reading both.

**Complete removal.** Residue is worse than the original: dead code that still typechecks reads as live to the next session. Sweep the whole chain — component, its siblings (`*.NOTES.md`, tests), its registration slot, its tRPC route, its db service and tests, its glossary term in `GLOSSARY.md`.

Applied migrations are the exception: a migration that has run in prod stays. Leave it and say so in the commit.

Done when the feature's symbol name greps to zero hits repo-wide, typecheck and tests are green, and upstream's version is confirmed working in the app. Commit as `refactor(fork): retire <feature>`, naming the upstream commit that supersedes it and listing what was deleted.
