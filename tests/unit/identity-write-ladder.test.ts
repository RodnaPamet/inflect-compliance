/**
 * The ladder ordering, the predicate the clamp is enforced with, and the
 * translation every stored mode passes through.
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
 *
 * Since #2241 the file also covers the retirement of a rung, which is a second
 * way for a stored value and a shipped ladder to disagree — and one whose
 * failure direction is PERMISSIVE. See `coerceStoredMode` below.
 */
import {
    LADDER,
    RETIRED_MODES,
    coerceStoredMode,
    isAboveClamp,
    type IdentityWriteMode,
} from '@/lib/identity/write-ladder';
import { LEAVER_MAX_MODE } from '@/app-layer/usecases/identity-leaver-pass';

describe('the ladder ordering', () => {
    it('is weakest-first, and index IS the ordering', () => {
        expect(LADDER).toEqual(['DISABLED', 'DRY_RUN', 'AUTOMATIC']);
    });

    it('has no duplicates — a repeated rung would make indexOf lie', () => {
        expect(new Set(LADDER).size).toBe(LADDER.length);
    });

    it('holds no rung that is also listed as retired', () => {
        // The two lists are answers to opposite questions and a value in both
        // would make `coerceStoredMode` depend on the order of its own branches.
        for (const retired of Object.keys(RETIRED_MODES)) {
            expect(LADDER).not.toContain(retired);
        }
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
        expect(isAboveClamp('AUTOMATIC', 'DISABLED')).toBe(true);
        expect(isAboveClamp('DRY_RUN', 'DISABLED')).toBe(true);
    });

    it('equal is not above', () => {
        for (const m of LADDER) expect(isAboveClamp(m, m)).toBe(false);
    });

    it('every rung is below or equal to the top rung', () => {
        for (const m of LADDER) expect(isAboveClamp(m, 'AUTOMATIC')).toBe(false);
    });

    it('an unknown mode reads as NOT above — the permissive direction, and why coercion is upstream', () => {
        // Documented behaviour, pinned so it is a decision rather than an
        // accident: indexOf returns -1, which is not greater than any real
        // index. For a CEILING that is the safe direction — but it is the
        // UNSAFE one for a value that used to be a rung, because "not above the
        // clamp" is how the leaver pass spells "allowed to run".
        //
        // The retired rung is the live instance of that, so it is asserted with
        // the same words: PROPOSE would sail through this gate. Nothing here can
        // fix it — a ranking function cannot rank what it does not know — which
        // is precisely why `coerceStoredMode` runs at the read boundary, before
        // any of this is asked.
        expect(isAboveClamp('SUPERUSER' as IdentityWriteMode, 'AUTOMATIC')).toBe(false);
        expect(isAboveClamp('SUPERUSER' as IdentityWriteMode, 'DISABLED')).toBe(false);
        expect(isAboveClamp('PROPOSE' as IdentityWriteMode, LEAVER_MAX_MODE)).toBe(false);
    });
});

/**
 * The translation from what is IN THE COLUMN to what this build will act on.
 *
 * `IdentityWriteMode` in `prisma/schema/enums.prisma` still carries PROPOSE and
 * always will — dropping an enum value needs an `ALTER TYPE`, which breaks every
 * still-running old container in a rolling deploy. So the value outlives the
 * rung, and this is the only place that gets to decide what it means.
 */
describe('coerceStoredMode', () => {
    it('passes every live rung through unchanged', () => {
        for (const m of LADDER) expect(coerceStoredMode(m)).toBe(m);
    });

    it('reads a stored PROPOSE as DRY_RUN — the rung below, never the rung above', () => {
        // Downward, because that is a narrowing and narrowing is always allowed;
        // and to DRY_RUN specifically because it is what PROPOSE was failing to
        // be — the tenant was already getting no writes, and now gets the report.
        expect(coerceStoredMode('PROPOSE')).toBe('DRY_RUN');
    });

    it('never returns a value off the ladder, whatever it is handed', () => {
        for (const stored of ['PROPOSE', 'SUPERUSER', '', 'dry_run', 'AUTOMATIC ', null, undefined]) {
            expect(LADDER).toContain(coerceStoredMode(stored));
        }
    });

    it('does not treat inherited Object properties as retired rungs', () => {
        // `stored in RETIRED_MODES` walks the prototype chain, so these three
        // all "match" and the lookup returns an inherited Object.prototype
        // member — a FUNCTION handed back as an identity write mode. Asserted on
        // the RESULT rather than on the operator used, so any future rewrite of
        // the lookup has to keep the property.
        for (const key of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
            const coerced = coerceStoredMode(key);
            expect(typeof coerced).toBe('string');
            expect(coerced).toBe('DISABLED');
        }
    });

    it('fails CLOSED for anything it does not recognise, including absence', () => {
        // A retired rung has a known predecessor to fall back to. An unknown one
        // does not, and guessing at authority is the one thing this must not do.
        // No settings row at all is the same answer for the same reason.
        expect(coerceStoredMode('SUPERUSER')).toBe('DISABLED');
        expect(coerceStoredMode('dry_run')).toBe('DISABLED'); // case matters; a near-miss is a miss
        expect(coerceStoredMode(null)).toBe('DISABLED');
        expect(coerceStoredMode(undefined)).toBe('DISABLED');
        expect(coerceStoredMode('')).toBe('DISABLED');
    });

    it('leaves nothing that the clamp would then wave through', () => {
        // The property the whole function exists for, stated as the property
        // rather than as a list of inputs: whatever comes out is a rung the
        // ordering can actually rank, so `isAboveClamp` is never asked a
        // question it answers permissively by accident.
        for (const stored of [...Object.keys(RETIRED_MODES), 'SUPERUSER', 'nonsense']) {
            const coerced = coerceStoredMode(stored);
            expect(LADDER.indexOf(coerced)).toBeGreaterThanOrEqual(0);
        }
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
        expect(permitted).toEqual(['DISABLED', 'DRY_RUN', 'AUTOMATIC']);
    });
});
