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
const executionCount = jest.fn(async (_args: unknown): Promise<number> => 1);
const mockDb = {
    // The dwell gate counts executed passes when a mode is WIDENED (#2843
    // finding 31). Defaults to 1 — the ordinary case — so every existing test
    // about the day count still reaches the day check.
    integrationExecution: { count: executionCount },
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
    DRY_RUN_MIN_PASSES,
} from '@/app-layer/usecases/identity-write-policy';
import { DIRECTION_IMPLEMENTED, LADDER, type IdentityWriteMode } from '@/lib/identity/write-ladder';
import { LEAVER_MAX_MODE } from '@/app-layer/usecases/identity-leaver-pass';
import { JOINER_MAX_MODE } from '@/app-layer/usecases/identity-joiner-pass';
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

    it('refuses a window that has recorded no pass at all — #2843 finding 31', () => {
        // The mechanism half of the finding. #2887 fixed the SENTENCE the gate
        // renders; the gate still counted days and nothing else, so a tenant
        // could serve the full week having run nothing and be widened to the
        // rung that writes to a real directory.
        const why = describeRefusal(
            'leaver',
            { mode: 'DRY_RUN', dryRunSince: daysAgo(DRY_RUN_MIN_DAYS + 1) },
            'AUTOMATIC',
            NOW,
            0,
        );

        expect(why).toMatch(/recorded 0 completed leaver passes/i);
    });

    it('says what a zero count MEANS, not just that it is zero', () => {
        // "Wait longer" is the wrong instruction here and the reason the day
        // count alone was misleading: no more waiting will produce a pass if
        // the dispatcher never fires.
        const why = describeRefusal(
            'leaver',
            { mode: 'DRY_RUN', dryRunSince: daysAgo(DRY_RUN_MIN_DAYS + 1) },
            'AUTOMATIC',
            NOW,
            0,
        );

        expect(why).toMatch(/dispatcher that never fired|directory that never resolved/i);
        expect(why).not.toMatch(/more days? required|wait/i);
    });

    it('checks evidence BEFORE the day count, so the useful refusal wins', () => {
        // A window that is both short AND empty should say the thing the
        // operator can act on. Waiting fixes the days; nothing fixes the
        // passes except finding out why none ran.
        const why = describeRefusal(
            'leaver',
            { mode: 'DRY_RUN', dryRunSince: daysAgo(1) },
            'AUTOMATIC',
            NOW,
            0,
        );

        expect(why).toMatch(/recorded 0 completed/i);
        expect(why).not.toMatch(/required days/i);
    });

    it('lets a window through once a pass has run and the days are served', () => {
        // The positive control. A gate that refused both ways would satisfy
        // every assertion above while making the rung unreachable.
        expect(
            describeRefusal(
                'leaver',
                { mode: 'DRY_RUN', dryRunSince: daysAgo(DRY_RUN_MIN_DAYS + 1) },
                'AUTOMATIC',
                NOW,
                1,
            ),
        ).toBeNull();
    });

    it('time is not buyable with runs — the day branch fires with the evidence bar already met', () => {
        // A tenant with a quiet week has observed nothing by running the job
        // seven times. The window exists to span a real termination/hire cycle.
        //
        // PASSES THE EVIDENCE BAR ON PURPOSE. This used to call `describeRefusal`
        // with no `passesInWindow` at all, which skipped the evidence branch via
        // its `!== undefined` guard and so proved the day branch fires only in a
        // shape the real caller never produces (it always supplies a count when
        // leaving DRY_RUN). Handing it a satisfying count instead isolates the
        // property actually claimed: with evidence ALREADY sufficient, elapsed
        // time still refuses. That is what makes days non-substitutable.
        const almost = describeRefusal(
            'leaver',
            { mode: 'DRY_RUN', dryRunSince: daysAgo(DRY_RUN_MIN_DAYS - 0.5) },
            'AUTOMATIC',
            NOW,
            DRY_RUN_MIN_PASSES + 5,
        );
        expect(almost).toMatch(/required days/);
    });

    it('SAYS it counts days, and does not claim a cycle was observed', () => {
        // #2843 finding 31. The refusal read "the point is to observe a real
        // termination-and-hire cycle", which states the window's PURPOSE as
        // though it were the gate's TEST. The gate reads a clock: a tenant
        // whose schedule was off, whose connection was disabled, or who simply
        // had nobody leave satisfies it identically to one that watched seven
        // days of real passes.
        //
        // The behaviour is deliberate and stays — the test above pins it. What
        // changed is the sentence, so a passed gate is not read as evidence of
        // something nobody measured.
        //
        // AND THEN THE GATE GREW A SECOND TERM. This assertion read
        // `/counts days, not passes/i` — a sentence that became FALSE the day
        // the evidence check landed, and this test is what would have kept it
        // in the product. A test pinning the exact wording of a claim has to
        // move when the claim does, or it stops guarding the property and
        // starts guarding the typo. Pin BOTH halves instead: the day branch
        // says what it measures, and does not deny the other term.
        const why = describeRefusal(
            'leaver',
            { mode: 'DRY_RUN', dryRunSince: daysAgo(2) },
            'AUTOMATIC',
            NOW,
            DRY_RUN_MIN_PASSES + 5,
        );
        expect(why).toMatch(/counts elapsed days/i);
        expect(why).toMatch(/requires the window to contain real passes/i);
        expect(why).not.toMatch(/counts days, not passes/i);
        expect(why).not.toMatch(/the point is to observe/i);
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
                    {
                        mode: from,
                        dryRunSince: from === 'DRY_RUN' ? daysAgo(DRY_RUN_MIN_DAYS - 1) : null,
                    },
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

describe('setIdentityWriteMode counts the passes itself — #2843 finding 31', () => {
    const ctx = makeRequestContext('OWNER');

    it('refuses a widen when the window recorded nothing', async () => {
        // The WIRING. Removing the count from this path left every unit test
        // green, because they exercise `describeRefusal` directly and it
        // cannot tell whether its caller bothered to look.
        executionCount.mockResolvedValueOnce(0);
        mockDb.tenantSecuritySettings.findUnique.mockResolvedValueOnce({
            ...settingsRow,
            identityLeaverMode: 'DRY_RUN',
            identityLeaverDryRunSince: daysAgo(DRY_RUN_MIN_DAYS + 1),
            identityJoinerDryRunSince: null,
        });

        await expect(setIdentityWriteMode(ctx, 'leaver', 'AUTOMATIC', LEAVER_MAX_MODE, NOW)).rejects.toThrow(
            /recorded 0 completed leaver passes/i,
        );
    });

    it('counts only this direction, since the window is per direction', async () => {
        executionCount.mockResolvedValueOnce(0);
        mockDb.tenantSecuritySettings.findUnique.mockResolvedValueOnce({
            ...settingsRow,
            identityLeaverMode: 'DRY_RUN',
            identityLeaverDryRunSince: daysAgo(DRY_RUN_MIN_DAYS + 1),
            identityJoinerDryRunSince: null,
        });

        await setIdentityWriteMode(ctx, 'leaver', 'AUTOMATIC', LEAVER_MAX_MODE, NOW).catch(() => undefined);

        const where = (executionCount.mock.calls[0][0] as { where: { automationKey: unknown } }).where;
        expect(JSON.stringify(where)).toMatch(/leaver_pass/);
        expect(JSON.stringify(where)).not.toMatch(/joiner_pass/);
    });

    it('does not count when the move is not leaving DRY_RUN', async () => {
        // Narrowing, or entering the window, has nothing to prove — and this
        // read must not become a cost every mode change pays.
        executionCount.mockClear();
        mockDb.tenantSecuritySettings.findUnique.mockResolvedValueOnce({
            ...settingsRow,
            identityLeaverMode: 'AUTOMATIC',
            identityLeaverDryRunSince: null,
            identityJoinerDryRunSince: null,
        });

        await setIdentityWriteMode(ctx, 'leaver', 'DISABLED', LEAVER_MAX_MODE, NOW);

        expect(executionCount).not.toHaveBeenCalled();
    });
});

describe('no-op', () => {
    it('setting the mode it already has is allowed', () => {
        for (const m of LADDER) {
            expect(
                describeRefusal('leaver', { mode: m, dryRunSince: null }, m, NOW),
            ).toBeNull();
        }
    });
});

/**
 * A direction that cannot ACT on its mode must not be climbable.
 *
 * THE PREMISE MOVED UNDER THIS BLOCK AND THE ASSERTIONS DID NOT. It used to read
 * "`identityJoinerMode` has no reader: no joiner job, no directory writer with a
 * create verb, nothing but the policy usecase storing and reporting it" — and
 * #2687 falsified the first two-thirds of that sentence: `planJoinerPass` reads
 * the mode at its own gate 1, and there is now an `identity-joiner-pass` job, an
 * `identity-joiner-dispatch` fan-out at 04:30 UTC. The OWNER-only run route
 * ships in the route half of #2687.
 *
 * What survives is the half that still holds, and it is enough on its own:
 * `DirectoryProvisioner` declares no create verb. The entitlement map now has
 * a home (#2713), so a CONFIGURED tenant's plan decides a group — but there is
 * no verb behind the decision. A joiner pass therefore RUNS and cannot act —
 * which is exactly the state `DIRECTION_IMPLEMENTED.joiner`
 * names, because that flag means a runtime reads the setting AND an operator can
 * see what it did.
 *
 * The route has always TOLD the operator so — `honoured.joiner.implemented` was a
 * hard `false` — while the PUT accepted the widen anyway, and the client button
 * read neither that flag nor anything else that would stop it.
 *
 * The harm is state accumulation rather than a live directory write: no plan can
 * provision, so the cost is that a tenant can ARRIVE at joiner AUTOMATIC and be
 * sitting there on the day the entitlement map lands — the ladder's whole point
 * spent against a subsystem that never provisioned anyone. A PUT per rung and
 * seven days was the whole climb, because the dwell fires only when LEAVING
 * DRY_RUN.
 */
describe('an unimplemented direction cannot be widened', () => {
    const ctx = makeRequestContext('OWNER');

    it('the premise MOVED: both directions are implemented now', () => {
        // The previous revision of this test said: "If this ever flips, the
        // refusals below stop being the right behaviour and the tests that
        // assert them should fail LOUDLY rather than be quietly rewritten to
        // match a constant somebody moved."
        //
        // It flipped, and it did fail loudly — all four assertions in this
        // block. This is the honest rewrite it asked for, and the distinction
        // it was protecting is preserved rather than deleted: the RULE ("an
        // unimplemented direction cannot be widened") is now exercised against
        // an INJECTED map, because with both real directions implemented there
        // is no live example left to lean on.
        //
        // That matters more than it sounds. A rule testable only through
        // whichever direction happens to be unfinished is a rule that vanishes
        // the moment the product finishes — and it would vanish GREEN, which is
        // the failure mode that looks like success.
        expect(DIRECTION_IMPLEMENTED.joiner).toBe(true);
        expect(DIRECTION_IMPLEMENTED.leaver).toBe(true);
    });

    /**
     * The rule, against a direction unimplemented BY CONSTRUCTION.
     *
     * `describeRefusal` reads `DIRECTION_IMPLEMENTED[direction]` through a
     * module binding, so re-requiring the usecase behind a doMock gives a copy
     * whose map says what this test needs. The assertions are then about the
     * GATE, not about which direction happens to be finished.
     */
    const withJoinerUnimplemented = (
        run: (m: typeof import('@/app-layer/usecases/identity-write-policy')) => void,
    ) => {
        jest.isolateModules(() => {
            jest.doMock('@/lib/identity/write-ladder', () => ({
                ...jest.requireActual('@/lib/identity/write-ladder'),
                DIRECTION_IMPLEMENTED: { leaver: true, joiner: false },
            }));
            run(require('@/app-layer/usecases/identity-write-policy'));
        });
        jest.dontMock('@/lib/identity/write-ladder');
    };

    it('pins the injection itself — the map really is false in there', () => {
        // The positive control. A doMock that silently failed to apply would
        // make every assertion below pass for the wrong reason: they would be
        // testing the REAL map, in which the joiner is now implemented, and a
        // refusal that never fired would read as a refusal that did.
        withJoinerUnimplemented((m) => {
            expect(
                m.describeRefusal('joiner', { mode: 'DISABLED', dryRunSince: null }, 'DRY_RUN', NOW),
            ).toMatch(/no implementation behind it/i);
        });
        // ...and outside the injection, the same widen is now allowed.
        expect(describeRefusal('joiner', { mode: 'DISABLED', dryRunSince: null }, 'DRY_RUN', NOW))
            .toBeNull();
    });

    it('refuses an unimplemented widen at the usecase, not just in the UI', async () => {
        let thrown: unknown;
        withJoinerUnimplemented((m) => {
            thrown = m
                .setIdentityWriteMode(ctx, 'joiner', 'DRY_RUN', JOINER_MAX_MODE, NOW)
                .catch((e: unknown) => e);
        });
        await expect(thrown).resolves.toMatchObject({
            message: expect.stringMatching(/no implementation behind it/i),
        });
        // The refusal is a refusal, not a warning: nothing was written.
        expect(upsert).not.toHaveBeenCalled();
    });

    it('now ALLOWS the joiner to reach DRY_RUN, which is what this lift bought', async () => {
        // #2843 finding 56: "no tenant can reach DRY_RUN through the product,
        // so the seven-day window cannot even be started". This is that,
        // asserted. A diff that moved the flag without making this reachable
        // would have changed a label and nothing else.
        await expect(
            setIdentityWriteMode(ctx, 'joiner', 'DRY_RUN', JOINER_MAX_MODE, NOW),
        ).resolves.toEqual({ mode: 'DRY_RUN', dryRunSince: NOW });
        expect(upsert).toHaveBeenCalledTimes(1);
    });

    it('still allows the leaver direction, so the gate is not a blanket one', async () => {
        // The half that makes the previous assertion mean something. A gate that
        // refused BOTH directions would satisfy the joiner test while breaking
        // the only direction that works.
        await expect(setIdentityWriteMode(ctx, 'leaver', 'DRY_RUN', LEAVER_MAX_MODE, NOW)).resolves.toEqual({
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
        let thrown: unknown;
        withJoinerUnimplemented((m) => {
            thrown = m
                .setIdentityWriteMode(ctx, 'joiner', 'AUTOMATIC', JOINER_MAX_MODE, NOW)
                .catch((e: unknown) => e);
        });
        await expect(thrown).resolves.toMatchObject({
            message: expect.stringMatching(/no implementation behind it/i),
        });
        expect(upsert).not.toHaveBeenCalled();
    });

    it('still lets an already-widened joiner narrow back down', async () => {
        // Below the narrowing check on purpose. A tenant parked above DISABLED by
        // the old behaviour must be able to come back — a gate that trapped them
        // at AUTOMATIC would be strictly worse than the bug it replaced.
        settingsRow.identityJoinerMode = 'AUTOMATIC';
        await expect(setIdentityWriteMode(ctx, 'joiner', 'DISABLED', JOINER_MAX_MODE, NOW)).resolves.toEqual({
            mode: 'DISABLED',
            dryRunSince: null,
        });
        expect(upsert).toHaveBeenCalledTimes(1);
    });

    it('reports the same refusal through describeRefusal, which is what the GET renders', () => {
        // One source: the sentence the write path throws is the sentence the page
        // shows beside the disabled button, because both come from here.
        withJoinerUnimplemented((m) => {
            expect(
                m.describeRefusal('joiner', { mode: 'DISABLED', dryRunSince: null }, 'DRY_RUN', NOW),
            ).toMatch(/no implementation behind it/i);
        });
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
        await expect(setIdentityWriteMode(ctx, 'leaver', 'AUTOMATIC', LEAVER_MAX_MODE, NOW)).rejects.toThrow(
            /no recorded start/i,
        );
        expect(upsert).not.toHaveBeenCalled();
    });

    it('can restart the observation window, which is the way forward from here', async () => {
        // The half that keeps the refusal above honest: coercion must not strand
        // the tenant. Re-selecting DRY_RUN is accepted (it is a no-op on the
        // coerced state) and stamps a fresh clock.
        await expect(setIdentityWriteMode(ctx, 'leaver', 'DRY_RUN', LEAVER_MAX_MODE, NOW)).resolves.toEqual({
            mode: 'DRY_RUN',
            dryRunSince: NOW,
        });
    });

    it('can still narrow all the way off', async () => {
        await expect(setIdentityWriteMode(ctx, 'leaver', 'DISABLED', LEAVER_MAX_MODE, NOW)).resolves.toEqual({
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
            setIdentityWriteMode(ctx, 'leaver', 'PROPOSE' as IdentityWriteMode, LEAVER_MAX_MODE, NOW),
        ).rejects.toThrow(/Unknown identity write mode/i);
        expect(upsert).not.toHaveBeenCalled();
    });

    it('rejects anything else off the ladder too', async () => {
        await expect(
            setIdentityWriteMode(ctx, 'leaver', 'SUPERUSER' as IdentityWriteMode, LEAVER_MAX_MODE, NOW),
        ).rejects.toThrow(/Unknown identity write mode/i);
        expect(upsert).not.toHaveBeenCalled();
    });
});

/**
 * THE PUBLISHED CEILING IS NOW ENFORCED ON THE WRITE PATH, NOT ONLY AT THE PASS.
 *
 * The clamp was always enforced at the pass's gate 1 and always REPORTED to the
 * UI as `honoured.<direction>.maxMode`. Nothing enforced it on the PUT, and
 * until the joiner became implemented nothing could reach the gap — the
 * unimplemented-direction refusal caught every joiner widen first.
 *
 * This is #2638's defect one field along. That issue found `implemented`
 * published as a literal while the write path consulted nothing, so a tenant
 * could climb the joiner to AUTOMATIC while the same response called it
 * unbuilt. `maxMode` sat in that same response with the same shape and kept the
 * same gap.
 *
 * What it prevents: a tenant spending the seven-day window AND the evidence
 * check to arrive at a rung where every nightly pass refuses MODE_ABOVE_CLAMP.
 * The dwell fires only when LEAVING DRY_RUN, so past that rung there is no
 * further delay — the ladder would be wholly spent for nothing.
 */
describe('a widen above the published ceiling is refused', () => {
    const ctx = makeRequestContext('OWNER');

    it('refuses the joiner at AUTOMATIC, because its ceiling is DRY_RUN', async () => {
        // Reached legitimately: seven days in DRY_RUN with evidence behind it.
        // The point is that even a tenant who has EARNED the widen is refused,
        // because the rung they would arrive at does nothing.
        settingsRow.identityJoinerMode = 'DRY_RUN';
        await expect(
            setIdentityWriteMode(ctx, 'joiner', 'AUTOMATIC', JOINER_MAX_MODE, NOW),
        ).rejects.toThrow(/above the highest rung/i);
        expect(upsert).not.toHaveBeenCalled();
    });

    it('names the ceiling it is refusing against', async () => {
        // A refusal an operator cannot act on is a dead end. It has to say
        // which rung the runtime stops at, and that raising it is a code
        // change rather than a setting they have failed to find.
        settingsRow.identityJoinerMode = 'DRY_RUN';
        const err = await setIdentityWriteMode(
            ctx, 'joiner', 'AUTOMATIC', JOINER_MAX_MODE, NOW,
        ).catch((e: Error) => e);
        expect((err as Error).message).toContain(JOINER_MAX_MODE);
        expect((err as Error).message).toMatch(/reviewed change/i);
    });

    it('does NOT refuse the leaver at AUTOMATIC — the check is not a blanket one', async () => {
        // The half that makes the assertions above mean something. A check that
        // refused every widen would satisfy them while breaking the direction
        // that legitimately reaches the top rung. The leaver's ceiling IS
        // AUTOMATIC, so nothing is above it.
        settingsRow.identityLeaverMode = 'DRY_RUN';
        await expect(
            describeRefusal(
                'leaver',
                { mode: 'DRY_RUN', dryRunSince: daysAgo(DRY_RUN_MIN_DAYS + 1) },
                'AUTOMATIC',
                NOW,
                DRY_RUN_MIN_PASSES + 1,
                LEAVER_MAX_MODE,
            ),
        ).toBeNull();
    });

    it('still lets a tenant parked ABOVE the ceiling narrow back down', async () => {
        // Narrowing returns before this check, deliberately. A tenant sitting at
        // AUTOMATIC — set before this gate existed — must be able to come back,
        // or the gate would trap them at the very rung it calls unreachable.
        settingsRow.identityJoinerMode = 'AUTOMATIC';
        await expect(
            setIdentityWriteMode(ctx, 'joiner', 'DRY_RUN', JOINER_MAX_MODE, NOW),
        ).resolves.toEqual({ mode: 'DRY_RUN', dryRunSince: NOW });
    });

    it('is ORDINAL, not an equality check against the ceiling', async () => {
        // `mode !== clamp` would be correct by coincidence while the ceiling sits
        // one rung up, and would refuse DISABLED->DRY_RUN the moment it moved.
        // The pass pays for this distinction too; both use `isAboveClamp`.
        settingsRow.identityJoinerMode = 'DISABLED';
        await expect(
            setIdentityWriteMode(ctx, 'joiner', 'DRY_RUN', JOINER_MAX_MODE, NOW),
        ).resolves.toEqual({ mode: 'DRY_RUN', dryRunSince: NOW });
    });
});
