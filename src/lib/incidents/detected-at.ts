/**
 * "Detected at" — the moment every NIS2 Article 23 deadline is counted from
 * (24h early warning, 72h detailed report, 1-month final report; see
 * `./deadlines.ts`). It is a full timestamp, not a day: an incident detected
 * at 14:37 is due its early warning at 14:37 the next day, and recording it
 * as 00:00 would move every deadline earlier than the real one.
 *
 * The form takes it as two fields — the platform `DatePicker` (day-level by
 * design, see docs/date-picker.md) and a native time input — and these pure
 * helpers turn the pair into one instant in the person's own time zone.
 * Pure, so the client form and the server usecase share one definition.
 */

/**
 * How far past the server's clock a submitted detection time may sit before
 * it is refused as "in the future". The form defaults to the person's NOW,
 * read from their device clock; a device a minute or two fast must not have
 * its own default refused. Five minutes covers ordinary clock drift and is
 * far too small to move an Article 23 deadline in a way that matters.
 */
export const DETECTED_AT_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * The `DatePicker` value for the LOCAL calendar day of `at`. The picker's
 * contract is a UTC-midnight `Date` carrying the chosen Y/M/D
 * (`date-picker.tsx`), so "today" is today's local Y/M/D at 00:00 UTC.
 */
export function pickerDayOf(at: Date): Date {
    return new Date(Date.UTC(at.getFullYear(), at.getMonth(), at.getDate()));
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `HH:MM` of `at` in local time — the value format of `<input type="time">`. */
export function localTimeOf(at: Date): string {
    return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

const TIME_VALUE = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

/**
 * The local instant on picker day `day` (UTC-midnight Y/M/D) at the time
 * `time` (`HH:MM` or `HH:MM:SS`). Returns `null` when either part is missing
 * or the time is not a valid time-input value, so the caller can refuse
 * rather than guess a time.
 */
export function combineDetectedAt(day: Date | null, time: string): Date | null {
    if (!day || Number.isNaN(day.getTime())) return null;
    const m = TIME_VALUE.exec(time.trim());
    if (!m) return null;
    return new Date(
        day.getUTCFullYear(),
        day.getUTCMonth(),
        day.getUTCDate(),
        Number(m[1]),
        Number(m[2]),
        m[3] ? Number(m[3]) : 0,
    );
}

/** True when `detectedAt` is later than `now` by more than `toleranceMs`. */
export function isDetectedAtInFuture(detectedAt: Date, now: Date, toleranceMs = 0): boolean {
    return detectedAt.getTime() > now.getTime() + toleranceMs;
}
