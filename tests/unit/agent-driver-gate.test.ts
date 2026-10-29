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
    STORED_DRIVER_MODES,
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

    it('reads a READ_ONLY value as itself, although no writer accepts it (Step 2b)', () => {
        expect(STORED_DRIVER_MODES.map(coerceStoredDriverMode)).toEqual(['STATIC', 'FLUE', 'TOOL_RUNNER']);
        expect(isAgentDriverMode('TOOL_RUNNER')).toBe(false);
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

describe('the gate now that the flue driver is built', () => {
    it('gives a deployment that asked for flue, flue', () => {
        // Both switches on, the driver implemented: the answer is finally the
        // one that was configured. This assertion replaces the
        // DRIVER_NOT_IMPLEMENTED one that stood here while the engine was a
        // seam with nothing behind it — the state it described has ended, and
        // leaving it would have pinned the gate shut.
        expect(
            resolveAgentDriver({ envEnabled: true, tenantSetting: 'FLUE' }),
        ).toEqual({ driver: 'flue', reason: null });
    });

    it('holds the implemented flag that makes that true', () => {
        // The one line that moved. Pinned so that turning it back off is also
        // deliberate and visible in the diff that does it.
        expect(DRIVER_IMPLEMENTED).toEqual({ static: true, flue: true, 'tool-runner': false });
    });

    it('every engine but the Tool Runner is built, which is why the Flue veto needs its own block', () => {
        expect(Object.entries(DRIVER_IMPLEMENTED).filter(([, built]) => !built).map(([d]) => d)).toEqual(['tool-runner']);
    });
});

describe('the veto for a driver nobody has built', () => {
    // THE REASON CODE DID NOT DIE WHEN FLUE SHIPPED. It is the answer for the
    // NEXT engine someone declares ahead of implementing, and the flag is the
    // one-line revert the driver seam was designed around.
    //
    // This used to be asserted on a LOCAL COPY:
    //
    //     const unbuilt = { ...DRIVER_IMPLEMENTED, flue: false };
    //     expect(unbuilt.flue).toBe(false);
    //
    // — a tautology over an object the gate never reads. `resolveAgentDriver`
    // was never called, so `agent-driver.ts`'s `if (!DRIVER_IMPLEMENTED.flue)`
    // return had NO executing assertion anywhere: coverage over the file
    // reported that single line uncovered against 95% of the rest.
    //
    // The flag is swapped for real here, which is the idiom the affirmative
    // block below already uses in the other direction — and the only way to
    // exercise a branch whose condition is a module constant.
    const realFlag = DRIVER_IMPLEMENTED.flue;

    beforeAll(() => {
        (DRIVER_IMPLEMENTED as { flue: boolean }).flue = false;
    });

    afterAll(() => {
        (DRIVER_IMPLEMENTED as { flue: boolean }).flue = realFlag;
    });

    it('answers static with DRIVER_NOT_IMPLEMENTED even when both switches are on', () => {
        // The cell that would otherwise be the one `flue` answer in the whole
        // grid. With the driver unbuilt it must fall back, and SAY SO — a
        // silent static would leave an operator reading the env var and the
        // tenant toggle and finding both correct.
        expect(resolveAgentDriver({ envEnabled: true, tenantSetting: 'FLUE' })).toEqual({
            driver: 'static',
            reason: 'DRIVER_NOT_IMPLEMENTED',
        });
    });

    it('the unbuilt veto outranks the tenant and env vetoes', () => {
        // Order matters for the operator action: told TENANT_NOT_OPTED_IN they
        // would go and flip a toggle that cannot help.
        expect(resolveAgentDriver({ envEnabled: false, tenantSetting: 'FLUE' }).reason).not.toBe(
            'DRIVER_NOT_IMPLEMENTED',
        );
        expect(resolveAgentDriver({ envEnabled: true, tenantSetting: 'STATIC' }).reason).not.toBe(
            'DRIVER_NOT_IMPLEMENTED',
        );
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

describe('the Tool Runner engine, built and not yet implemented (Step 2b)', () => {
    const flueEnv = [false, true];
    const toolRunnerEnv = [undefined, false, true];
    const tenantValues = [undefined, null, '', 'STATIC', 'FLUE', 'TOOL_RUNNER', 'tool_runner', 'rubbish'];

    function grid(): { examined: number; cells: string[] } {
        const cells: string[] = [];
        let examined = 0;
        for (const envEnabled of flueEnv) {
            for (const tr of toolRunnerEnv) {
                for (const tenantSetting of tenantValues) {
                    examined += 1;
                    const decision = resolveAgentDriver({ envEnabled, toolRunnerEnvEnabled: tr, tenantSetting });
                    if (decision.driver === 'tool-runner') cells.push(`flue=${envEnabled} tr=${String(tr)} tenant=${String(tenantSetting)}`);
                }
            }
        }
        return { examined, cells };
    }

    it('no input selects it while DRIVER_IMPLEMENTED says no', () => {
        expect(grid()).toEqual({ examined: 48, cells: [] });
    });

    it('a tenant that chose it is told why: the switch first, then the build', () => {
        expect(resolveAgentDriver({ envEnabled: true, tenantSetting: 'TOOL_RUNNER' })).toEqual({
            driver: 'static',
            reason: 'ENV_DISABLED',
        });
        expect(resolveAgentDriver({ envEnabled: false, toolRunnerEnvEnabled: true, tenantSetting: 'TOOL_RUNNER' })).toEqual({
            driver: 'static',
            reason: 'DRIVER_NOT_IMPLEMENTED',
        });
    });

    it('its switch says nothing about Flue, and Flue\'s says nothing about it', () => {
        expect(resolveAgentDriver({ envEnabled: false, toolRunnerEnvEnabled: true, tenantSetting: 'FLUE' }).reason).toBe(
            'ENV_DISABLED',
        );
        expect(resolveAgentDriver({ envEnabled: true, toolRunnerEnvEnabled: false, tenantSetting: 'FLUE' }).driver).toBe('flue');
    });

    describe('with the flag flipped, as Step 2c will', () => {
        const realFlag = DRIVER_IMPLEMENTED['tool-runner'];
        beforeAll(() => {
            (DRIVER_IMPLEMENTED as Record<string, boolean>)['tool-runner'] = true;
        });
        afterAll(() => {
            (DRIVER_IMPLEMENTED as Record<string, boolean>)['tool-runner'] = realFlag;
        });

        it('selects it in exactly the cells where its own switch is on and the tenant chose it (the positive control)', () => {
            expect(grid()).toEqual({
                examined: 48,
                cells: ['flue=false tr=true tenant=TOOL_RUNNER', 'flue=true tr=true tenant=TOOL_RUNNER'],
            });
        });
    });
});
