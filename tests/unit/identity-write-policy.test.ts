/**
 * The gate that decides whether this product may ever write to a customer's
 * identity directory.
 *
 * Every other integration reads. This is the first that will disable or create
 * real accounts, and the two directions carry different risk — so they are
 * configured separately, and each climbs DISABLED → DRY_RUN → AUTOMATIC rather
 * than flipping on.
 *
 * The ladder exists because the Workday status normalisation driving all of this
 * has never run against a real tenant. A mapping bug is invisible until it acts
 * on a person. DRY_RUN is where it surfaces.
 *
 * ═══ WHAT #2241 CHANGED, AND WHAT THESE TESTS NOW HAVE TO SHOW ═══
 *
 * There was a PROPOSE rung between DRY_RUN and AUTOMATIC. The dwell below fires
 * on `current.mode === 'DRY_RUN'` only, so it gated DRY_RUN → PROPOSE and
 * NOTHING gated PROPOSE → AUTOMATIC — while the one-rung rule made PROPOSE
 * compulsory on the way up. The mandatory rung was the ungated one, so the real
 * cost of unattended directory writes was seven days plus two PUTs, and the
 * second PUT could follow the first by a second.
 *
 * With the rung deleted, DRY_RUN → AUTOMATIC is a single move and the dwell is
 * in front of it. `there is no way to AUTOMATIC that skips the dwell` below
 * states that as a property over the whole ladder rather than as one transition,
 * because a transition-shaped test is what the old ladder passed.
 */
const settingsRow: { identityLeaverMode: string; identityJoinerMode: string } = {
    identityLeaverMode: 'DISABLED',
    identityJoinerMode: 'DISABLED',
};

const upsert = jest.fn(async (_args: unknown): Promise<unknown> => ({}));
const mockDb = {
    tenantSecuritySettings: {
        findUnique: jest.fn(async (_args: unknown): Promise<unknown> => ({
            ...settingsRow,
            identityLeaverDryRunSince: null,
            identityJoinerDryRunSince: null,
        })),
        upsert,
    },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(
        async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb),
    ),
}));
jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(async (): Promise<void> => undefined),
}));
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
    describeRefusal,
    getIdentityWritePolicy,
    setIdentityWriteMode,
    DRY_RUN_MIN_DAYS,
} from '@/app-layer/usecases/identity-write-policy';
import { DIRECTION_IMPLEMENTED, LADDER, type IdentityWriteMode } from '@/lib/identity/write-ladder';
import { makeRequestContext } from '../helpers/make-context';

const NOW = new Date('2026-08-19T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

beforeEach(() => {
    jest.clearAllMocks();
    settingsRow.identityLeaverMode = 'DISABLED';
    settingsRow.identityJoinerMode = 'DISABLED';
});

describe('the ladder cannot be skipped', () => {
    it('refuses DISABLED straight to AUTOMATIC', () => {
        // The whole point. Enabling unattended account disablement the same
        // afternoon you enable the feature is how a wrong status mapping locks
        // out an entire company before anyone reads a log.
        const why = describeRefusal('leaver', { mode: 'DISABLED', dryRunSince: null }, 'AUTOMATIC', NOW);
        expect(why).toMatch(/one step/i);
        // The path it names is the path that exists. A three-rung ladder that
        // still printed a four-rung route would be telling the operator to make
        // a PUT the API now rejects.
        expect(why).toMatch(/DISABLED → DRY_RUN → AUTOMATIC/);
        expect(why).not.toMatch(/PROPOSE/);
    });

    it('allows one rung at a time', () => {
        expect(describeRefusal('leaver', { mode: 'DISABLED', dryRunSince: null }, 'DRY_RUN', NOW)).toBeNull();
    });
});

describe('dry-run is time-boxed, and the clock is real', () => {
    it('refuses to widen before the window elapses, and says how long is left', () => {
        const why = describeRefusal('leaver', { mode: 'DRY_RUN', dryRunSince: daysAgo(2) }, 'AUTOMATIC', NOW);
        expect(why).toMatch(/2 of 7 required days/);
        expect(why).toMatch(/5 more/);
    });

    it('allows widening once the window has elapsed', () => {
        expect(
            describeRefusal('leaver', { mode: 'DRY_RUN', dryRunSince: daysAgo(DRY_RUN_MIN_DAYS + 1) }, 'AUTOMATIC', NOW),
        ).toBeNull();
    });

    it('refuses when DRY_RUN has no recorded start rather than treating it as elapsed', () => {
        // A null start must not read as "infinitely long ago". Absent evidence
        // of observation is not evidence of observation.
        expect(describeRefusal('leaver', { mode: 'DRY_RUN', dryRunSince: null }, 'AUTOMATIC', NOW)).toMatch(/no recorded start/i);
    });

    it('is measured in days, not runs', () => {
        // A tenant with a quiet week has observed nothing by running the job
        // seven times. The window exists to span a real termination/hire cycle.
        const almost = describeRefusal('leaver', { mode: 'DRY_RUN', dryRunSince: daysAgo(DRY_RUN_MIN_DAYS - 0.5) }, 'AUTOMATIC', NOW);
        expect(almost).toMatch(/required days/);
    });

    /**
     * THE SAFETY PROPERTY THE #2241 DELETION EXISTS TO CREATE.
     *
     * Stated over the whole ladder rather than as one transition, because a
     * per-transition test is exactly what the four-rung ladder passed: every
     * individual step looked gated or harmless, and the hole was in the
     * COMPOSITION of two of them. Written this way the assertion is
     * ladder-length independent — re-introduce any ungated rung below AUTOMATIC
     * and standing on it satisfies neither branch, so this goes red.
     */
    it('there is no way to AUTOMATIC that skips the dwell', () => {
        const reachedWithoutWaiting = LADDER.filter((from) => from !== 'AUTOMATIC').filter(
            (from) =>
                // A rung held with no dry-run window banked behind it. For
                // DRY_RUN itself, a window that is open but not yet elapsed.
                describeRefusal(
                    'leaver',
                    { mode: from, dryRunSince: from === 'DRY_RUN' ? daysAgo(DRY_RUN_MIN_DAYS - 1) : null },
                    'AUTOMATIC',
                    NOW,
                ) === null,
        );
        expect(reachedWithoutWaiting).toEqual([]);
    });

    it('and exactly one state DOES reach it — the gate is not a wall', () => {
        // The other half. A `describeRefusal` that refused everything would
        // satisfy the property above while making the product unusable, and the
        // seven days would never buy anybody anything.
        const reachedAfterWaiting = LADDER.filter((from) => from !== 'AUTOMATIC').filter(
            (from) =>
                describeRefusal(
                    'leaver',
                    { mode: from, dryRunSince: daysAgo(DRY_RUN_MIN_DAYS + 1) },
                    'AUTOMATIC',
                    NOW,
                ) === null,
        );
        expect(reachedAfterWaiting).toEqual(['DRY_RUN']);
    });
});

describe('narrowing is never blocked', () => {
    it('allows AUTOMATIC straight back to DISABLED', () => {
        // Someone turning this off is reacting to something. A ladder that
        // slowed them down on the way OUT would be actively harmful — this is
        // the emergency stop.
        expect(describeRefusal('leaver', { mode: 'AUTOMATIC', dryRunSince: null }, 'DISABLED', NOW)).toBeNull();
    });

    it('allows AUTOMATIC back to DRY_RUN', () => {
        expect(describeRefusal('leaver', { mode: 'AUTOMATIC', dryRunSince: null }, 'DRY_RUN', NOW)).toBeNull();
    });

    it('allows every backwards step on the ladder, from every rung', () => {
        // Stated as a sweep so that shortening the ladder cannot quietly drop a
        // case: the emergency stop has to work from wherever the tenant is
        // standing, including two rungs down in one move.
        for (const from of LADDER) {
            for (const to of LADDER.slice(0, LADDER.indexOf(from))) {
                expect(describeRefusal('leaver', { mode: from, dryRunSince: null }, to, NOW)).toBeNull();
            }
        }
    });

    it('does not apply the dry-run window when narrowing OUT of DRY_RUN', () => {
        // Two days into observation, deciding to stop, must not be refused for
        // not having observed enough.
        expect(describeRefusal('leaver', { mode: 'DRY_RUN', dryRunSince: daysAgo(2) }, 'DISABLED', NOW)).toBeNull();
    });
});

describe('no-op', () => {
    it('setting the mode it already has is allowed', () => {
        for (const m of LADDER) {
            expect(describeRefusal('leaver', { mode: m, dryRunSince: null }, m, NOW)).toBeNull();
        }
    });
});

/**
 * A direction with nothing behind it must not be climbable.
 *
 * `identityJoinerMode` has no reader: no joiner job, no directory writer with a
 * create verb, nothing but the policy usecase storing and reporting it. The route
 * has always TOLD the operator so — `honoured.joiner.implemented` was a hard
 * `false` — while the PUT accepted the widen anyway, and the client button read
 * neither that flag nor anything else that would stop it.
 *
 * The harm is state accumulation rather than a live directory write: nothing acts
 * on the value, so the cost is that a tenant can ARRIVE at joiner AUTOMATIC and be
 * sitting there on the day a joiner runtime, or a future JOINER_MAX_MODE clamp,
 * first reads it — the ladder's whole point spent against a subsystem that never
 * ran. A PUT per rung and seven days was the whole climb, because the dwell fires
 * only when LEAVING DRY_RUN.
 */
describe('an unimplemented direction cannot be widened', () => {
    const ctx = makeRequestContext('OWNER');

    it('pins the premise: the joiner has no runtime and the leaver does', () => {
        // If this ever flips, the refusals below stop being the right behaviour
        // and the tests that assert them should fail LOUDLY rather than be
        // quietly rewritten to match a constant somebody moved.
        expect(DIRECTION_IMPLEMENTED.joiner).toBe(false);
        expect(DIRECTION_IMPLEMENTED.leaver).toBe(true);
    });

    it('refuses a joiner widen at the usecase, not just in the UI', async () => {
        await expect(setIdentityWriteMode(ctx, 'joiner', 'DRY_RUN', NOW)).rejects.toThrow(
            /no implementation behind it/i,
        );
        // The refusal is a refusal, not a warning: nothing was written.
        expect(upsert).not.toHaveBeenCalled();
    });

    it('still allows the leaver direction, so the gate is not a blanket one', async () => {
        // The half that makes the previous assertion mean something. A gate that
        // refused BOTH directions would satisfy the joiner test while breaking
        // the only direction that works.
        await expect(setIdentityWriteMode(ctx, 'leaver', 'DRY_RUN', NOW)).resolves.toEqual({
            mode: 'DRY_RUN',
            dryRunSince: NOW,
        });
        expect(upsert).toHaveBeenCalledTimes(1);
    });

    it('refuses every rung above DISABLED, not merely the first', async () => {
        // Reaching AUTOMATIC needs a DRY_RUN the joiner can never legally hold,
        // but the gate must not lean on that: it is stated per-transition, so a
        // tenant whose row was set before this gate existed cannot resume the
        // climb.
        settingsRow.identityJoinerMode = 'DRY_RUN';
        await expect(setIdentityWriteMode(ctx, 'joiner', 'AUTOMATIC', NOW)).rejects.toThrow(
            /no implementation behind it/i,
        );
        expect(upsert).not.toHaveBeenCalled();
    });

    it('still lets an already-widened joiner narrow back down', async () => {
        // Below the narrowing check on purpose. A tenant parked above DISABLED by
        // the old behaviour must be able to come back — a gate that trapped them
        // at AUTOMATIC would be strictly worse than the bug it replaced.
        settingsRow.identityJoinerMode = 'AUTOMATIC';
        await expect(setIdentityWriteMode(ctx, 'joiner', 'DISABLED', NOW)).resolves.toEqual({
            mode: 'DISABLED',
            dryRunSince: null,
        });
        expect(upsert).toHaveBeenCalledTimes(1);
    });

    it('reports the same refusal through describeRefusal, which is what the GET renders', () => {
        // One source: the sentence the write path throws is the sentence the page
        // shows beside the disabled button, because both come from here.
        expect(describeRefusal('joiner', { mode: 'DISABLED', dryRunSince: null }, 'DRY_RUN', NOW))
            .toMatch(/no implementation behind it/i);
        expect(describeRefusal('leaver', { mode: 'DISABLED', dryRunSince: null }, 'DRY_RUN', NOW))
            .toBeNull();
    });
});


/**
 * A row still holding the retired rung.
 *
 * `IdentityWriteMode` in the database still carries PROPOSE and always will —
 * dropping an enum value needs an `ALTER TYPE`, which breaks every still-running
 * old container mid-deploy. So the stored value outlives the rung, and the read
 * boundary is where it stops being one.
 *
 * The failure direction is what makes this worth its own block. An unrecognised
 * mode sorts to -1 in `isAboveClamp`, i.e. NOT above the clamp, i.e. cleared to
 * run; and it is not the literal 'DRY_RUN' the writer factory used to look for,
 * so it would have been handed a LIVE directory writer. Uncoerced, the value
 * fails OPEN.
 */
describe('a stored PROPOSE is translated at the read, before anything ranks it', () => {
    const ctx = makeRequestContext('OWNER');

    beforeEach(() => {
        settingsRow.identityLeaverMode = 'PROPOSE';
    });

    it('reads as DRY_RUN — the rung below, not an unknown value', async () => {
        const policy = await getIdentityWritePolicy(ctx);
        expect(policy.leaver.mode).toBe('DRY_RUN');
    });

    it('cannot widen to AUTOMATIC, because the coerced state has no banked window', async () => {
        // `setIdentityWriteMode` nulls `dryRunSince` on every move OUT of
        // DRY_RUN, so a tenant that climbed to PROPOSE has no start stamp. It
        // therefore has to re-enter DRY_RUN and spend the seven days — the same
        // toll every other tenant pays for the same authority, which is the
        // correct answer for a rung that was reachable without paying it.
        await expect(setIdentityWriteMode(ctx, 'leaver', 'AUTOMATIC', NOW)).rejects.toThrow(
            /no recorded start/i,
        );
        expect(upsert).not.toHaveBeenCalled();
    });

    it('can restart the observation window, which is the way forward from here', async () => {
        // The half that keeps the refusal above honest: coercion must not strand
        // the tenant. Re-selecting DRY_RUN is accepted (it is a no-op on the
        // coerced state) and stamps a fresh clock.
        await expect(setIdentityWriteMode(ctx, 'leaver', 'DRY_RUN', NOW)).resolves.toEqual({
            mode: 'DRY_RUN',
            dryRunSince: NOW,
        });
    });

    it('can still narrow all the way off', async () => {
        await expect(setIdentityWriteMode(ctx, 'leaver', 'DISABLED', NOW)).resolves.toEqual({
            mode: 'DISABLED',
            dryRunSince: null,
        });
    });
});

describe('the write refuses a mode that is not a rung', () => {
    const ctx = makeRequestContext('OWNER');

    it('rejects the retired rung by name, rather than storing it again', async () => {
        // The API rejects it first (its zod enum is built from LADDER), so this
        // is the backstop for a caller that is not the API — a script, a job, a
        // future internal caller. A `PROPOSE` that got written back would be a
        // row nothing on the ladder can act on.
        await expect(
            setIdentityWriteMode(ctx, 'leaver', 'PROPOSE' as IdentityWriteMode, NOW),
        ).rejects.toThrow(/Unknown identity write mode/i);
        expect(upsert).not.toHaveBeenCalled();
    });

    it('rejects anything else off the ladder too', async () => {
        await expect(
            setIdentityWriteMode(ctx, 'leaver', 'SUPERUSER' as IdentityWriteMode, NOW),
        ).rejects.toThrow(/Unknown identity write mode/i);
        expect(upsert).not.toHaveBeenCalled();
    });
});
