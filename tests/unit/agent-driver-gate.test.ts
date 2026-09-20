/**
 * The agent DRIVER gate — two independent switches, ANDed, neither able to
 * widen.
 *
 * ── WHAT THIS SUITE IS ACTUALLY FOR ─────────────────────────────────────────
 *
 * The gate decides whether a tenant's agentic run is executed by code in this
 * repository or by an external agent runtime. Almost every assertion below is
 * therefore a NEGATIVE one: some input, and the answer is still `static`.
 *
 * A suite of negatives has a specific way of being worthless — it passes
 * identically against a function that returns `'static'` unconditionally. So
 * the affirmative case is exercised too, by flipping `DRIVER_IMPLEMENTED.flue`
 * to true for the duration of one block. Without that, every test here would
 * survive the gate being replaced by `return { driver: 'static' }`, which is
 * exactly the assertion-that-cannot-fail this repo keeps finding.
 *
 * The enumeration at the end is the other half: rather than hand-picking
 * inputs, it walks the CROSS PRODUCT of both switches and asserts that exactly
 * one cell of the grid yields `flue`. A hand-picked set can only miss a
 * combination; a grid cannot.
 */
import {
    AGENT_DRIVER_MODES,
    DRIVER_IMPLEMENTED,
    coerceStoredDriverMode,
    flueEnvEnabled,
    isAgentDriverMode,
    resolveAgentDriver,
} from '@/lib/agentic/agent-driver';

describe('the operator switch is opt-in, not opt-out', () => {
    it.each(['1', 'true', 'TRUE', ' true ', 'True'])('accepts %p', (raw) => {
        expect(flueEnvEnabled(raw)).toBe(true);
    });

    it.each([
        undefined,
        null,
        '',
        '0',
        'false',
        // The near-misses. These are the values someone reaching for a boolean
        // flag actually types, and every one of them must leave the capability
        // OFF — the opposite of the AI_*_ENABLED flags beside it in env.ts,
        // which default to on and are read as "not disabled".
        'yes',
        'on',
        'enabled',
        'truthy',
        '2',
        'TRUE!',
    ])('refuses %p', (raw) => {
        expect(flueEnvEnabled(raw)).toBe(false);
    });
});

describe('the stored tenant value is coerced at the read boundary', () => {
    it('passes through the values this build knows', () => {
        expect(AGENT_DRIVER_MODES.map(coerceStoredDriverMode)).toEqual(['STATIC', 'FLUE']);
    });

    it.each([
        undefined,
        null,
        '',
        'flue', // right word, wrong case — the column is an enum, this is not a member
        'STATIC_DRIVER',
        'AUTOMATIC', // a rung from a DIFFERENT ladder on the same table
        'constructor', // prototype-chain bait; a list test rather than a lookup, but proven
        '__proto__',
        'toString',
    ])('resolves %p to STATIC', (raw) => {
        expect(coerceStoredDriverMode(raw)).toBe('STATIC');
    });

    it('never widens the mode list through the membership test', () => {
        expect(['STATIC', 'FLUE'].every(isAgentDriverMode)).toBe(true);
        expect(['flue', 'constructor', '__proto__', ''].some(isAgentDriverMode)).toBe(false);
    });
});

describe('the gate while the flue driver is unimplemented', () => {
    it('reports the driver as not built, rather than pretending it is off', () => {
        // Configuration ahead of code. Both switches are on and the answer is
        // still static — but the REASON has to distinguish this from a tenant
        // that simply did not opt in, because only one of the two is an
        // operator's mistake.
        expect(
            resolveAgentDriver({ envEnabled: true, tenantSetting: 'FLUE' }),
        ).toEqual({ driver: 'static', reason: 'DRIVER_NOT_IMPLEMENTED' });
    });

    it('holds the declared-but-unbuilt flag that makes that true', () => {
        // The one line that moves when the adapter lands, pinned so it moves
        // deliberately and in the diff that makes it true.
        expect(DRIVER_IMPLEMENTED).toEqual({ static: true, flue: false });
    });
});

describe('each switch holds a veto', () => {
    it('the env switch alone cannot enable it', () => {
        expect(resolveAgentDriver({ envEnabled: true, tenantSetting: 'STATIC' })).toEqual({
            driver: 'static',
            reason: 'TENANT_NOT_OPTED_IN',
        });
    });

    it('the tenant switch alone cannot enable it', () => {
        expect(resolveAgentDriver({ envEnabled: false, tenantSetting: 'FLUE' })).toEqual({
            driver: 'static',
            reason: 'ENV_DISABLED',
        });
    });

    it('the env switch is checked FIRST, so its reason wins over the tenant value', () => {
        // Ordering matters for the operator reading the reason: with the
        // deployment-wide switch off, what the tenant chose is not the
        // actionable fact, and reporting TENANT_NOT_OPTED_IN would send someone
        // to edit a customer's settings row to fix a deployment's env.
        expect(
            resolveAgentDriver({ envEnabled: false, tenantSetting: 'nonsense' }).reason,
        ).toBe('ENV_DISABLED');
    });

    it('distinguishes an unreadable setting from an honest opt-out', () => {
        // Both coerce to STATIC and must not read as the same event: one is a
        // tenant's choice, the other is a row written by a build that knew a
        // mode this one does not.
        expect(
            resolveAgentDriver({ envEnabled: true, tenantSetting: 'QUANTUM' }).reason,
        ).toBe('UNRECOGNISED_SETTING');
        expect(
            resolveAgentDriver({ envEnabled: true, tenantSetting: null }).reason,
        ).toBe('TENANT_NOT_OPTED_IN');
    });
});

describe('the whole grid, with the driver implemented', () => {
    // THE AFFIRMATIVE CASE. Everything above passes against a function that
    // returns 'static' unconditionally; this block is what refuses that
    // implementation, by making the one cell that should yield 'flue' actually
    // yield it.
    const realFlag = DRIVER_IMPLEMENTED.flue;

    beforeAll(() => {
        (DRIVER_IMPLEMENTED as { flue: boolean }).flue = true;
    });

    afterAll(() => {
        (DRIVER_IMPLEMENTED as { flue: boolean }).flue = realFlag;
    });

    it('yields flue for exactly one cell of the cross product, and static for the rest', () => {
        const envValues = [undefined, '', '0', 'false', 'yes', '1', 'true'];
        const tenantValues = [undefined, null, '', 'STATIC', 'FLUE', 'flue', 'rubbish'];

        const flueCells: string[] = [];
        for (const rawEnv of envValues) {
            for (const tenantSetting of tenantValues) {
                const decision = resolveAgentDriver({
                    envEnabled: flueEnvEnabled(rawEnv),
                    tenantSetting,
                });
                if (decision.driver === 'flue') {
                    flueCells.push(`env=${String(rawEnv)} tenant=${String(tenantSetting)}`);
                }
            }
        }

        // 49 combinations examined. Printing the denominator beside the answer
        // is the point: "no cell yielded flue" and "the loop never ran" are the
        // same empty array otherwise.
        expect({ examined: envValues.length * tenantValues.length, flueCells }).toEqual({
            examined: 49,
            flueCells: ['env=1 tenant=FLUE', 'env=true tenant=FLUE'],
        });
    });

    it('gives no reason when it does say flue', () => {
        expect(resolveAgentDriver({ envEnabled: true, tenantSetting: 'FLUE' })).toEqual({
            driver: 'flue',
            reason: null,
        });
    });
});
