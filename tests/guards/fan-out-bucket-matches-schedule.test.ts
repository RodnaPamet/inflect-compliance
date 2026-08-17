/**
 * A dispatcher's dedupe bucket must not be coarser than its cron period.
 *
 * This guards the one edit that breaks fan-out in the silent direction. The
 * deterministic `jobId` in `fan-out.ts` carries a time bucket, and BullMQ
 * dedupes against jobs still held in its completed set — so if someone tightens
 * a schedule (daily → every six hours) and leaves the bucket at 24 h, three
 * of every four runs become no-ops. Nothing errors. The dashboard shows a
 * scheduled job completing on time. It simply stops doing anything, and a sync
 * that never runs is indistinguishable from a sync with nothing to do.
 *
 * The unit tests in `tests/unit/jobs-fan-out.test.ts` prove the bucket
 * arithmetic. This proves the bucket chosen at each call site still matches the
 * schedule that call site actually runs on — which is the half that decays,
 * because the two live in different files and nothing links them.
 *
 * Deliberately one-directional: a bucket SHORTER than the period is allowed. It
 * only means fewer duplicates are caught, which is the pre-fix behaviour and
 * harmless. Coarser is the failure.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const JOBS = path.join(ROOT, 'src/app-layer/jobs');

const HOUR_MS = 3_600_000;

/** Bucket constant name → milliseconds. Mirrors `fan-out.ts`. */
const BUCKET_MS: Record<string, number> = {
    DAILY_BUCKET_MS: 24 * HOUR_MS,
    FOUR_HOURLY_BUCKET_MS: 4 * HOUR_MS,
};

/**
 * The dispatcher schedule ▸ the file whose `dispatchJobId` calls it governs.
 *
 * Keyed by the SCHEDULED_JOBS name so a renamed or deleted schedule fails here
 * rather than silently dropping a row from the check.
 */
const DISPATCHERS: ReadonlyArray<{ schedule: string; file: string }> = [
    { schedule: 'identity-sync-dispatch', file: 'identity-sync.ts' },
    { schedule: 'hris-sync-dispatch', file: 'hris-sync.ts' },
    { schedule: 'cloud-posture-collect-dispatch', file: 'cloud-posture-collect-dispatch.ts' },
    { schedule: 'sharepoint-delta-sync-dispatch', file: 'sharepoint-delta-sync.ts' },
    {
        schedule: 'compliance-posture-summary-dispatch',
        file: 'compliance-posture-summary.ts',
    },
];

/**
 * Shortest interval between two firings of a 5-field cron, in ms.
 *
 * Only the shapes this repo's schedules actually use: `*` and `*<slash>N` in the
 * hour field, and a fixed hour (daily). Anything else throws rather than
 * guessing — a silently-wrong period would defeat the whole check.
 */
function cronPeriodMs(pattern: string): number {
    const parts = pattern.trim().split(/\s+/);
    if (parts.length !== 5) throw new Error(`unsupported cron arity: "${pattern}"`);
    const [minute, hour, dom, month, dow] = parts;

    if (dom !== '*' || month !== '*' || dow !== '*') {
        throw new Error(`unsupported cron (non-daily fields): "${pattern}"`);
    }

    // The MINUTE field first. Skipping it was a real bug in the first draft of
    // this parser: it reported "*<slash>15 * * * *" as hourly, four times longer
    // than the truth — and over-reporting the period is precisely the direction
    // that lets a too-coarse bucket pass this guard. Its own sanity case caught
    // it, which is the reason that case exists.
    const MINUTE_MS = 60_000;
    if (minute === '*') return MINUTE_MS;
    const everyMin = /^\*\/(\d+)$/.exec(minute);
    if (everyMin) return Number(everyMin[1]) * MINUTE_MS;
    if (!/^\d+$/.test(minute)) {
        throw new Error(`unsupported cron minute field: "${pattern}"`);
    }

    // Fixed minute — the period is then set by the hour field.
    if (/^\d+$/.test(hour)) return 24 * HOUR_MS; // fixed hour → once a day
    if (hour === '*') return HOUR_MS;
    const everyHour = /^\*\/(\d+)$/.exec(hour);
    if (everyHour) return Number(everyHour[1]) * HOUR_MS;

    throw new Error(`unsupported cron hour field: "${pattern}"`);
}

function readSchedulePattern(schedulesSrc: string, name: string): string {
    const at = schedulesSrc.indexOf(`name: '${name}'`);
    if (at === -1) throw new Error(`schedule "${name}" not found in SCHEDULED_JOBS`);
    // Search forward from the name to that entry's own pattern.
    const m = /pattern:\s*'([^']+)'/.exec(schedulesSrc.slice(at));
    if (!m) throw new Error(`no pattern found for schedule "${name}"`);
    return m[1];
}

/** Bucket constants named in `dispatchJobId(...)` calls within a file. */
function bucketsUsedIn(src: string): string[] {
    const found = new Set<string>();
    // dispatchJobId(<job>, <key>, BUCKET_CONST) — the constant is the 3rd arg,
    // and the calls are formatted across lines, so match on the constant names
    // we know rather than trying to parse arguments.
    for (const name of Object.keys(BUCKET_MS)) {
        if (new RegExp(`\\b${name}\\b`).test(src)) found.add(name);
    }
    return [...found];
}

const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('fan-out dedupe bucket vs cron period', () => {
    const schedulesSrc = fs.readFileSync(path.join(JOBS, 'schedules.ts'), 'utf8');

    it('sanity — the cron parser agrees with known patterns', () => {
        // A parser that silently returned one number for everything would make
        // every assertion below vacuous.
        expect(cronPeriodMs('0 3 * * *')).toBe(24 * HOUR_MS);
        expect(cronPeriodMs('0 */4 * * *')).toBe(4 * HOUR_MS);
        expect(cronPeriodMs('30 5 * * *')).toBe(24 * HOUR_MS);
        expect(cronPeriodMs('0 * * * *')).toBe(HOUR_MS);
        // Sub-hourly must NOT be reported as hourly. Over-reporting the period
        // is the direction that lets a too-coarse bucket through this guard.
        expect(cronPeriodMs('*/15 * * * *')).toBe(15 * 60_000);
        expect(cronPeriodMs('* * * * *')).toBe(60_000);
        expect(() => cronPeriodMs('0 3 1 * *')).toThrow();
        expect(() => cronPeriodMs('0 3 * * 1')).toThrow();
        expect(() => cronPeriodMs('bad')).toThrow();
    });

    it.each(DISPATCHERS)(
        '$schedule — bucket is no coarser than its cron period',
        ({ schedule, file }) => {
            const period = cronPeriodMs(readSchedulePattern(schedulesSrc, schedule));
            const src = stripComments(fs.readFileSync(path.join(JOBS, file), 'utf8'));
            const buckets = bucketsUsedIn(src);

            expect(buckets.length).toBeGreaterThan(0);

            for (const name of buckets) {
                // Coarser than the schedule means runs are silently swallowed.
                expect({ schedule, bucket: name, bucketMs: BUCKET_MS[name], period })
                    .toEqual({
                        schedule,
                        bucket: name,
                        bucketMs: expect.any(Number),
                        period,
                    });
                expect(BUCKET_MS[name]).toBeLessThanOrEqual(period);
            }
        },
    );

    it('every dispatcher actually passes a jobId', () => {
        // A fan-out that forgot the id looks completely normal until a retry
        // duplicates every sync.
        for (const { file } of DISPATCHERS) {
            const src = stripComments(fs.readFileSync(path.join(JOBS, file), 'utf8'));
            expect({ file, hasJobId: /jobId:\s*dispatchJobId\(/.test(src) }).toEqual({
                file,
                hasJobId: true,
            });
        }
    });

    it('every dispatcher routes its enqueues through fanOut', () => {
        // The isolation half. A bare `await enqueue(...)` in a loop is the shape
        // that lets one Redis blip drop every connection behind it.
        for (const { file } of DISPATCHERS) {
            const src = stripComments(fs.readFileSync(path.join(JOBS, file), 'utf8'));
            expect({ file, usesFanOut: /\bawait fanOut\(/.test(src) }).toEqual({
                file,
                usesFanOut: true,
            });
        }
    });

    it('the bucket table matches the constants fan-out.ts actually exports', () => {
        // This table is a copy, and a copy that drifts turns every comparison
        // above into a comparison against a stale number.
        const src = fs.readFileSync(path.join(JOBS, 'fan-out.ts'), 'utf8');
        expect(src).toMatch(/export const DAILY_BUCKET_MS = 24 \* HOUR_MS;/);
        expect(src).toMatch(/export const FOUR_HOURLY_BUCKET_MS = 4 \* HOUR_MS;/);
        expect(src).toMatch(/export const HOUR_MS = 3_600_000;/);
    });
});
