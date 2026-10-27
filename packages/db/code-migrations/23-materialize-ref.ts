import fs from 'node:fs';
import path from 'node:path';
import {
  addColumns,
  runClickhouseMigrationCommands,
} from '../src/clickhouse/migration';
import { getIsCluster } from './helpers';

// `ref` is where a reader came from (`game-ref` on the page URL; puzzlr
// GLOSSARY "Ref"). Only writer today: the Teaser button (`ref = 'teaser'`).
// Read by the Teaser widget's "Reached hub" step, which scans every
// game_viewed / level_started row in range. On the properties Map that would
// decompress the whole map per full-game row, on the cold path of every share
// load. Free-form, capped at 32 chars by the client; LowCardinality.
//
// `variant` is deliberately NOT materialized: the Teaser is identified by its
// `level_id` prefix (see teaser-predicates.fork.ts), which is already a column.
//
// Backfilled like 22: `ref` has existed since the Teaser launch, so the
// MATERIALIZE restores hub arrivals for the whole Teaser history. It is a
// mutation on prod `events`; estimate its size before the deploy.
const MATERIALIZED_COLUMNS = ['ref'] as const;

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
        "`ref` LowCardinality(String) MATERIALIZED properties['ref']",
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
