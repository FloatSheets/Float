/**
 * US equity session calendar. FloatSheets markets trade 24/7, but their
 * underlyings do not; this decides when the listing exchange cannot provide a
 * price at all (weekends and NYSE holidays, outside extended hours).
 */

/** NYSE full-day closures. Extend this list each year. */
export const NYSE_HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24"
]);

/** Regular close. The band anchors to the price at this time. */
const REGULAR_CLOSE = "16:00:00";
/** End of after-hours trading on the last session before a closure. */
const EXTENDED_CLOSE = "20:00:00";
/** Start of pre-market trading on the next session. */
const EXTENDED_OPEN = "04:00:00";

function offsetMinutes(instant: Date): number {
  const label = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" })
    .formatToParts(instant).find((part) => part.type === "timeZoneName")?.value ?? "GMT-5";
  const match = label.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!match) return -300;
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return match[1] === "-" ? -minutes : minutes;
}

/** Converts a date ("MM/DD/YYYY") and Eastern time ("HH:MM:SS[.sss]") to UTC. */
export function easternToUtc(date: string, time: string): Date | null {
  const day = date.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const clock = time.match(/^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!day || !clock) return null;
  const [month, dayOfMonth, hour, minute, second] = [Number(day[1]), Number(day[2]), Number(clock[1]), Number(clock[2]), Number(clock[3])];
  if (month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const wall = Date.UTC(Number(day[3]), month - 1, dayOfMonth, hour, minute, second, Number((clock[4] ?? "0").padEnd(3, "0")));
  // Resolve the Eastern offset at the target instant, then re-check once so
  // times on a daylight-saving boundary land on the right side of it.
  let utc = wall - offsetMinutes(new Date(wall)) * 60_000;
  utc = wall - offsetMinutes(new Date(utc)) * 60_000;
  return new Date(utc);
}

/** Eastern calendar date as YYYY-MM-DD and wall-clock HH:MM:SS. */
export function easternParts(instant: Date): { date: string; time: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(instant).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}` };
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function isTradingDay(date: string): boolean {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !NYSE_HOLIDAYS.has(date);
}

export function easternAt(date: string, time: string): Date {
  const [year, month, day] = date.split("-");
  return easternToUtc(`${month}/${day}/${year}`, time)!;
}

export type ClosedWindow = {
  /** Regular close of the last session; the band anchors to the price here. */
  anchorAt: Date;
  /** When after-hours trading ended and the band began. */
  closedAt: Date;
  /** When pre-market trading resumes and the band lifts. */
  reopensAt: Date;
};

/**
 * Returns the closure window containing `now`, or null while the underlying
 * can trade (regular, pre-market, after-hours, or a weekday overnight gap).
 */
export function closedWindow(now: Date): ClosedWindow | null {
  const { date, time } = easternParts(now);
  let lastSession: string;
  if (isTradingDay(date)) {
    const tomorrow = addDays(date, 1);
    const yesterday = addDays(date, -1);
    if (time >= EXTENDED_CLOSE && !isTradingDay(tomorrow)) lastSession = date;
    else if (time < EXTENDED_OPEN && !isTradingDay(yesterday)) {
      lastSession = yesterday;
      while (!isTradingDay(lastSession)) lastSession = addDays(lastSession, -1);
    } else return null;
  } else {
    lastSession = addDays(date, -1);
    while (!isTradingDay(lastSession)) lastSession = addDays(lastSession, -1);
  }
  let nextSession = addDays(lastSession, 1);
  while (!isTradingDay(nextSession)) nextSession = addDays(nextSession, 1);
  return { anchorAt: easternAt(lastSession, REGULAR_CLOSE), closedAt: easternAt(lastSession, EXTENDED_CLOSE), reopensAt: easternAt(nextSession, EXTENDED_OPEN) };
}

/** Regular-session open on trading days. */
const REGULAR_OPEN = "09:30:00";

export type OpeningBell = { startsAt: Date; endsAt: Date };

/**
 * The first minutes after the 9:30 ET open, when the underlying's opening
 * auction can move it sharply and the pool TWAP is still catching up.
 */
export function openingBell(now: Date, minutes: number): OpeningBell | null {
  if (minutes <= 0) return null;
  const { date } = easternParts(now);
  if (!isTradingDay(date)) return null;
  const startsAt = easternAt(date, REGULAR_OPEN);
  const endsAt = new Date(startsAt.getTime() + minutes * 60_000);
  return now >= startsAt && now < endsAt ? { startsAt, endsAt } : null;
}

/**
 * The closure window containing `now`, or else the next one to start, found by
 * scanning ahead hour by hour (weekends and NYSE holidays only, so a week is enough).
 */
export function currentOrNextClosedWindow(now: Date, horizonHours = 24 * 9): ClosedWindow | null {
  for (let hour = 0; hour <= horizonHours; hour++) {
    const window = closedWindow(new Date(now.getTime() + hour * 3_600_000));
    if (window) return window;
  }
  return null;
}
