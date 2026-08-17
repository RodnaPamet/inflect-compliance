/**
 * Fan-out idempotency + failure isolation.
 *
 * The two defects compound, which is why they are fixed together: an
 * un-isolated fan-out throws partway through, BullMQ retries the dispatcher,
 * and without a deterministic id the retry re-queues everything that already
 * succeeded in order to reach the connections it never got to.
 *
 * The assertions that matter most are about the BUCKET, because getting it
 * wrong fails in the silent direction — an id that outlives its schedule
 * interval makes the next legitimate run a no-op, and a sync that stops running
 * looks exactly like a sync with nothing to do.
 */
import {
    dispatchJobId,
    fanOut,
    DAILY_BUCKET_MS,
    FOUR_HOURLY_BUCKET_MS,
    HOUR_MS,
} from '@/app-layer/jobs/fan-out';

const T = (iso: string) => Date.parse(iso);

describe('dispatchJobId', () => {
    it('is stable within one bucket, so a dispatcher retry dedupes', async () => {
        const a = dispatchJobId('identity-sync', 'conn-1', DAILY_BUCKET_MS, T('2026-08-17T03:00:00Z'));
        const b = dispatchJobId('identity-sync', 'conn-1', DAILY_BUCKET_MS, T('2026-08-17T23:59:59Z'));
        expect(a).toBe(b);
    });

    it('CHANGES at the next bucket, so tomorrow actually runs', async () => {
        // The failure this prevents is not a duplicate — it is a sync that
        // silently never runs again, because BullMQ dedupes against jobs still
        // held in the completed set.
        const today = dispatchJobId('identity-sync', 'conn-1', DAILY_BUCKET_MS, T('2026-08-17T23:59:59Z'));
        const tomorrow = dispatchJobId('identity-sync', 'conn-1', DAILY_BUCKET_MS, T('2026-08-18T00:00:00Z'));
        expect(tomorrow).not.toBe(today);
    });

    it('rolls the daily bucket at UTC midnight, matching the cron', () => {
        const before = dispatchJobId('j', 'k', DAILY_BUCKET_MS, T('2026-08-17T23:59:59.999Z'));
        const after = dispatchJobId('j', 'k', DAILY_BUCKET_MS, T('2026-08-18T00:00:00.000Z'));
        expect(before).not.toBe(after);
    });

    it('rolls the 4-hourly bucket on the 4-hour marks', () => {
        // `0 */4 * * *` fires at 00/04/08/12/16/20 UTC. The bucket must roll on
        // those same boundaries or a run lands in the previous slot's id.
        const slot1 = dispatchJobId('sp', 'c', FOUR_HOURLY_BUCKET_MS, T('2026-08-17T03:59:59Z'));
        const slot2 = dispatchJobId('sp', 'c', FOUR_HOURLY_BUCKET_MS, T('2026-08-17T04:00:00Z'));
        const slot2b = dispatchJobId('sp', 'c', FOUR_HOURLY_BUCKET_MS, T('2026-08-17T07:59:59Z'));
        expect(slot1).not.toBe(slot2);
        expect(slot2).toBe(slot2b);
    });

    it('a 4-hourly job under a DAILY bucket would collapse six runs into one', () => {
        // Written as a live demonstration rather than prose, because this is the
        // exact mistake the SharePoint dispatcher invites.
        const runs = ['00', '04', '08', '12', '16', '20'].map((h) =>
            dispatchJobId('sp', 'c', DAILY_BUCKET_MS, T(`2026-08-17T${h}:00:00Z`)),
        );
        expect(new Set(runs).size).toBe(1); // ← five silent no-ops

        const correct = ['00', '04', '08', '12', '16', '20'].map((h) =>
            dispatchJobId('sp', 'c', FOUR_HOURLY_BUCKET_MS, T(`2026-08-17T${h}:00:00Z`)),
        );
        expect(new Set(correct).size).toBe(6);
    });

    it('separates jobs and keys', () => {
        const now = T('2026-08-17T03:00:00Z');
        expect(dispatchJobId('a', 'k', DAILY_BUCKET_MS, now)).not.toBe(
            dispatchJobId('b', 'k', DAILY_BUCKET_MS, now),
        );
        expect(dispatchJobId('a', 'k1', DAILY_BUCKET_MS, now)).not.toBe(
            dispatchJobId('a', 'k2', DAILY_BUCKET_MS, now),
        );
    });

    it('rejects a nonsense bucket instead of producing a degenerate id', () => {
        // Math.floor(now / 0) is Infinity — every call would collide, which is
        // the "never runs again" failure with no visible cause.
        expect(() => dispatchJobId('a', 'k', 0)).toThrow(/positive/);
        expect(() => dispatchJobId('a', 'k', -HOUR_MS)).toThrow(/positive/);
        expect(() => dispatchJobId('a', 'k', NaN)).toThrow(/positive/);
    });
});

describe('fanOut', () => {
    const describeItem = (i: { id: string }) => ({ connectionId: i.id });
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

    it('keeps going after a failure instead of dropping the rest', async () => {
        // The old loop aborted here, so every connection after the bad one was
        // silently never dispatched — and the completion log still read clean.
        const seen: string[] = [];
        const r = await fanOut(items, 'test', describeItem, async (i) => {
            seen.push(i.id);
            if (i.id === 'a') throw new Error('redis unreachable');
        });

        expect(seen).toEqual(['a', 'b', 'c']);
        expect(r).toEqual({ dispatched: 2, failed: 1 });
    });

    it('counts a clean run', async () => {
        const r = await fanOut(items, 'test', describeItem, async () => undefined);
        expect(r).toEqual({ dispatched: 3, failed: 0 });
    });

    it('reports total failure distinguishably from an empty run', async () => {
        // The caller fails the job on (failed > 0 && dispatched === 0); an empty
        // input is a legitimately clean no-op and must not look the same.
        const allFailed = await fanOut(items, 'test', describeItem, async () => {
            throw new Error('down');
        });
        expect(allFailed).toEqual({ dispatched: 0, failed: 3 });

        const empty = await fanOut([], 'test', describeItem, async () => undefined);
        expect(empty).toEqual({ dispatched: 0, failed: 0 });
    });

    it('survives a non-Error throw', async () => {
        const r = await fanOut([{ id: 'a' }], 'test', describeItem, async () => {
            throw 'a string';
        });
        expect(r).toEqual({ dispatched: 0, failed: 1 });
    });
});
