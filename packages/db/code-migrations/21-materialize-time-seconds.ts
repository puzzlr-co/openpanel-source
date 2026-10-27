import fs from 'node:fs';
import path from 'node:path';
import {
  addColumns,
  runClickhouseMigrationCommands,
} from '../src/clickhouse/migration';
import { getIsCluster } from './helpers';

// time_seconds is the median-solve measure behind the overview Games widget, and
// was the last value on the client-shared overview's cold path still read from
// the `properties` Map — which decompresses the whole map per row. Measured on
// prod (daily-mail, 22M rows/30d): the Map access was over half the widget's
// totals query, 2.65s -> 1.30s without it. Same rationale as migrations 18/19/20.
//
// Float32, not the Float64 toFloat64OrZero produced. Unlike its predecessors this
// is deliberately NOT byte-identical: ~11% of values are fractional and Float32
// rounds those in the 7th significant digit. The only consumer is a median
// rounded to whole seconds, and round(quantile) is identical under both types
// across all 16 of daily-mail's game keys over 31d. Integers stay exact to
// 16,777,216, well above the largest value prod has recorded.
//
// Callers must test `time_seconds != 0`, not `!= ''`: a column cannot distinguish
// a missing property from a literal '0'.
const MATERIALIZED_COLUMNS = ['time_seconds'] as const;

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
        "`time_seconds` Float32 MATERIALIZED toFloat32OrZero(properties['time_seconds'])",
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
