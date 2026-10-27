# Runbook: Deploy local changes to production

**Production:** `activity.puzzlr.net` — VPS `root@91.98.228.238`, stack at `~/openpanel/self-hosting`
(docker compose: caddy + postgres + redis + clickhouse + op-api + op-dashboard + op-worker×4).
Live multi-tenant traffic. Zero data-loss tolerance.

**Execution model:** written for an AI agent deploying autonomously while the operator is
passively available (other tabs open, reachable in-session). The task "deploy the current
state of main" carries the authorization — no GO approval at any step. Stop and ask **only**
at the ⛔ points; they are objective blockers, not courtesy check-ins. Midday deploys are
fine; the cost is ~30 s of full outage at the ship step.

**Versioning is hands-off** (ADR-0001, ADR-0002): the build derives the immutable release
tag `main-<7-char-sha>` from HEAD; prod tracks the `:2` channel tag, which only
`sh/docker-release` moves. Terms per `GLOSSARY.md`.

**Zero placeholders:** every command derives what it needs from git or reads it off prod.
A command below only takes an argument when you are rolling back.

## Happy path

```bash
./sh/preflight                # gates + classification + typecheck/tests (~3 min); ⛔-exits if it needs you
./sh/docker-build all         # 10–20 min — run in a background shell (exceeds 10-min exec caps)
./sh/docker-release           # :2 → the build of HEAD (instant; prod untouched until ship)
./sh/ship                     # VPS: backup + update (~30 s outage) + revision-pinned verify
./sh/verify-prod --watch 15   # detached babysit; poll the printed command for BABYSIT RESULT
# meanwhile: acceptance check (§1) + data-flow audit (§7), then report (§6)
```

Each command is independently re-runnable; a failure leaves no half-state (the build is
prod-inert, the release is idempotent, ship re-runs safely — no new digest degrades to a
no-op recreate).

## 1. Judgment in preflight (the part the script can't do)

`preflight` prints the commits in the release. Derive one concrete post-deploy assertion
proving the release-specific change is live (a curl, a page, a query). If the release has
no observable change (pure refactor), say so explicitly in the report instead. Run the
check after ship — the babysit window is a fine time.

Notes on preflight's ⛔ exits and warnings:
- **Dirty/unpushed tree** → stop and ask; never commit or push on your own initiative.
- **New code-migration in the release** (exit 2) → read the migration, summarize what it does
  to the operator, and wait. The operator decides routine flow vs supervised run (§4), then you
  resume with `./sh/preflight --migrations-ack` — exit 2 happens *before* typecheck/tests, so
  the ack re-run is what makes the gates run rather than be skipped. Only an *added* migration
  trips this: the runner records applied migrations by filename, so editing one prod already ran
  is inert and preflight lists it as `edited:` without stopping. What makes a ClickHouse
  migration heavy is rewriting existing rows — an `UPDATE`, a re-sort, a type change. Adding a
  MATERIALIZED column is not that: it writes one new column file per part, returns immediately
  (`mutations_sync` is unset), and old parts compute the value on read until it lands, so
  correctness never depends on the backfill. Measured 2026-08-03: `MATERIALIZE COLUMN
  time_seconds` over 103M rows finished in seconds.
- **prisma-only** → proceed; migrations auto-run on op-api start, its 600 s healthcheck
  `start_period` absorbs them, and caddy only routes once api+dashboard are healthy. But
  auto-rollback is disarmed (§2).
- **Docker Hub auth** has no reliable offline check: the push happens ~10 min into the
  build, so a stale `docker login` fails late. Benign — fix auth, rerun the build.

## 2. On failure — decision policy

| Signal | Action |
|---|---|
| One check fails once (curl timeout, single odd log line) | Re-run `./sh/verify-prod` once. Clean → transient; continue babysit. |
| Hard failure on 2 consecutive runs (containers unhealthy, API health down, freshness stale, restart deltas climbing, wrong revision) — **code-only release** | **Auto-rollback** (§3), re-verify, then report what happened. |
| Same hard failure — **release ran any migration** | ⛔ **Freeze.** Don't roll back: code rollback against a migrated schema is an informed human judgment, and a pg restore drops post-backup writes. Report state + the prepared §3 commands, wait. |
| Unknown error-log lines as the *only* red signal | ⛔ Report the lines, keep babysitting. Never roll back on logs alone — known noise exists (§5 gotcha 8). |
| Volume, project coverage, or field population off baseline (§7) | ⛔ Report the numbers and wait. Establish whether the anomaly predates the deploy before treating it as the release's — capture can break from causes the release never touched. |
| Any red signal matching no row above | ⛔ Report and wait. |

Ship's built-in verify follows row 1: one hard failure earns exactly one re-run, and a
failed re-run counts as the second consecutive run.

## 3. Rollback

Same machinery as a forward deploy — release the previous build, ship it. Preflight
printed the exact commands (`rollback:` line); the shape is:

```bash
./sh/docker-release main-<prev-7-char>   # the channel re-points; no VPS file edits (ADR-0002)
./sh/ship <prev-full-sha>                # backup + update + verify, pinned to the previous revision
```

Expect the same ~30 s outage. Roll-forward later = a normal deploy.

If a Prisma migration ran, restoring ship's `pg_dump` is a ⛔ human-driven decision (it
drops data written since the backup):
`docker exec -i self-hosting-op-db-1 psql -U postgres postgres < /root/backup-<...>.sql`
— the operator runs or explicitly approves this, never the agent.

Backup retention is automatic: ship prunes deploy dumps beyond the 5 most recent before
taking the new one (a dump's restore value dies with the next successful deploy, but it
holds every secret in Postgres). The date-globs never match the operator-managed one-off
backups (`backup-*-datadir.tar.gz` etc.) — those are not the deploy flow's to delete.

## 4. Exception: heavy ClickHouse migrations

When preflight exits 2 and the operator classifies the migration heavy/destructive: skip
the routine flow and run it supervised first — operator-driven (or explicitly approved),
on the VPS inside tmux (survives a dropped ssh):

```bash
# ssh root@91.98.228.238, then:
tmux new -s migrate
cd ~/openpanel/self-hosting
docker compose run --rm --no-deps op-api sh -c "CI=true pnpm -r run migrate:deploy"
```

Worked example: the v1→v2 upgrade plan, Phase 4.8 (retired after completion; see git history — `git log --all --oneline -- docs/plans/`).

## 5. Gotchas (encoded from incidents)

| # | Gotcha |
|---|--------|
| 1 | VPS `docker-compose.yml` + `.env` are gitignored (generated once by `./setup`). Template changes do **not** propagate — apply compose changes by hand on the VPS and mirror them in `docker-compose.template.yml`. |
| 2 | Never gate on physical `count()` of `openpanel.sessions` (VersionedCollapsingMergeTree merge timing) — use `sum(sign)` or `count() FINAL`. |
| 3 | ClickHouse XML configs (`self-hosting/clickhouse/*.xml`) are git-tracked + bind-mounted: deploy via `git pull` + `SYSTEM RELOAD CONFIG` — zero downtime, no image build. |
| 4 | **SSR module-resolution bugs return HTTP 200** — TanStack Start streams a loading shell while the server logs `ERR_MODULE_NOT_FOUND`. Page checks must pair with a log grep (verify-deploy does). Root cause class: externalized deps with bare deep imports (`lodash/debounce`) or deps missed by nitro's tracer (`esm-env`); fix via `ssr.noExternal` in `apps/start/vite.config.ts`. |
| 5 | Never run `pnpm migrate:deploy` locally against prod; never run formatters. |
| 6 | VPS `.env` holds secrets — never print/commit. |
| 7 | Brief worker downtime loses nothing — events buffer in Redis through the recreate window. |
| 8 | Error-log noise is real. Known (2026-06-04): `overview.userJourney` "Query memory limit exceeded" — the 6 GB/query cap working as designed; disappears when that query is fixed upstream. Unknown lines → §2 last row. |
| 9 | `RestartCount` is cumulative since container creation (op-ch carries historical OOM restarts) — verify-deploy therefore reports restart *deltas*, not absolute counts. |
| 10 | Recreation wipes container log history: post-deploy log checks see only the new release (pure signal, but no view into pre-deploy errors). |
| 11 | `self-hosting-op-*-1` container names derive from the compose project name (= the stack directory, `self-hosting`). If a name doesn't resolve, list the real ones with `docker compose ps` — don't guess. |

## 6. Agent harness notes

- The build (10–20 min) and babysit (15+ min) exceed typical 10-min foreground command
  caps — run the build in a local background shell; `verify-prod --watch` already
  detaches on the VPS, just poll the command it prints.
- ssh is key-based and non-interactive; if anything prompts, stop and ask.
- Final report: shipped revision + release tag, verify/babysit results, acceptance-check
  outcome, backup filename, and — if anything went red — the exact failing output.
  Report faithfully; a failed check is reported as failed.

## 7. Data-flow audit

`verify-deploy` proves events are **arriving** — "newest event 9s old" is a freshness probe, and it passes while volume sits at a tenth of normal, one tenant is dark, or every event arrives stripped of its properties. Releases have broken capture exactly that way, so 8/8 green is not evidence the data is intact. Two further questions, run in the babysit window and reported with the rest (§6). The boundary is read off prod, never typed:

```bash
# ssh root@91.98.228.238, then:
CH() { docker exec self-hosting-op-ch-1 clickhouse-client --query "$1"; }
D=$(docker inspect self-hosting-op-api-1 --format '{{.State.StartedAt}}' | cut -c1-19 | tr 'T' ' ')
```

**Enough?** Against the same clock window on previous days. A raw pre/post diff is worthless — traffic swings hours-wide on its own, so an evening decline reads as a collapse. (A deploy straddling midnight inverts the clock bounds and the baseline comes back empty — compare a fixed window on prior days instead.)

```bash
CH "SELECT toDate(created_at) AS day, count() AS events, uniqExact(project_id) AS projects
    FROM openpanel.events WHERE created_at >= today() - 7
      AND toTime(created_at) >= toTime(toDateTime('$D')) AND toTime(created_at) < toTime(now())
    GROUP BY day ORDER BY day"

# per project, because an aggregate hides one dark tenant. Both sides span the same
# duration — an hour of `pre` against ten minutes of `post` reads as a collapse.
CH "SELECT project_id,
      countIf(created_at >= toDateTime('$D')) AS post,
      countIf(created_at <  toDateTime('$D')) AS pre
    FROM openpanel.events
    WHERE created_at >= toDateTime('$D') - (now() - toDateTime('$D'))
    GROUP BY project_id ORDER BY pre DESC"
```

**Whole?** The failure that hides: events keep arriving at normal volume with their contents stripped, so counts look right while every property-derived metric tanks.

```bash
CH "SELECT if(created_at >= toDateTime('$D'),'POST','PRE') AS w, count() AS events,
      round(100*countIf(session_id!='')/count(),1) AS pct_session,
      round(100*countIf(profile_id!='')/count(),1) AS pct_profile,
      round(100*countIf(length(properties)>0)/count(),1) AS pct_props,
      round(avg(length(properties)),1) AS avg_keys
    FROM openpanel.events
    WHERE created_at >= toDateTime('$D') - (now() - toDateTime('$D'))
    GROUP BY w ORDER BY w DESC"

# and that no event name vanished — one dead SDK path hides inside a healthy total
CH "SELECT name,
      countIf(created_at >= toDateTime('$D')) AS post,
      countIf(created_at <  toDateTime('$D')) AS pre
    FROM openpanel.events
    WHERE created_at >= toDateTime('$D') - (now() - toDateTime('$D'))
    GROUP BY name ORDER BY pre DESC LIMIT 15"
```

Reading the numbers:

- **A real break moves everything one way at once.** Mixed movement across small projects is variance. Judge on the largest project and the aggregate; a low-volume project swinging ±50% between short windows is noise, and an intermittent one showing zero may simply not have emitted — widen the window before calling it dark.
- **Never read the trailing window as a trend.** Cron-written events land backdated: `session_end` carries the session's end time, and the reaper's 30-min deadman puts it 30–35 min behind wall clock, so the newest buckets are *always* empty and fill in later. Confirm a suspected stall by watching the bucket backfill, never by its emptiness. The worker counters settle it outright — `session_ends_emitted_total` and `_skipped_total` at `localhost:3000/metrics`, per replica.

Done when volume sits inside the prior-days band, every project reporting before the boundary still reports, shape rates are at or above `PRE`, and no event name has gone to zero. A shortfall that survives both readings above is a red signal with no row in §2's table: report it and wait.

## Validation record

- **2026-06-04 (2.0.1, semver-era):** `./update` mechanics validated — non-interactive
  pull, recreate scope limited to app containers, 32 s outage measured, no-digest deploy
  degrades to no-op, SSR canary sensitivity proven against a live bug.
- **2026-06-05 (main-9a94993, first SHA deploy):** `docker-build all` / `docker-release` /
  revision check / babysit all validated live — 8/8 verify, all babysit rounds clean,
  acceptance check confirmed visually. Rollback-via-release still untested.
- **2026-08-24 (main-de50629, 41-commit upstream sync):** the ⛔ migration-ack path ran
  end to end — preflight exit 2, operator classified routine, `--migrations-ack` re-run
  gated on 865/865. Four migrations applied on op-api start; both ClickHouse backfills
  (`MATERIALIZE INDEX`, `MATERIALIZE PROJECTION`) reached `is_done=1` inside the babysit
  without blocking startup. §7 first exercised: it cleared the release, and its trailing-
  window rule caught a false alarm the raw bucket counts had produced. §2 row 4 also had
  its first live run: the 30-min babysit reported `10 failed checks` that were one
  `ECONNRESET` warning on `POST /track` counted across ten overlapping 10-min windows,
  every other check green and the last 12 rounds 8/8 — reported, not rolled back.
  Rollback-via-release still untested.
