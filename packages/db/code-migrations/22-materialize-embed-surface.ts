import fs from 'node:fs';
import path from 'node:path';
import {
  addColumns,
  runClickhouseMigrationCommands,
} from '../src/clickhouse/migration';
import { getIsCluster } from './helpers';

// embed_surface is the host the game was played in — the "web vs app" split
// clients ask for. Same rationale as migrations 18/19/20/21: it is read on the
// overview's cold path (every widget, once a surface filter is set), and reading
// it from the `properties` Map decompresses the whole map per row. Unlike its
// predecessors it is also a *session* attribute, which is what lets
// session-scoped widgets be filtered honestly — see SURFACE_FILTER in
// overview.service.ts.
//
// Values are FREE-FORM, not an enum. The host declares them via
// `data-embed-surface` (puzzlr ADR-0008); the two-tier look in the data is
// declared-vs-fallback, not a taxonomy:
//
//   declared by the host   news_web, news_app, game_app, …  (per-tenant contract)
//   system fallback        web | app | embed                (attribute absent)
//
// So `embed` alongside `news_web` in one project is a tenant part-way through
// wiring the attribute up — not two surfaces, and not a rename: on 14d of prod
// tages-anzeiger emits app/news_web/embed/web/news_app concurrently while
// berner-zeitung is still mostly on the fallback. Never bucket; read the live
// value list per project.
//
// Populates going forward only — no backfill. First covered day fleet-wide is
// 2026-06-13 (business-insider 06-12; bund 06-29, tribune-de-geneve 07-22 and
// welt 07-24 launched later). Ranges crossing that date under-sum.
const MATERIALIZED_COLUMNS = ['embed_surface'] as const;

/**
 * Backfills the MATERIALIZED column on pre-existing parts. Async background
 * mutation (CH default) — no table lock; un-rewritten parts compute the column
 * on read until the mutation finishes, so correctness holds throughout. Inline
 * here (not in shared migration.ts) to keep the upstream-merge surface at zero.
 */
function materializeColumns(
  tableName: string,
  columnNames: readonly string[],
  isClustered: boolean,
): string[] {
  // MATERIALIZE targets the local replicated table that holds data, not the
  // Distributed proxy.
  const target = isClustered
    ? `${tableName}_replicated ON CLUSTER '{cluster}'`
    : tableName;

  const actions = columnNames
    .map((col) => `MATERIALIZE COLUMN ${col}`)
    .join(', ');

  return [`ALTER TABLE ${target} ${actions}`];
}

export async function up() {
  const isClustered = getIsCluster();

  const sqls: string[] = [
    ...addColumns(
      'events',
      [
        "`embed_surface` LowCardinality(String) MATERIALIZED properties['embed_surface']",
      ],
      isClustered,
    ),
    ...materializeColumns('events', MATERIALIZED_COLUMNS, isClustered),
  ];

  fs.writeFileSync(
    path.join(import.meta.filename.replace('.ts', '.sql')),
    sqls
      .map((sql) =>
        sql
          .trim()
          .replace(/;$/, '')
          .replace(/\n{2,}/g, '\n')
          .concat(';'),
      )
      .join('\n\n---\n\n'),
  );

  if (!process.argv.includes('--dry')) {
    await runClickhouseMigrationCommands(sqls);
  }
}
