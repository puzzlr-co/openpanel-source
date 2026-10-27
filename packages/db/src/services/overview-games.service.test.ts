import { describe, expect, it } from 'vitest';
import {
  expectedDays,
  foldTail,
  type IGameBreakdownRow,
} from './overview-games.service';

function row(
  game: string,
  overrides: Partial<IGameBreakdownRow> = {}
): IGameBreakdownRow {
  return {
    game,
    viewed: 400,
    played: 300,
    play_rate: 75,
    opens: 1000,
    completes: 500,
    completion_rate: 50,
    returning_rate: 25,
    median_solve_s: 60,
    series: [1, 2, 3],
    ...overrides,
  };
}

function rows(count: number): IGameBreakdownRow[] {
  return Array.from({ length: count }, (_, i) => row(`game${i + 1}`));
}

describe('foldTail', () => {
  it('leaves a table at the cap untouched', () => {
    expect(foldTail(rows(12)).map((r) => r.game)).toEqual(
      rows(12).map((r) => r.game)
    );
  });

  it('shows a 13th game as itself rather than folding one game', () => {
    const result = foldTail(rows(13));

    expect(result).toHaveLength(13);
    expect(result.some((r) => r.is_other)).toBe(false);
    expect(result.at(-1)?.game).toBe('game13');
  });

  it('folds from two games up', () => {
    const result = foldTail(rows(14));

    expect(result).toHaveLength(13);
    expect(result.at(-1)).toMatchObject({
      game: 'Other',
      is_other: true,
      other_count: 2,
    });
  });

  // Guards the plural in the UI's `Other (${other_count} games)`.
  it('never emits an "Other" row for a single game', () => {
    for (let n = 0; n <= 40; n++) {
      const other = foldTail(rows(n)).find((r) => r.is_other);
      expect(other?.other_count ?? 2).toBeGreaterThan(1);
    }
  });

  it('sums only the additive measures across the folded tail', () => {
    const result = foldTail([
      ...rows(12),
      row('tail1', { viewed: 200, played: 150, opens: 300, completes: 90, returning_rate: 80 }),
      row('tail2', { viewed: 50, played: 0, opens: 100, completes: 10, returning_rate: 90 }),
    ]);
    const other = result.at(-1)!;

    expect(other.viewed).toBe(250);
    expect(other.played).toBe(150);
    expect(other.play_rate).toBe(60);
    expect(other.opens).toBe(400);
    expect(other.completes).toBe(100);
    expect(other.completion_rate).toBe(25);
    // 0, not a plausible-looking sum — the UI renders these as "n/a".
    expect(other.returning_rate).toBe(0);
    expect(other.median_solve_s).toBe(0);
  });

  it('sums the folded sparkline day by day, keeping the shown length', () => {
    const result = foldTail([
      ...rows(12),
      row('tail1', { series: [1, 0, 5] }),
      row('tail2', { series: [2, 0, 7] }),
    ]);

    expect(result.at(-1)?.series).toEqual([3, 0, 12]);
  });

  it('does not divide by zero when the whole tail has no opens', () => {
    const result = foldTail([
      ...rows(12),
      row('tail1', { opens: 0, completes: 0 }),
      row('tail2', { opens: 0, completes: 0 }),
    ]);

    expect(result.at(-1)?.completion_rate).toBe(0);
  });

  // A range before game_viewed existed has no views: no rate, never 0%.
  it('has no play rate when the whole tail has no views', () => {
    const result = foldTail([
      ...rows(12),
      row('tail1', { viewed: 0, played: 0 }),
      row('tail2', { viewed: 0, played: 0 }),
    ]);

    expect(result.at(-1)?.play_rate).toBeNull();
  });
});

// Every bound below is a real shape getDatesFromRange (date.service.ts) emits.
describe('expectedDays', () => {
  it("drops the trailing day of an exclusive midnight bound ('30d')", () => {
    const days = expectedDays('2026-07-04 00:00:00', '2026-08-04 00:00:00');

    expect(days).toHaveLength(31);
    expect(days[0]).toBe('2026-07-04');
    expect(days.at(-1)).toBe('2026-08-03');
  });

  it("keeps the final day of an inclusive 23:59:59 bound ('today')", () => {
    expect(expectedDays('2026-08-03 00:00:00', '2026-08-03 23:59:59')).toEqual([
      '2026-08-03',
    ]);
  });

  it("covers a whole calendar month ('lastMonth')", () => {
    const days = expectedDays('2026-07-01 00:00:00', '2026-08-01 00:00:00');

    expect(days).toHaveLength(31);
    expect(days[0]).toBe('2026-07-01');
    expect(days.at(-1)).toBe('2026-07-31');
  });

  it("covers a whole year ('lastYear')", () => {
    const days = expectedDays('2025-01-01 00:00:00', '2025-12-31 23:59:59');

    expect(days).toHaveLength(365);
    expect(days.at(-1)).toBe('2025-12-31');
  });

  it("spans two calendar days for a rolling window ('last24h')", () => {
    expect(expectedDays('2026-08-02 14:23:00', '2026-08-03 14:23:59')).toEqual([
      '2026-08-02',
      '2026-08-03',
    ]);
  });

  it('neither skips nor duplicates a day across a DST transition', () => {
    // Europe/London springs forward on 2026-03-29.
    expect(expectedDays('2026-03-28 00:00:00', '2026-03-31 00:00:00')).toEqual([
      '2026-03-28',
      '2026-03-29',
      '2026-03-30',
    ]);
  });

  it('crosses a month and a year boundary', () => {
    expect(expectedDays('2025-12-30 00:00:00', '2026-01-02 00:00:00')).toEqual([
      '2025-12-30',
      '2025-12-31',
      '2026-01-01',
    ]);
  });

  it('returns nothing for an inverted range', () => {
    expect(expectedDays('2026-08-03 00:00:00', '2026-07-01 00:00:00')).toEqual(
      []
    );
  });

  it('returns nothing when an exclusive bound collapses the range', () => {
    expect(expectedDays('2026-08-03 00:00:00', '2026-08-03 00:00:00')).toEqual(
      []
    );
  });

  it('caps an absurd custom range instead of looping unbounded', () => {
    const days = expectedDays('2020-01-01 00:00:00', '2026-01-01 00:00:00');

    expect(days).toHaveLength(400);
    expect(days[0]).toBe('2020-01-01');
  });
});
