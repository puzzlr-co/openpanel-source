import fs from 'node:fs';
import path from 'node:path';
import {
  chMigrationClient,
  createTable,
  runClickhouseMigrationCommands,
} from '../src/clickhouse/migration';
import { getIsCluster } from './helpers';

// Fork-only. Per (project, hour, session): did it have a Teaser play, did it
// have full-game evidence. The board drops sessions with teaser AND NOT game
// (teaser-exclusion.fork.ts). AggregatingMergeTree with max(), so a hub event
// in a later hour or a later insert flips the session without a merge, and
// duplicate rows are harmless.
//
// Teaser-only rule (recommendation-teaser-only-readers, corrected): a `teaser:`
// level_id event, and no game_viewed, session_started, ref='teaser' event, or
// non-Teaser level_started/level_completed. `properties['variant']` is not read:
// every Teaser play carries the prefix (teaser-predicates.fork.ts).
//
// Frozen here rather than imported, so a later edit to the predicates cannot
// silently change what this migration created.
const TEASER = "startsWith(level_id, 'teaser:')";
const GAME = `name IN ('game_viewed', 'session_started') OR ref = 'teaser' OR (name IN ('level_started', 'level_completed') AND NOT ${TEASER})`;

const TABLE = 'session_flags';

function flagsSelect(from: string, where: string): string {
  return `SELECT
  project_id,
  toStartOfHour(created_at, 'UTC') AS hour,
  session_id,
  max(${TEASER}) AS teaser,
  max(${GAME}) AS game
FROM ${from}
WHERE ${where}
GROUP BY project_id, hour, session_id`;
}

/**
 * One INSERT per project that ever sent teaser_viewed, from the hour of its
 * first one. Earlier rows need no flags: the query guard keeps everything
 * before a project's first Teaser. Runs after the MV exists, bounded by now(),
 * so no event falls between the two; overlap with the MV only duplicates rows.
 */
async function backfillSqls(): Promise<string[]> {
  const res = await chMigrationClient.query({
    query: `SELECT project_id, toString(min(created_at), 'UTC') AS first
FROM events
WHERE project_id IN (SELECT project_id FROM distinct_event_names_mv WHERE name = 'teaser_viewed')
  AND name = 'teaser_viewed'
GROUP BY project_id
ORDER BY project_id`,
    format: 'JSONEachRow',
  });
  const projects = await res.json<{ project_id: string; first: string }>();

  return projects.map(
    ({ project_id, first }) =>
      `INSERT INTO ${TABLE} (project_id, hour, session_id, teaser, game)
${flagsSelect(
  'events',
  `project_id = '${project_id.replaceAll("'", "\\'")}'
  AND created_at >= toStartOfHour(toDateTime64('${first}', 3, 'UTC'), 'UTC')
  AND created_at <= now()
  AND session_id != ''`,
)}`,
  );
}

export async function up() {
  const isClustered = getIsCluster();

  const ddl = [
    ...createTable({
      name: TABLE,
      columns: [
        '`project_id` String',
        '`hour` DateTime',
        '`session_id` String',
        '`teaser` SimpleAggregateFunction(max, UInt8)',
        '`game` SimpleAggregateFunction(max, UInt8)',
      ],
      engine: 'AggregatingMergeTree()',
      orderBy: ['project_id', 'hour', 'session_id'],
      partitionBy: 'toYYYYMM(hour)',
      distributionHash: 'cityHash64(project_id, session_id)',
      replicatedVersion: '1',
      isClustered,
    }),
    // Clustered: each shard's MV reads its local events and writes its local
    // table; reads go through the Distributed `session_flags`.
    `CREATE MATERIALIZED VIEW IF NOT EXISTS ${TABLE}_mv${isClustered ? " ON CLUSTER '{cluster}'" : ''}
TO ${isClustered ? `${TABLE}_replicated` : TABLE}
AS ${flagsSelect(isClustered ? 'events_replicated' : 'events', "session_id != ''")}`,
  ];

  const isDry = process.argv.includes('--dry');
  if (!isDry) {
    await runClickhouseMigrationCommands(ddl);
  }

  const backfill = await backfillSqls();
  if (!isDry) {
    await runClickhouseMigrationCommands(backfill);
  }

  fs.writeFileSync(
    path.join(import.meta.filename.replace('.ts', '.sql')),
    [...ddl, ...backfill]
      .map((sql) =>
        sql
          .trim()
          .replace(/;$/, '')
          .replace(/\n{2,}/g, '\n')
          .concat(';'),
      )
      .join('\n\n---\n\n'),
  );
}
