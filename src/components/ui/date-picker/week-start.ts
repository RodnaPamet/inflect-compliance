/**
 * The first day of the week, as a `Date.getUTCDay()` index (0 = Sunday).
 *
 * ONE constant because two components that render on the same page disagreed:
 * `date-picker/calendar.tsx` defaulted to Monday (`weekStartsOn = 1`) while the
 * calendar's month grid hardcoded Sunday through a bare `getUTCDay()`. A date
 * picked in one and located in the other sat under a different column.
 *
 * Monday, following ISO-8601 and the picker's existing default — changing the
 * picker would have been the larger behaviour change of the two.
 *
 * Deliberately a module constant rather than a locale lookup: making it
 * locale-driven means the SERVER-rendered grid and the client hydration must
 * agree on locale before first paint, and a mismatch there is a hydration
 * error rather than a cosmetic one. When the calendar becomes locale-aware this
 * is the single place that changes.
 */
export const WEEK_STARTS_ON = 1;
