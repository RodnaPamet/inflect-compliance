/**
 * The ladder ordering, and the predicate the clamp is enforced with.
 *
 * WHY THIS FILE EXISTS. The ordering was encoded three times — a private
 * `LADDER` in the policy usecase, a verbatim copy in `WriteLadderClient.tsx`,
 * and, in the leaver pass, not at all: it tested `mode !== LEAVER_MAX_MODE`.
 * Those three agreed only while the clamp sat at the second rung, so nothing
 * ever disagreed and no test could have caught it.
 *
 * Raising the clamp is exactly the change that breaks the coincidence, in the
 * dangerous direction: `DRY_RUN !== AUTOMATIC` is true, so the inequality would
 * have refused a tenant BELOW the ceiling — and `MODE_ABOVE_CLAMP` records no
 * execution row, so the live dry run would have stopped dead behind a blank
 * page.
 */
import { LADDER, isAboveClamp, type IdentityWriteMode } from '@/lib/identity/write-ladder';
import { LEAVER_MAX_MODE } from '@/app-layer/usecases/identity-leaver-pass';

describe('the ladder ordering', () => {
    it('is weakest-first, and index IS the ordering', () => {
        expect(LADDER).toEqual(['DISABLED', 'DRY_RUN', 'PROPOSE', 'AUTOMATIC']);
    });

    it('has no duplicates — a repeated rung would make indexOf lie', () => {
        expect(new Set(LADDER).size).toBe(LADDER.length);
    });
});

describe('isAboveClamp', () => {
    it('is ordinal, not inequality — the distinction the clamp raise turns on', () => {
        // The exact case that would have killed the live dry run. Not equal,
        // but below, and therefore allowed.
        expect(isAboveClamp('DRY_RUN', 'AUTOMATIC')).toBe(false);
        expect('DRY_RUN' !== ('AUTOMATIC' as string)).toBe(true); // what the old gate saw
    });

    it('reports above only when it IS above', () => {
        expect(isAboveClamp('AUTOMATIC', 'DRY_RUN')).toBe(true);
        expect(isAboveClamp('PROPOSE', 'DRY_RUN')).toBe(true);
        expect(isAboveClamp('DRY_RUN', 'DISABLED')).toBe(true);
    });

    it('equal is not above', () => {
        for (const m of LADDER) expect(isAboveClamp(m, m)).toBe(false);
    });

    it('every rung is below or equal to the top rung', () => {
        for (const m of LADDER) expect(isAboveClamp(m, 'AUTOMATIC')).toBe(false);
    });

    it('an unknown mode reads as NOT above — safe, and not a substitute for validation', () => {
        // Documented behaviour, pinned so it is a decision rather than an
        // accident: indexOf returns -1, which is not greater than any real
        // index. It fails toward "not above", which is the safe direction for a
        // CEILING — but it means the clamp cannot reject an unrecognised mode,
        // and the caller must. The pass handles DISABLED explicitly before
        // asking, and `describeRefusal` rejects an unknown mode at the write.
        expect(isAboveClamp('SUPERUSER' as IdentityWriteMode, 'AUTOMATIC')).toBe(false);
        expect(isAboveClamp('SUPERUSER' as IdentityWriteMode, 'DISABLED')).toBe(false);
    });
});

describe('the leaver clamp', () => {
    it('is a real rung on the ladder', () => {
        // A clamp that is not on the ladder would make every comparison against
        // it read as -1, i.e. nothing is ever above it — the gate would be
        // silently inert rather than loudly wrong.
        expect(LADDER).toContain(LEAVER_MAX_MODE);
    });

    it('admits every rung at or below it, and that is the whole change', () => {
        const permitted = LADDER.filter((m) => !isAboveClamp(m, LEAVER_MAX_MODE));
        expect(permitted).toEqual(['DISABLED', 'DRY_RUN', 'PROPOSE', 'AUTOMATIC']);
    });
});
