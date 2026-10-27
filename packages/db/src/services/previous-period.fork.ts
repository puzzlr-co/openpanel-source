import { DateTime } from '@openpanel/common';

type Period = { startDate: string; endDate: string };

const FORMAT = 'yyyy-MM-dd HH:mm:ss';
// Bounds are wall-clock strings in the project timezone; UTC parsing keeps
// arithmetic on them free of the server's DST.
const parse = (value: string) =>
  DateTime.fromFormat(value, FORMAT, { zone: 'utc' });

/**
 * Fork-only. A range that runs past now ("Last 7 days" ends tonight) is
 * compared with the same elapsed time of the previous period, not all of it:
 * the previous end moves to now shifted back by the period length. `byHour`
 * rounds now down to the hour, so previous bounds, which key the
 * previous-period cache, change once an hour.
 */
export function previousToElapsed(
  current: Period,
  previous: Period,
  timezone: string,
  byHour: boolean,
): Period {
  const zonedNow = DateTime.now().setZone(timezone);
  const now = parse(
    (byHour ? zonedNow.startOf('hour') : zonedNow).toFormat(FORMAT),
  );
  const elapsedEnd = now.minus(
    parse(current.startDate).diff(parse(previous.startDate)),
  );
  if (elapsedEnd >= parse(previous.endDate)) {
    return previous;
  }
  const end = elapsedEnd < parse(previous.startDate) ? previous.startDate : elapsedEnd.toFormat(FORMAT);
  return { startDate: previous.startDate, endDate: end };
}
