/** Set per test: the tenant's AI-residency row, or `null` for no row. */
let settingsRow: {
    aiResidency?: 'EXTERNAL' | 'LOCAL_ONLY' | null;
    aiLocalBaseUrl?: string | null;
    aiLocalModel?: string | null;
} | null = null;

/** Set per test: the deployment credentials the plan may see. */
const envValues: { ANTHROPIC_API_KEY?: string; ANTHROPIC_MODEL: string; AI_LOCAL_BASE_URL?: string; AI_LOCAL_MODEL?: string } = {
    ANTHROPIC_MODEL: 'claude-haiku-4-5',
};

jest.mock('@/env', () => ({ env: envValues }));

jest.mock('@/lib/db/rls-middleware', () => ({
    ...jest.requireActual('@/lib/db/rls-middleware'),
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({ tenantSecuritySettings: { findUnique: async () => settingsRow } }),
    ),
}));

jest.mock('@/lib/agentic/drivers/run-settlement', () => ({
    failRun: jest.fn(async () => 'FAILED'),
}));

import { runFlueDriver } from '@/lib/agentic/flue/driver';
import { failRun } from '@/lib/agentic/drivers/run-settlement';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { makeRequestContext } from '../helpers/make-context';

import type { RequestContext } from '@/app-layer/types';
import type { WorkflowDefinition } from '@/lib/agentic/workflow-types';

/**
 * THE FLUE DRIVER REFUSES BEFORE IT BOOTS ANYTHING (#3617).
 *
 * `driver.ts` measured **0% in the node project** and no test referenced it —
 * `runFlueDriver` and `flue/driver` appear in no test file. Its 37.5% in the
 * merged figure came from the module being loaded incidentally by guards, not
 * from anything exercising it.
 *
 * ── WHY THAT MATTERED, AND WHY THIS FILE CAN EXIST AT ALL ───────────────────
 *
 * It is the registry's entry point for the engine: `DRIVERS.flue` is this
 * function. Everything decidable about a run lives in `driver-plan.ts` and is
 * tested exhaustively there — but a plan nothing consults is inert, and nothing
 * checked that this function consults it, settles a refusal, or refuses BEFORE
 * `await import('./execute')`.
 *
 * That last point is what makes these tests possible in the node project at
 * all. The execution half sits behind a dynamic import precisely so the ESM
 * runtime stays off the static graph (`flue-refused-capabilities` keeps it
 * there). A refused run returns before that line, so every case below runs
 * under a project that cannot load the runtime — which is also the proof that
 * the refusal really does come first.
 *
 * ── HOW EACH RESIDENCY PATH IS IDENTIFIED ───────────────────────────────────
 *
 * By WHICH refusal it produces. The three paths resolve to three different
 * reasons, so no case has to reach a model call to show which branch it took.
 *
 * ── WHAT THIS FILE CANNOT COVER, AND WHY THAT IS THE DESIGN ────────────────
 *
 * Three statements stay uncovered: the `logger.warn` on the starting path, the
 * `await import('./execute')`, and the call it returns. They need the ESM
 * runtime, which this project cannot load — and the flue project, which can,
 * cannot load the Prisma that `failRun` and the settings read need. Neither
 * project can hold both halves, which is the split `driver-plan.ts` explains at
 * length and `flue-esm-modules-stay-off-the-static-graph` enforces.
 *
 * So 13/16 is the ceiling here rather than a gap left open, and the fact that
 * every case below runs at all is the evidence that the refusal returns before
 * that import. `tests/flue/` covers the executing half from the other side.
 */
const CTX: RequestContext = { ...makeRequestContext('ADMIN'), agentId: 'agent-1' };

const def = (over: Partial<WorkflowDefinition> = {}): WorkflowDefinition =>
    ({
        key: 'k',
        name: 'K',
        description: 'd',
        driver: 'flue',
        steps: [{ kind: 'READ', label: 'a', tool: 'list_risks' }],
        ...over,
    }) as WorkflowDefinition;

/** The sentence `failRun` was handed. */
const refusal = (): string => (failRun as jest.Mock).mock.calls[0]?.[2] as string;

beforeEach(() => {
    jest.clearAllMocks();
    settingsRow = null;
    delete envValues.ANTHROPIC_API_KEY;
    delete envValues.AI_LOCAL_BASE_URL;
    delete envValues.AI_LOCAL_MODEL;
});

describe('a run the plan refuses is settled, not thrown', () => {
    it('refuses a definition that asked for another driver, before any residency read', async () => {
        const out = await runFlueDriver(CTX, 'run-1', def({ driver: 'static' }), 0, Date.now());

        expect(refusal()).toMatch(/flue_driver_not_requested/);
        expect(out).toEqual({ status: 'FAILED', stepFailures: 0 });

        // THE ORDERING IS ABOUT WHICH REFUSAL WINS, NOT ABOUT THE READ.
        //
        // `planFlueRun` documents that "a definition that asked for the static
        // engine is refused before any residency arithmetic, because 'you asked
        // for something else' is a better answer than 'your local gateway is
        // unconfigured'" — and that holds: the reason returned is the driver
        // one.
        //
        // The tenant row is nonetheless READ, because `residencyTermsFor(ctx)`
        // is an ARGUMENT to the plan and so evaluates first. Asserted rather
        // than wished away: I expected the opposite and was wrong. It costs one
        // indexed lookup on a path that cannot use it, and the path is
        // defensive anyway — `selectRunDriver` sends a static definition to the
        // static driver, so a non-flue definition does not reach here in
        // production.
        expect(runInTenantContext).toHaveBeenCalledTimes(1);
    });

    it('SETTLES the refusal rather than throwing', async () => {
        // The run row already exists — `createSealedRun` wrote it before a
        // driver was chosen — so a throw would leave it RUNNING for the reaper
        // to settle on a wall-clock budget later, with an error nobody attached
        // to it. Every other halt in this subsystem ends as a FAILED row
        // carrying a sentence.
        await expect(
            runFlueDriver(CTX, 'run-1', def({ driver: 'static' }), 0, Date.now()),
        ).resolves.toBeDefined();
        expect(failRun).toHaveBeenCalledTimes(1);
    });

    it('reports a SENTENCE, not a bare enum value', async () => {
        // These land in `WorkflowRun.errorMessage`, which the run list and the
        // run detail page show an operator — so a code someone has to go and
        // look up is not an answer.
        await runFlueDriver(CTX, 'run-1', def({ driver: 'static' }), 0, Date.now());
        expect(refusal()).toMatch(/this workflow does not ask for the Flue engine/);
    });
});

describe('the tenant residency row decides which refusal a flue run gets', () => {
    it('treats an ABSENT row as EXTERNAL — and says the external credential is missing', async () => {
        // The documented default: "a tenant with no settings row resolves to
        // `undefined` throughout, which `resolveFlueModel` reads as EXTERNAL".
        // With no external credential configured, that default is identifiable
        // by the refusal it produces — no model call needed to see it.
        settingsRow = null;

        const out = await runFlueDriver(CTX, 'run-1', def(), 0, Date.now());

        expect(runInTenantContext).toHaveBeenCalled();
        expect(refusal()).toMatch(/external_credential_not_configured|EXTERNAL_CREDENTIAL/i);
        expect(out.stepFailures).toBe(0);
    });

    it('reads a LOCAL_ONLY row, and refuses when no gateway is configured', async () => {
        // The other branch, and the one that proves the row is actually read
        // rather than defaulted: the same deployment, the same absent external
        // key, a different refusal.
        settingsRow = { aiResidency: 'LOCAL_ONLY', aiLocalBaseUrl: null, aiLocalModel: null };

        await runFlueDriver(CTX, 'run-1', def(), 0, Date.now());

        expect(refusal()).toMatch(/local_gateway_not_configured/);
        // And it explains the RESIDENCY rather than just the gap — an operator
        // reading this has to know why moving the workspace is the other fix.
        expect(refusal()).toMatch(/LOCAL_ONLY|residency/i);
    });

    it('refuses a resume whose step budget is spent, before touching residency arithmetic', async () => {
        // `fromSeq` past the engine's cap. Ordered after the driver question and
        // before the model resolution, so this is identifiable too.
        await runFlueDriver(CTX, 'run-1', def(), 10_000, Date.now());
        expect(refusal()).toMatch(/flue_no_steps_remain/);
    });
});
