import fs from 'node:fs';
import path from 'node:path';
import {
  chMigrationClient,
  runClickhouseMigrationCommands,
} from '../src/clickhouse/migration';
import { getIsCluster } from './helpers';

// Fork-only. Migration 24's Teaser-only rule missed a reader whose Teaser never
// scrolled into view: the Teaser then sends only its screen_view, which has no
// level_id but carries properties['variant'] = 'teaser'. That screen_view now
// sets `teaser` too. `game` is unchanged.
//
// Frozen here rather than imported, like 24.
const TEASER =
  "startsWith(level_id, 'teaser:') OR (name = 'screen_view' AND properties['variant'] = 'teaser')";
const GAME =
  "name IN ('game_viewed', 'session_started') OR ref = 'teaser' OR (name IN ('level_started', 'level_completed') AND NOT startsWith(level_id, 'teaser:'))";

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
 * first one (the query guard keeps everything earlier), of the Teaser
 * screen_views only: every other event already has its row from 24's backfill
 * or the MV, and max() merges these in. Runs after the MV changed, bounded by
 * now(), so overlap only duplicates rows. Rerunning it is harmless.
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
  AND session_id != ''
  AND name = 'screen_view'
  AND properties['variant'] = 'teaser'`,
)}`,
  );
}

export async function up() {
  const isClustered = getIsCluster();

  const ddl = [
    `ALTER TABLE ${TABLE}_mv${isClustered ? " ON CLUSTER '{cluster}'" : ''}
MODIFY QUERY ${flagsSelect(isClustered ? 'events_replicated' : 'events', "session_id != ''")}`,
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
