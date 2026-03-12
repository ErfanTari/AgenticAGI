/**
 * Returns today's date as YYYY-MM-DD in the local timezone.
 * Avoids the UTC-shift bug where new Date().toISOString() returns UTC,
 * causing users in UTC+ to see "tomorrow" as "today" late at night.
 */
export function localDateString(): string {
  const d = new Date();
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60 * 1000);
  return local.toISOString().split('T')[0];
}

/**
 * Returns a local date N days from now as YYYY-MM-DD.
 */
export function localDatePlusDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60 * 1000);
  return local.toISOString().split('T')[0];
}
