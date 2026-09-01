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
    setIdentityWriteMode,
    DRY_RUN_MIN_DAYS,
} from '@/app-layer/usecases/identity-write-policy';
import { DIRECTION_IMPLEMENTED } from '@/lib/identity/write-ladder';
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
        expect(why).toMatch(/DISABLED → DRY_RUN → PROPOSE → AUTOMATIC/);
    });

    it('refuses DISABLED straight to PROPOSE', () => {
        expect(describeRefusal('leaver', { mode: 'DISABLED', dryRunSince: null }, 'PROPOSE', NOW)).toMatch(/one step/i);
    });

    it('allows one rung at a time', () => {
        expect(describeRefusal('leaver', { mode: 'DISABLED', dryRunSince: null }, 'DRY_RUN', NOW)).toBeNull();
    });

    it('names the path in the refusal, not just the fact of it', () => {
        // An operator who is told "no" without being told the route will try
        // the same thing again, or conclude the feature is broken.
        const why = describeRefusal('leaver', { mode: 'DRY_RUN', dryRunSince: daysAgo(99) }, 'AUTOMATIC', NOW);
        expect(why).toContain('DRY_RUN → PROPOSE → AUTOMATIC');
    });
});

describe('dry-run is time-boxed, and the clock is real', () => {
    it('refuses to widen before the window elapses, and says how long is left', () => {
        const why = describeRefusal('leaver', { mode: 'DRY_RUN', dryRunSince: daysAgo(2) }, 'PROPOSE', NOW);
        expect(why).toMatch(/2 of 7 required days/);
        expect(why).toMatch(/5 more/);
    });

    it('allows widening once the window has elapsed', () => {
        expect(
            describeRefusal('leaver', { mode: 'DRY_RUN', dryRunSince: daysAgo(DRY_RUN_MIN_DAYS + 1) }, 'PROPOSE', NOW),
        ).toBeNull();
    });

    it('refuses when DRY_RUN has no recorded start rather than treating it as elapsed', () => {
        // A null start must not read as "infinitely long ago". Absent evidence
        // of observation is not evidence of observation.
        expect(describeRefusal('leaver', { mode: 'DRY_RUN', dryRunSince: null }, 'PROPOSE', NOW)).toMatch(/no recorded start/i);
    });

    it('is measured in days, not runs', () => {
        // A tenant with a quiet week has observed nothing by running the job
        // seven times. The window exists to span a real termination/hire cycle.
        const almost = describeRefusal('leaver', { mode: 'DRY_RUN', dryRunSince: daysAgo(DRY_RUN_MIN_DAYS - 0.5) }, 'PROPOSE', NOW);
        expect(almost).toMatch(/required days/);
    });
});

describe('narrowing is never blocked', () => {
    it('allows AUTOMATIC straight back to DISABLED', () => {
        // Someone turning this off is reacting to something. A ladder that
        // slowed them down on the way OUT would be actively harmful — this is
        // the emergency stop.
        expect(describeRefusal('leaver', { mode: 'AUTOMATIC', dryRunSince: null }, 'DISABLED', NOW)).toBeNull();
    });

    it('allows PROPOSE back to DRY_RUN', () => {
        expect(describeRefusal('leaver', { mode: 'PROPOSE', dryRunSince: null }, 'DRY_RUN', NOW)).toBeNull();
    });

    it('does not apply the dry-run window when narrowing OUT of DRY_RUN', () => {
        // Two days into observation, deciding to stop, must not be refused for
        // not having observed enough.
        expect(describeRefusal('leaver', { mode: 'DRY_RUN', dryRunSince: daysAgo(2) }, 'DISABLED', NOW)).toBeNull();
    });
});

describe('no-op', () => {
    it('setting the mode it already has is allowed', () => {
        expect(describeRefusal('leaver', { mode: 'PROPOSE', dryRunSince: null }, 'PROPOSE', NOW)).toBeNull();
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
 * ran. Three widens and seven days was the whole climb, because the dwell fires
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
        // Reaching PROPOSE needs a DRY_RUN the joiner can never legally hold, but
        // the gate must not lean on that: it is stated per-transition, so a tenant
        // whose row was set before this gate existed cannot resume the climb.
        settingsRow.identityJoinerMode = 'DRY_RUN';
        await expect(setIdentityWriteMode(ctx, 'joiner', 'PROPOSE', NOW)).rejects.toThrow(
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
