/**
 * The per-tenant half of the AI gate.
 *
 *     effective = env_global AND env_feature AND tenant_master AND tenant_feature
 *
 * Four properties, in order of what they cost if wrong:
 *
 *   1. FAIL CLOSED. An unreadable settings row refuses. A tenant that turned AI
 *      off may have done so contractually, and running a model for them because
 *      a row was briefly unreadable is a breach that cannot be undone.
 *   2. The env still wins. A tenant row cannot re-enable what the deploy forbids
 *      — otherwise the kill switch is not one.
 *   3. NO DATABASE READ when the env already refused. The gate runs on every AI
 *      request; paying a round trip to confirm a `false` constant is waste, and
 *      asserting it is the only way that stays true.
 *   4. `enforceFeatureGate` and `checkFeatureGateWithPlan` agree. They are two
 *      entry points to one decision, and a predicate added to one and not the
 *      other is the shape of #3909 — a surface allowed by one path and refused
 *      by another.
 */
import type { RequestContext } from '@/app-layer/types';

const findUnique = jest.fn();

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({ tenantSecuritySettings: { findUnique } }),
}));

// requireActual-spread, NOT a bare object: `isolateModules` re-requires the
// whole graph below the gate, and several of those modules import other names
// from this barrel. Replacing only `warn` keeps them working.
jest.mock('@/lib/observability/logger', () => {
    const actual = jest.requireActual('@/lib/observability/logger');
    return { ...actual, logger: { ...actual.logger, warn: jest.fn() } };
});

const baseCtx = {
    userId: 'u1',
    tenantId: 't1',
    requestId: 'r1',
    role: 'ADMIN',
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
} as unknown as RequestContext;

/** Load a fresh gate under an env snapshot — the flags are module constants. */
function loadGate(envOverrides: Record<string, string | undefined>) {
    // `!` rather than `= null as any`: the sibling suite uses the cast and the
    // `any` ratchet counts it. A definite-assignment assertion says the same
    // thing — `isolateModules` runs its callback synchronously, so `mod` is
    // assigned before the return — without spending a cap.
    let mod!: typeof import('@/app-layer/ai/risk-assessment/feature-gate');
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(envOverrides)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    jest.isolateModules(() => {
        mod = require('@/app-layer/ai/risk-assessment/feature-gate');
    });
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    return mod;
}

const ALL_ENV_ON = {
    AI_RISK_ENABLED: 'true',
    AI_RISK_SUGGESTIONS_ENABLED: 'true',
    AI_ASSISTANT_ENABLED: 'true',
    AI_QUESTIONNAIRE_ENABLED: 'true',
};

beforeEach(() => {
    findUnique.mockReset();
});

describe('the tenant toggle is ANDed into the gate', () => {
    it('allows when the tenant row says on', async () => {
        findUnique.mockResolvedValue({ aiEnabled: true, aiAssistantEnabled: true });
        const gate = loadGate(ALL_ENV_ON);
        await expect(gate.checkFeatureGateWithPlan(baseCtx, 'assistant')).resolves.toEqual({
            allowed: true,
        });
    });

    it('allows when there is NO settings row at all', async () => {
        // An absent row means "never configured", and all four columns default
        // to true. Reading absence as OFF would disable AI for exactly the
        // tenants nobody has looked at — the opposite choice from
        // `processCanvasEnabled`, and deliberately so: that is an opt-in module,
        // this is an opt-out setting.
        findUnique.mockResolvedValue(null);
        const gate = loadGate(ALL_ENV_ON);
        await expect(gate.checkFeatureGateWithPlan(baseCtx, 'risk')).resolves.toEqual({
            allowed: true,
        });
    });

    it('refuses the one feature the tenant turned off, naming it', async () => {
        findUnique.mockResolvedValue({ aiEnabled: true, aiAssistantEnabled: false });
        const gate = loadGate(ALL_ENV_ON);
        const result = await gate.checkFeatureGateWithPlan(baseCtx, 'assistant');
        expect(result.allowed).toBe(false);
        // Names the FEATURE, not just "unavailable": the reader has to know
        // which switch to look at.
        expect(result.reason).toContain('assistant');
        expect(result.reason).toContain('workspace');
    });

    it('refuses EVERY feature when the tenant master switch is off', async () => {
        const gate = loadGate(ALL_ENV_ON);
        for (const feature of ['risk', 'assistant', 'questionnaire'] as const) {
            // The per-feature column stays TRUE in each case, so a gate that
            // only read its own column would allow all three.
            findUnique.mockResolvedValue({
                aiEnabled: false,
                aiRiskSuggestionsEnabled: true,
                aiAssistantEnabled: true,
                aiQuestionnaireEnabled: true,
            });
            const result = await gate.checkFeatureGateWithPlan(baseCtx, feature);
            expect(result.allowed).toBe(false);
            expect(result.reason).toBe('AI features are turned off for this workspace');
        }
    });

    it('REFUSES when the settings read throws — fail closed', async () => {
        findUnique.mockRejectedValue(new Error('connection terminated'));
        const gate = loadGate(ALL_ENV_ON);
        const result = await gate.checkFeatureGateWithPlan(baseCtx, 'assistant');
        expect(result.allowed).toBe(false);
        // The reason says the availability is UNKNOWN rather than claiming the
        // tenant turned it off: a reader chasing this must not be sent to a
        // settings page that shows the feature on.
        expect(result.reason).toContain('could not be confirmed');
    });

    it('does NOT read the database when the env already refused', async () => {
        const gate = loadGate({ ...ALL_ENV_ON, AI_ASSISTANT_ENABLED: 'false' });
        const result = await gate.checkFeatureGateWithPlan(baseCtx, 'assistant');
        expect(result.allowed).toBe(false);
        expect(findUnique).not.toHaveBeenCalled();
    });

    it('a tenant row of ON cannot re-enable what the env forbids', async () => {
        // The kill-switch property. If this ever allows, an operator has no way
        // to stop AI without a deploy.
        findUnique.mockResolvedValue({ aiEnabled: true, aiAssistantEnabled: true });
        const gate = loadGate({ ...ALL_ENV_ON, AI_RISK_ENABLED: 'false' });
        await expect(
            gate.checkFeatureGateWithPlan(baseCtx, 'assistant'),
        ).resolves.toMatchObject({ allowed: false });
    });
});

describe('enforceFeatureGate shares the predicate', () => {
    it('throws when the tenant toggle refuses', async () => {
        // Driven through `enforceFeatureGate`, NOT `checkFeatureGateWithPlan`:
        // the two are separate entry points and this is the one the routes
        // call. A predicate wired into only the other would leave every route
        // ungated while the tests above stayed green.
        findUnique.mockResolvedValue({ aiEnabled: true, aiQuestionnaireEnabled: false });
        const gate = loadGate(ALL_ENV_ON);
        await expect(gate.enforceFeatureGate(baseCtx, 'questionnaire')).rejects.toThrow(
            /questionnaire/i,
        );
    });

    it('resolves when the tenant toggle allows', async () => {
        findUnique.mockResolvedValue({ aiEnabled: true, aiQuestionnaireEnabled: true });
        const gate = loadGate(ALL_ENV_ON);
        await expect(gate.enforceFeatureGate(baseCtx, 'questionnaire')).resolves.toBeUndefined();
    });

    it('throws on an unreadable row, like the check path', async () => {
        findUnique.mockRejectedValue(new Error('connection terminated'));
        const gate = loadGate(ALL_ENV_ON);
        await expect(gate.enforceFeatureGate(baseCtx, 'risk')).rejects.toThrow(
            /could not be confirmed/,
        );
    });
});

/*
    ═══ EVERY CALL SITE MUST AWAIT, AND THAT IS NEW ═══

    `enforceFeatureGate` used to throw SYNCHRONOUSLY whenever a sync predicate
    refused — the env flags and the role — and returned a promise only for the
    plan check. Adding the per-tenant toggle made it `async`, so it now throws
    nothing: every refusal is a rejected promise.

    For a caller that awaits, nothing changed. For one that does not, the
    refusal became an unhandled rejection and execution CONTINUES — a gate that
    silently allows. All six call sites await today; this keeps the seventh
    honest, because nothing else would notice.

    Folded into this suite rather than given its own file in tests/guards: a
    property belonging to one change should not become a file of its own, and
    this property belongs to the change this suite is about.
*/
import * as fs from 'fs';
import * as path from 'path';

/** Strip comments so a mention in prose is not read as a call. */
function codeOnly(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * Call sites of `enforceFeatureGate` that neither await nor return the promise.
 *
 * Exported shape so it can be driven with inputs that DO fail — an inline scan
 * would stay green once src/ was clean, and would stay green if neutered.
 */
export function unawaitedCalls(source: string): string[] {
    /*
        STATEMENT-SCOPED, not line-scoped — the first version of this demanded
        `await` IMMEDIATELY before the call and reported all 16 real call sites
        as offenders, because every one of them reads
        `await expect(gate.enforceFeatureGate(...)).rejects...`. It was a check
        capable of failing that was aimed at the wrong shape.

        So: walk back to the nearest `;`, `{` or `}` — the start of the
        statement — and ask whether an `await` or `return` governs the call
        anywhere in it. That admits the multi-line form too, where the `await`
        and the call sit on different lines.
    */
    const code = codeOnly(source);
    const needle = 'enforceFeatureGate(';
    const found: string[] = [];
    for (let i = code.indexOf(needle); i !== -1; i = code.indexOf(needle, i + needle.length)) {
        const line = code.slice(0, i).split('\n').length;
        const stmtStart = Math.max(
            code.lastIndexOf(';', i),
            code.lastIndexOf('{', i),
            code.lastIndexOf('}', i),
        );
        const before = code.slice(stmtStart + 1, i).replace(/\s+/g, ' ');

        // `expect(() => enforceFeatureGate(...))` is an offender even though an
        // `await` may govern the expect: an async function returns a promise
        // rather than throwing, so `toThrow` sees nothing, the assertion can
        // never pass, AND the promise goes unhandled — which kills the jest
        // worker and reports as "Test suite failed to run" with zero failed
        // tests. That shape is how this bug hid in two suites.
        const insideArrow = /=>\s*[\w.]*$/.test(before);
        const governed = /\b(await|return)\b/.test(before);
        if (insideArrow || !governed) found.push(`${line}: ...${before.trim()}${needle}`);
    }
    return found;
}

function tsFilesUnder(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...tsFilesUnder(full));
        else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
}

describe('every enforceFeatureGate call site awaits it', () => {
    const SRC = path.join(process.cwd(), 'src');
    const DEFINITION = path.join(SRC, 'app-layer/ai/risk-assessment/feature-gate.ts');
    /*
        `src/` ONLY, and the scope is a decision rather than a shortcut.

        `expect(() => enforceFeatureGate(ctx)).toThrow()` is CORRECT in a test:
        the gate throws its env and role refusals synchronously on purpose, and
        `feature-gate-plan-entitlement` asserts exactly that under "a forgotten
        `await` can never weaken the gate". Scanning tests/ would flag those
        deliberate assertions.

        In `src/`, though, a dropped promise now costs more than it used to. The
        synchronous prologue still refuses on the env flags and the role, so a
        non-awaiting caller is not wide open — but the per-tenant toggle lives
        in the promise tail, and it is ALWAYS on, unlike the plan check which is
        opt-in and off by default. So a forgotten `await` would enforce two
        predicates and silently skip the one a workspace actually set.
    */
    const files = tsFilesUnder(SRC).filter((f) => f !== DEFINITION);

    it('finds the call sites at all (the scan is not vacuous)', () => {
        // A scan that silently matched nothing would make the assertion below
        // pass forever. The denominator is what proves it looked.
        const callSites = files.flatMap((f) => {
            const code = codeOnly(fs.readFileSync(f, 'utf8'));
            return code.includes('enforceFeatureGate(') ? [f] : [];
        });
        expect(files.length).toBeGreaterThan(500);
        expect(callSites.length).toBeGreaterThanOrEqual(3);
    });

    it('no call site drops the promise', () => {
        const offenders = files.flatMap((f) => {
            const bad = unawaitedCalls(fs.readFileSync(f, 'utf8'));
            return bad.map((b) => `${path.relative(process.cwd(), f)}:${b}`);
        });
        expect(offenders).toEqual([]);
    });
});

describe('unawaitedCalls can fail, in both directions', () => {
    it('flags a bare call', () => {
        expect(unawaitedCalls('enforceFeatureGate(ctx, "risk");')).toHaveLength(1);
    });

    it('accepts an awaited call', () => {
        expect(unawaitedCalls('await enforceFeatureGate(ctx, "risk");')).toEqual([]);
    });

    it('accepts the awaited-expect form every suite actually uses', () => {
        expect(
            unawaitedCalls("await expect(gate.enforceFeatureGate(c, 'risk')).rejects.toThrow();"),
        ).toEqual([]);
    });

    it('accepts the awaited-expect form split across lines', () => {
        expect(
            unawaitedCalls('await expect(\n  gate.enforceFeatureGate(c),\n).rejects.toThrow();'),
        ).toEqual([]);
    });

    it('FLAGS the arrow form even though an await governs the expect', () => {
        // The shape that can never pass against an async gate.
        expect(
            unawaitedCalls("await expect(() => gate.enforceFeatureGate(c)).toThrow();"),
        ).toHaveLength(1);
        expect(unawaitedCalls('expect(() => enforceFeatureGate(ctx)).toThrow();')).toHaveLength(1);
    });

    it('accepts a returned call', () => {
        expect(unawaitedCalls('return enforceFeatureGate(ctx);')).toEqual([]);
    });

    it('ignores a mention inside a comment', () => {
        // The pipeline docblocks in `assistant.ts` and `questionnaire.ts` both
        // name the call in prose: `enforceFeatureGate → checkRateLimit → …`.
        // Without the stripper those read as unawaited call sites.
        expect(unawaitedCalls('// enforceFeatureGate(ctx) is called below')).toEqual([]);
        expect(unawaitedCalls('/* enforceFeatureGate(ctx) */')).toEqual([]);
    });

    it('is not fooled by the import line', () => {
        expect(
            unawaitedCalls("import { enforceFeatureGate } from '@/app-layer/ai';"),
        ).toEqual([]);
    });
});
