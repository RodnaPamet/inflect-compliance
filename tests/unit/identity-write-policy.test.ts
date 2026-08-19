/**
 * The gate that decides whether this product may ever write to a customer's
 * identity directory.
 *
 * Every other integration reads. This is the first that will disable or create
 * real accounts, and the two directions carry different risk — so they are
 * configured separately, and each climbs DISABLED → DRY_RUN → PROPOSE →
 * AUTOMATIC rather than flipping on.
 *
 * The ladder exists because the Workday status normalisation driving all of this
 * has never run against a real tenant. A mapping bug is invisible until it acts
 * on a person. DRY_RUN is where it surfaces.
 */
import { describeRefusal, DRY_RUN_MIN_DAYS } from '@/app-layer/usecases/identity-write-policy';

const NOW = new Date('2026-08-19T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe('the ladder cannot be skipped', () => {
    it('refuses DISABLED straight to AUTOMATIC', () => {
        // The whole point. Enabling unattended account disablement the same
        // afternoon you enable the feature is how a wrong status mapping locks
        // out an entire company before anyone reads a log.
        const why = describeRefusal({ mode: 'DISABLED', dryRunSince: null }, 'AUTOMATIC', NOW);
        expect(why).toMatch(/one step/i);
        expect(why).toMatch(/DISABLED → DRY_RUN → PROPOSE → AUTOMATIC/);
    });

    it('refuses DISABLED straight to PROPOSE', () => {
        expect(describeRefusal({ mode: 'DISABLED', dryRunSince: null }, 'PROPOSE', NOW)).toMatch(/one step/i);
    });

    it('allows one rung at a time', () => {
        expect(describeRefusal({ mode: 'DISABLED', dryRunSince: null }, 'DRY_RUN', NOW)).toBeNull();
    });

    it('names the path in the refusal, not just the fact of it', () => {
        // An operator who is told "no" without being told the route will try
        // the same thing again, or conclude the feature is broken.
        const why = describeRefusal({ mode: 'DRY_RUN', dryRunSince: daysAgo(99) }, 'AUTOMATIC', NOW);
        expect(why).toContain('DRY_RUN → PROPOSE → AUTOMATIC');
    });
});

describe('dry-run is time-boxed, and the clock is real', () => {
    it('refuses to widen before the window elapses, and says how long is left', () => {
        const why = describeRefusal({ mode: 'DRY_RUN', dryRunSince: daysAgo(2) }, 'PROPOSE', NOW);
        expect(why).toMatch(/2 of 7 required days/);
        expect(why).toMatch(/5 more/);
    });

    it('allows widening once the window has elapsed', () => {
        expect(
            describeRefusal({ mode: 'DRY_RUN', dryRunSince: daysAgo(DRY_RUN_MIN_DAYS + 1) }, 'PROPOSE', NOW),
        ).toBeNull();
    });

    it('refuses when DRY_RUN has no recorded start rather than treating it as elapsed', () => {
        // A null start must not read as "infinitely long ago". Absent evidence
        // of observation is not evidence of observation.
        expect(describeRefusal({ mode: 'DRY_RUN', dryRunSince: null }, 'PROPOSE', NOW)).toMatch(/no recorded start/i);
    });

    it('is measured in days, not runs', () => {
        // A tenant with a quiet week has observed nothing by running the job
        // seven times. The window exists to span a real termination/hire cycle.
        const almost = describeRefusal({ mode: 'DRY_RUN', dryRunSince: daysAgo(DRY_RUN_MIN_DAYS - 0.5) }, 'PROPOSE', NOW);
        expect(almost).toMatch(/required days/);
    });
});

describe('narrowing is never blocked', () => {
    it('allows AUTOMATIC straight back to DISABLED', () => {
        // Someone turning this off is reacting to something. A ladder that
        // slowed them down on the way OUT would be actively harmful — this is
        // the emergency stop.
        expect(describeRefusal({ mode: 'AUTOMATIC', dryRunSince: null }, 'DISABLED', NOW)).toBeNull();
    });

    it('allows PROPOSE back to DRY_RUN', () => {
        expect(describeRefusal({ mode: 'PROPOSE', dryRunSince: null }, 'DRY_RUN', NOW)).toBeNull();
    });

    it('does not apply the dry-run window when narrowing OUT of DRY_RUN', () => {
        // Two days into observation, deciding to stop, must not be refused for
        // not having observed enough.
        expect(describeRefusal({ mode: 'DRY_RUN', dryRunSince: daysAgo(2) }, 'DISABLED', NOW)).toBeNull();
    });
});

describe('no-op', () => {
    it('setting the mode it already has is allowed', () => {
        expect(describeRefusal({ mode: 'PROPOSE', dryRunSince: null }, 'PROPOSE', NOW)).toBeNull();
    });
});
