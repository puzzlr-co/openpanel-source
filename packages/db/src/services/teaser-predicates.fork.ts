/**
 * The one place that tells a Teaser row from a full-game row (fork-only).
 *
 * Every Teaser game event (teaser_viewed, level_started, level_completed,
 * completion_cta_tapped) has level_id 'teaser:<index>' (puzzlr GLOSSARY "Play
 * context"; TeaserShell.tsx). Prod, 120 days to 2026-10-21: no variant='teaser'
 * game event lacks the prefix and no prefixed event lacks the variant. So the
 * materialized level_id is the discriminator and `variant` needs no column.
 * completion_cta_tapped is also sent by the full game, so the prefix, not the
 * name, scopes it.
 *
 * The Teaser's screen_view carries no level_id and is out of reach here; the
 * Teaser-only rule (code-migration 25) reads its `variant` instead.
 *
 * No imports, so overview.service.ts can import it without a cycle.
 */

export const TEASER_PLAY = "startsWith(level_id, 'teaser:')";

export const NOT_TEASER_PLAY = `NOT ${TEASER_PLAY}`;

/** Materialized `ref` column, code-migration 23. */
export const FROM_TEASER = "ref = 'teaser'";

export const TEASER_EVENTS = [
  'teaser_viewed',
  'level_started',
  'level_completed',
  'completion_cta_tapped',
] as const;

export const HUB_ARRIVAL_EVENTS = ['game_viewed', 'level_started'] as const;
