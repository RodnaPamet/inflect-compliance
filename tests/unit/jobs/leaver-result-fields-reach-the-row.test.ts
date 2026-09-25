/**
 * Computing a fact and durably recording it are two different things (#2895).
 *
 * Two of this repo's own fixes were verified at both ends and inert in the
 * middle. #2870 added `requestedByUserId` to the leaver payload and threaded it
 * through the route and the job; the executor between them kept naming two
 * fields, so every manual run still recorded `triggeredBy: 'scheduled'`. #2885
 * computed a write-readiness verdict and returned it; the executor persisted
 * four fields and never that one, so the verdict reached no operator artefact.
 * Both had passing tests — of the route, and of the usecase. Nothing walked the
 * chain, and the chain was where both broke.
 *
 * So this suite executes the REAL executor and the REAL job layer, and mocks
 * only the leaf usecase. What it asserts is traversal, not shape: a value put
 * in at the route seam comes out at the pass, and a value returned by the pass
 * comes out in the row.
 */
import { executorRegistry } from '@/app-layer/jobs/executor-registry';
import {
    LEAVER_RESULT_DISPOSITION,
    type LeaverPassResult,
    type ResultFieldDisposition,
} from '@/app-layer/usecases/identity-leaver-pass';
import type { NamesEveryField } from '@/app-layer/jobs/types';

const mockRunPass = jest.fn();

jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {} }));
jest.mock('@/app-layer/jobs/queue', () => ({ enqueue: jest.fn() }));

// Mocked at ONE function, over a `requireActual` spread, deliberately.
//
// A subset mock of this module would drop the other thirteen exports —
// including `LEAVER_RESULT_DISPOSITION`, the map every assertion below reads.
// The suite would then compare against `undefined`, and `Object.keys(undefined)`
// throws where it is lucky and yields an empty set where it is not: an empty
// expected-set makes every "each declared field is persisted" assertion pass
// over nothing at all. That is #2897's fourth instance in miniature.
jest.mock('@/app-layer/usecases/identity-leaver-pass', () => ({
    ...jest.requireActual('@/app-layer/usecases/identity-leaver-pass'),
    runIdentityLeaverPass: (...args: unknown[]) => mockRunPass(...args),
}));

const JOB = 'identity-leaver-pass';

/**
 * Every field a pass can return, each with a value distinguishable from every
 * other, so an assertion cannot pass on a field that merely EXISTS.
 *
 * Typed `NamesEveryField` rather than `LeaverPassResult`: the optional members
 * are exactly the ones that were being dropped, and a fixture allowed to omit
 * them could not detect that.
 */
const FULL_RESULT: NamesEveryField<LeaverPassResult> = {
    status: 'PARTIAL',
    mode: 'AUTOMATIC',
    refusal: 'MODE_ABOVE_CLAMP',
    detail: 'fixture refusal detail',
    counts: { DISABLED: 2, REFUSED_MODE: 1 },
    terminatedWorkers: 3,
    candidates: 5,
    population: 9,
    batchRefused: 'fixture batch refusal',
    errorMessage: 'fixture error message',
    writeReadiness: { readiness: 'DEDICATED_WRITE_BIND', detail: 'fixture readiness detail' },
};

/**
 * The map, widened to the declared union.
 *
 * `as const satisfies` narrows each value to the literal actually written, so
 * the source type today is `'details' | 'outcome' | 'positional'` — the
 * `notPersisted` arm is absent because no field uses it yet. Widening HERE, by
 * assignment to the exported union, lets this suite reason about that arm
 * without weakening the narrowing the source relies on.
 */
const DISPOSITIONS: Record<string, ResultFieldDisposition> = LEAVER_RESULT_DISPOSITION;

const declared = (kind: 'details' | 'outcome' | 'positional') =>
    Object.entries(DISPOSITIONS)
        .filter(([, d]) => d === kind)
        .map(([k]) => k);

describe('a leaver pass result reaches the durable row', () => {
    beforeEach(() => {
        mockRunPass.mockReset();
        mockRunPass.mockResolvedValue(FULL_RESULT);
    });

    it('drives the real executor, not a stand-in', () => {
        expect(executorRegistry.has(JOB)).toBe(true);
    });

    // ─── the map itself ───

    it('the disposition map covers every field a result can carry', () => {
        // The `satisfies` clause pins this at compile time; this pins it again
        // against a value, which is what survives a stray `any` upstream.
        expect(Object.keys(LEAVER_RESULT_DISPOSITION).sort()).toEqual(
            Object.keys(FULL_RESULT).sort(),
        );
        // A map of nothing would satisfy every assertion below it.
        expect(declared('details').length).toBeGreaterThan(0);
    });

    it('pins the readiness verdict as durable, so it cannot be reclassified away', () => {
        // Without this, the cheapest way to silence a failing durability check
        // is to move the field to `notPersisted` and delete it from the row —
        // which passes every loop below while reintroducing the exact #2885
        // defect. The verdict is the reason the map exists; it is not
        // reclassifiable without deleting this line and saying why.
        expect(LEAVER_RESULT_DISPOSITION.writeReadiness).toBe('details');
    });

    it('makes every deliberate omission carry a real reason', () => {
        // A type PREDICATE, not a cast: `as const satisfies` narrows each
        // value to a literal, so casting a narrowed string literal to the
        // object arm is the error TS2352 exists to report — and this repo caps
        // `as any` escapes at zero, correctly.
        const omitted = Object.entries(DISPOSITIONS).filter(
            (entry): entry is [string, { readonly notPersisted: string }] =>
                typeof entry[1] === 'object',
        );
        for (const [field, d] of omitted) {
            expect(typeof d.notPersisted).toBe('string');
            expect(d.notPersisted.trim().length).toBeGreaterThan(0);
            expect(field).not.toBe('writeReadiness');
        }
    });

    // ─── in: route → executor → job → pass ───

    it('carries a named requester through the executor to the pass', async () => {
        await executorRegistry.execute(JOB, {
            tenantId: 't-1',
            provider: 'entra-id',
            requestedByUserId: 'user-42',
        });

        expect(mockRunPass).toHaveBeenCalledTimes(1);
        expect(mockRunPass.mock.calls[0][0]).toEqual(
            expect.objectContaining({ requestedByUserId: 'user-42' }),
        );
    });

    it('leaves the requester absent for a genuine schedule', async () => {
        await executorRegistry.execute(JOB, { tenantId: 't-1', provider: 'entra-id' });

        // Absent, not invented. "Scheduled" is only honest when the unattended
        // path genuinely has no requester to name.
        expect(mockRunPass.mock.calls[0][0]).toEqual(
            expect.objectContaining({ requestedByUserId: undefined }),
        );
    });

    // ─── out: pass → executor → row ───

    it('persists every field the map marks durable', async () => {
        const result = await executorRegistry.execute(JOB, {
            tenantId: 't-1',
            provider: 'entra-id',
        });
        const details = result.details ?? {};

        for (const field of declared('details')) {
            expect(Object.keys(details)).toContain(field);
            expect(details[field]).toEqual(FULL_RESULT[field as keyof LeaverPassResult]);
        }
    });

    it('keeps a deliberately omitted field genuinely out of the row', async () => {
        // No field is marked `notPersisted` today, so this loop runs over an
        // empty set — and an empty selection is a PASS, which is worth saying
        // out loud rather than discovering later. It is not dead weight: the
        // mutation that reclassifies the readiness verdict to `notPersisted`
        // while the executor still writes it reddens exactly here, which is the
        // only assertion that catches a map telling the opposite lie.
        const result = await executorRegistry.execute(JOB, {
            tenantId: 't-1',
            provider: 'entra-id',
        });
        const omitted = Object.entries(DISPOSITIONS)
            .filter(([, d]) => typeof d === 'object')
            .map(([k]) => k);

        for (const field of omitted) {
            expect(Object.keys(result.details ?? {})).not.toContain(field);
        }
    });

    it('carries the write-readiness verdict itself, not merely its key', async () => {
        // Named separately because this is the field #2885 believed it had
        // landed. A loop over the map would report it as one of many; an
        // operator reading a row during an incident reads exactly this.
        const result = await executorRegistry.execute(JOB, {
            tenantId: 't-1',
            provider: 'entra-id',
        });

        expect(result.details?.writeReadiness).toEqual({
            readiness: 'DEDICATED_WRITE_BIND',
            detail: 'fixture readiness detail',
        });
    });

    it('keeps the outcome fields out of the details blob', async () => {
        const result = await executorRegistry.execute(JOB, {
            tenantId: 't-1',
            provider: 'entra-id',
        });

        expect(declared('outcome')).toEqual(expect.arrayContaining(['status', 'errorMessage']));
        for (const field of declared('outcome')) {
            expect(Object.keys(result.details ?? {})).not.toContain(field);
        }
    });

    it('treats PARTIAL as a success and does not surface a message at that status', async () => {
        // `makeResult` carries `errorMessage` only when the status is ERROR, and
        // that gate matches the usecase: the single site that sets a message
        // (`identity-leaver-pass.ts:1313`) returns `status: 'ERROR'` beside it,
        // so PARTIAL-with-a-message is unreachable rather than dropped. Asserted
        // rather than assumed, because the pairing is what makes the gate safe
        // and nothing else in the file states it.
        const result = await executorRegistry.execute(JOB, {
            tenantId: 't-1',
            provider: 'entra-id',
        });

        expect(result.success).toBe(true); // PARTIAL is a real pass, not a failure
        expect(result.errorMessage).toBeUndefined();
    });

    it('carries the message out on the ERROR arm, where the pass actually sets one', async () => {
        mockRunPass.mockResolvedValue({ ...FULL_RESULT, status: 'ERROR' });

        const result = await executorRegistry.execute(JOB, {
            tenantId: 't-1',
            provider: 'entra-id',
        });

        expect(result.success).toBe(false);
        expect(result.errorMessage).toBe('fixture error message');
    });

    it('counts the population positionally rather than burying it', async () => {
        const result = await executorRegistry.execute(JOB, {
            tenantId: 't-1',
            provider: 'entra-id',
        });

        expect(declared('positional')).toContain('candidates');
        expect(result.itemsScanned).toBe(FULL_RESULT.candidates);
        expect(result.itemsActioned).toBe(FULL_RESULT.counts.DISABLED);
    });
});
