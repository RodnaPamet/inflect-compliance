/**
 * #2687 item 4 — the off-schedule joiner run trigger.
 *
 * The thing worth pinning is NOT that a POST enqueues. It is that the manual
 * id cannot be swallowed by the id of the run it is re-running, which is the
 * defect this route exists to remove. Inheriting `DAILY_BUCKET_MS` would
 * reproduce it exactly while looking like a working button.
 */
import { POST, MANUAL_JOINER_PASS_JOB_KEY } from '@/app/api/t/[tenantSlug]/admin/identity-joiner-passes/run/route';
import { dispatchJobId, MINUTE_MS, DAILY_BUCKET_MS } from '@/app-layer/jobs/fan-out';

type EnqueueArgs = [string, { tenantId: string; provider: string }, { jobId: string }];
type LogEventArgs = [
    unknown,
    unknown,
    { action: string; metadata: { provider: string; jobId: string; trigger: string } },
];
const enqueue = jest.fn(async (..._a: EnqueueArgs) => ({ id: 'job-1' }));
const logEvent = jest.fn(async (..._a: LogEventArgs) => undefined);

jest.mock('@/app-layer/jobs/queue', () => ({ enqueue: (...a: unknown[]) => enqueue(...(a as unknown as EnqueueArgs)) }));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: (...a: unknown[]) => logEvent(...(a as unknown as LogEventArgs)) }));
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {} }));
jest.mock('@/lib/security/permission-middleware', () => ({
    requirePermission: (key: string, handler: never) => {
        (handler as unknown as { __permission?: string }).__permission = key;
        return async (req: unknown) =>
            (handler as unknown as (r: unknown, p: unknown, c: unknown) => unknown)(
                req,
                { tenantSlug: 't' },
                { tenantId: 'tenant-1', userId: 'user-1' },
            );
    },
}));
jest.mock('@/lib/errors/api', () => ({ withApiErrorHandling: (h: unknown) => h }));

function post(body: unknown) {
    return { json: async () => body } as never;
}
/** POST's signature is (req, routeArgs); the mocked middleware ignores the second. */
const call = (body: unknown) => (POST as unknown as (r: unknown, a: unknown) => Promise<unknown>)(post(body), {});

beforeEach(() => jest.clearAllMocks());

describe('the manual id cannot collide with the scheduled one', () => {
    it('uses the MINUTE bucket, not the daily bucket the dispatcher uses', async () => {
        await call({ provider: 'entra-id' });
        const opts = enqueue.mock.calls[0][2];

        const minute = dispatchJobId(MANUAL_JOINER_PASS_JOB_KEY, 'tenant-1:entra-id', MINUTE_MS);
        const daily = dispatchJobId(MANUAL_JOINER_PASS_JOB_KEY, 'tenant-1:entra-id', DAILY_BUCKET_MS);

        expect(opts.jobId).toBe(minute);
        // The discriminator: the two buckets genuinely differ, so "matches the
        // minute bucket" is not vacuously also "matches the daily one".
        expect(minute).not.toBe(daily);
    });

    it('uses its OWN job-name prefix, so a manual id can never be a scheduled id', async () => {
        await call({ provider: 'entra-id' });
        const opts = enqueue.mock.calls[0][2];
        expect(MANUAL_JOINER_PASS_JOB_KEY).toBe('identity-joiner-pass-manual');
        expect(opts.jobId).toContain('identity-joiner-pass-manual');
        // The enqueued JOB is still the scheduled one — only the dedupe
        // namespace differs, because a manual run that behaved differently
        // would prove something other than what runs at 04:30.
        expect(enqueue.mock.calls[0][0]).toBe('identity-joiner-pass');
    });
});

describe('what it enqueues is exactly the scheduled path', () => {
    it('passes the scheduled payload plus the requester, and nothing else', async () => {
        // This said "tenantId and provider, and nothing else" and used an
        // exact-match assertion, so it pinned the ABSENCE of a requester —
        // the same shape that made #2884's denominator test block the fix for
        // the defect it was guarding.
        //
        // The intent it was written for is intact and is the comment above:
        // the manual run must do the same WORK as 04:30, or it proves
        // something other than what runs then. What differs is the
        // attribution, which is the whole reason the button needed a fix.
        await call({ provider: 'entra-id' });

        expect(enqueue.mock.calls[0][1]).toEqual({
            tenantId: 'tenant-1',
            provider: 'entra-id',
            requestedByUserId: 'user-1',
        });
    });

    it('carries a REAL user id, not a flag', async () => {
        // `IdentityWriteJournal.actorUserId` and the execution row both need
        // an id to be joinable on. A bare 'manual' marker would satisfy the
        // execution row and leave the journal exactly as unattributable as
        // before.
        await call({ provider: 'entra-id' });

        // Narrowed at the read rather than widening `EnqueueArgs`: that type
        // describes the SCHEDULED payload on purpose, and loosening it would
        // stop the other assertions in this file from noticing a stray field.
        const payload = enqueue.mock.calls[0][1] as { requestedByUserId?: string };
        const requester = payload.requestedByUserId;
        expect(typeof requester).toBe('string');
        expect(requester).not.toBe('manual');
        expect(requester).not.toBe('system');
    });

    it('rejects an unknown provider rather than enqueueing it', async () => {
        await expect(call({ provider: 'not-a-directory' })).rejects.toBeDefined();
        expect(enqueue).not.toHaveBeenCalled();
    });

    it('rejects an unexpected body field — the schema is strict', async () => {
        await expect(call({ provider: 'entra-id', mode: 'AUTOMATIC' })).rejects.toBeDefined();
        expect(enqueue).not.toHaveBeenCalled();
    });
});

describe('the request is recorded before the worker does anything', () => {
    it('writes an audit row naming the requester, the provider and the job', async () => {
        await call({ provider: 'entra-id' });
        expect(logEvent).toHaveBeenCalledTimes(1);
        const ev = logEvent.mock.calls[0][2];
        expect(ev.action).toBe('IDENTITY_JOINER_PASS_REQUESTED');
        expect(ev.metadata.trigger).toBe('manual');
        expect(ev.metadata.provider).toBe('entra-id');
        // This row survives a worker that never runs; the pass's own execution
        // row does not exist until something picks the job up.
        expect(ev.metadata.jobId).toBeTruthy();
    });
});
