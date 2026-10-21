/**
 * The four AI switches as a tenant setting.
 *
 * The properties worth pinning, in order of what they cost if wrong:
 *
 *   1. ATOMICITY — the flag and its audit row commit together. The module
 *      toggle next door shipped without this and spent #3172/#3175 telling an
 *      owner nothing had changed while production carried the change.
 *   2. The DEFAULT — an absent settings row reads as ALL ON. The opposite of
 *      `processCanvasEnabled`, and the opposite mistake would disable AI for
 *      every tenant nobody had visited.
 *   3. The PARTIAL patch — a request naming one switch leaves the others alone,
 *      so two owners editing different rows do not overwrite each other.
 *   4. The NO-OP — writing the value that is already there is not an event.
 *   5. Env state is REPORTED, not enforced on write. Storing "on" while the
 *      deploy forbids it records intent for when the platform permits it.
 */
/*
    ATOMICITY IS ASSERTED BY SHAPE, because a mock has no transactions.

    `runInTenantContext` IS a `$transaction`, so a pass-through mock cannot roll
    anything back and no assertion about outcomes can distinguish "both writes in
    one transaction" from "two transactions, the first already committed". That
    difference is precisely the defect (#3175). So this harness records, per
    `runInTenantContext` call, WHICH writes ran inside it — the same approach as
    `process-canvas-module.test.ts` and `org-tenant-delete.test.ts`.
*/
const transactions: string[][] = [];
let openTx: string[] | null = null;
const inTx = (label: string) => {
    if (openTx) openTx.push(label);
    else transactions.push([`OUTSIDE-ANY-TRANSACTION:${label}`]);
};

let storedRow: Record<string, boolean> | null = null;

const db = {
    tenantSecuritySettings: {
        findUnique: jest.fn(async () => {
            inTx('findUnique');
            return storedRow as unknown;
        }),
        upsert: jest.fn(async ({ update, create }: { update: Record<string, boolean>; create: Record<string, boolean> }) => {
            inTx('upsert');
            const base = storedRow ?? {
                aiEnabled: true,
                aiRiskSuggestionsEnabled: true,
                aiAssistantEnabled: true,
                aiQuestionnaireEnabled: true,
            };
            storedRow = { ...base, ...(storedRow ? update : create) };
            return storedRow;
        }),
    },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: async (_c: unknown, fn: (d: unknown) => unknown) => {
        const writes: string[] = [];
        const outer = openTx;
        openTx = writes;
        try {
            return await fn(db);
        } finally {
            openTx = outer;
            transactions.push(writes);
        }
    },
}));

const logEvent = jest.fn(async (..._args: unknown[]) => {
    inTx('logEvent');
    return undefined;
});
jest.mock('@/app-layer/events/audit', () => ({ logEvent: (...a: unknown[]) => logEvent(...a) }));

// Env state under test control. requireActual-spread so the rest of the gate's
// exports keep working for anything else in the graph.
const envState = { master: true, risk: true, assistant: true, questionnaire: true };
jest.mock('@/app-layer/ai/risk-assessment/feature-gate', () => {
    const actual = jest.requireActual('@/app-layer/ai/risk-assessment/feature-gate');
    return {
        ...actual,
        isAIRiskEnabled: () => envState.master,
        isAiFeatureEnabled: (feature: 'risk' | 'assistant' | 'questionnaire') => envState[feature],
    };
});

import type { RequestContext } from '@/app-layer/types';
import {
    readAiFeatureToggles,
    setAiFeatureToggles,
    toggleStatesFrom,
} from '@/app-layer/usecases/ai-feature-toggles';

const ctx = { userId: 'u1', tenantId: 't1', requestId: 'r1' } as unknown as RequestContext;

beforeEach(() => {
    transactions.length = 0;
    openTx = null;
    storedRow = null;
    logEvent.mockClear();
    db.tenantSecuritySettings.findUnique.mockClear();
    db.tenantSecuritySettings.upsert.mockClear();
    Object.assign(envState, { master: true, risk: true, assistant: true, questionnaire: true });
});

describe('reading', () => {
    it('an ABSENT row reads as all four on', async () => {
        const states = await readAiFeatureToggles(ctx);
        expect(states.map((s) => s.key)).toEqual(['ai', 'risk', 'assistant', 'questionnaire']);
        expect(states.every((s) => s.tenantEnabled && s.effective)).toBe(true);
    });

    it('a tenant master of off makes every FEATURE ineffective, master included', async () => {
        storedRow = {
            aiEnabled: false,
            aiRiskSuggestionsEnabled: true,
            aiAssistantEnabled: true,
            aiQuestionnaireEnabled: true,
        };
        const states = await readAiFeatureToggles(ctx);
        expect(states.every((s) => s.effective === false)).toBe(true);
        // The features' OWN switches are still reported as on — the page has to
        // be able to say "this is on but not running", which is the whole point
        // of `off-by-master`.
        expect(states.filter((s) => s.key !== 'ai').every((s) => s.tenantEnabled)).toBe(true);
    });

    it('reports an env-forced feature as forcedOffByEnv while keeping the tenant value', async () => {
        envState.assistant = false;
        const states = await readAiFeatureToggles(ctx);
        const assistant = states.find((s) => s.key === 'assistant')!;
        expect(assistant).toMatchObject({
            tenantEnabled: true,
            envEnabled: false,
            effective: false,
            forcedOffByEnv: true,
        });
        // The OTHER features are unaffected — a per-feature env flag is not the
        // master switch.
        expect(states.find((s) => s.key === 'risk')!.effective).toBe(true);
    });

    it('the env MASTER off forces every row off, including the three features', async () => {
        envState.master = false;
        const states = await readAiFeatureToggles(ctx);
        expect(states.every((s) => s.forcedOffByEnv && !s.effective)).toBe(true);
    });
});

describe('writing', () => {
    it('writes ONLY the keys in the patch', async () => {
        storedRow = {
            aiEnabled: true,
            aiRiskSuggestionsEnabled: true,
            aiAssistantEnabled: true,
            aiQuestionnaireEnabled: true,
        };
        const { changed } = await setAiFeatureToggles(ctx, { assistant: false });
        expect(changed).toEqual(['assistant']);
        const update = db.tenantSecuritySettings.upsert.mock.calls[0][0].update;
        // Exactly one column — not all four with three unchanged values, which
        // is what would let a second owner's concurrent edit be undone.
        expect(Object.keys(update)).toEqual(['aiAssistantEnabled']);
        expect(storedRow).toMatchObject({ aiAssistantEnabled: false, aiRiskSuggestionsEnabled: true });
    });

    it('flips several switches in one request', async () => {
        const { changed } = await setAiFeatureToggles(ctx, { risk: false, questionnaire: false });
        expect(changed).toEqual(['risk', 'questionnaire']);
        expect(Object.keys(db.tenantSecuritySettings.upsert.mock.calls[0][0].create).sort()).toEqual(
            ['aiQuestionnaireEnabled', 'aiRiskSuggestionsEnabled', 'tenantId'],
        );
    });

    it('a NO-OP writes nothing and audits nothing', async () => {
        storedRow = {
            aiEnabled: true,
            aiRiskSuggestionsEnabled: true,
            aiAssistantEnabled: true,
            aiQuestionnaireEnabled: true,
        };
        const result = await setAiFeatureToggles(ctx, { assistant: true });
        expect(result.changed).toEqual([]);
        expect(db.tenantSecuritySettings.upsert).not.toHaveBeenCalled();
        expect(logEvent).not.toHaveBeenCalled();
        // And it still answers with the real state rather than nothing.
        expect(result.states.find((s) => s.key === 'assistant')!.tenantEnabled).toBe(true);
    });

    it('a no-op against an ABSENT row is still a no-op', async () => {
        // The absent row reads as ON, so `{ ai: true }` changes nothing — and a
        // comparison that treated "absent" as false would create a row and write
        // an audit entry recording a transition that never happened.
        const result = await setAiFeatureToggles(ctx, { ai: true });
        expect(result.changed).toEqual([]);
        expect(db.tenantSecuritySettings.upsert).not.toHaveBeenCalled();
    });

    it('the flag and its audit row are in ONE transaction', async () => {
        await setAiFeatureToggles(ctx, { ai: false });
        const withWrites = transactions.filter((t) => t.length > 0);
        expect(withWrites).toHaveLength(1);
        expect(withWrites[0]).toEqual(['findUnique', 'upsert', 'logEvent']);
        // No write escaped to the outside, which is how the harness reports a
        // second transaction.
        expect(transactions.flat().some((label) => label.startsWith('OUTSIDE'))).toBe(false);
    });

    it('audits as status_change with both states named', async () => {
        storedRow = {
            aiEnabled: true,
            aiRiskSuggestionsEnabled: true,
            aiAssistantEnabled: true,
            aiQuestionnaireEnabled: true,
        };
        await setAiFeatureToggles(ctx, { assistant: false });
        const entry = logEvent.mock.calls[0][2] as {
            action: string;
            detailsJson: { category: string; fromStatus: string; toStatus: string };
            metadata: { changed: string[] };
        };
        expect(entry.action).toBe('AI_FEATURE_TOGGLES_CHANGED');
        // `status_change`, NOT `configuration` — that value is absent from
        // `AuditDetailsJsonSchema`'s enum and 400'd the module route (#3170).
        expect(entry.detailsJson.category).toBe('status_change');
        expect(entry.detailsJson.fromStatus).toBe('assistant=on');
        expect(entry.detailsJson.toStatus).toBe('assistant=off');
        expect(entry.metadata.changed).toEqual(['assistant']);
    });

    it('ACCEPTS turning on a feature the env currently forbids', async () => {
        // Deliberate. The row records what the tenant wants for when the
        // platform permits it; refusing would make stored intent depend on a
        // deploy that may be reversed an hour later. The effective answer is
        // computed, never stored — so the state still reports it as off.
        envState.assistant = false;
        storedRow = {
            aiEnabled: true,
            aiRiskSuggestionsEnabled: true,
            aiAssistantEnabled: false,
            aiQuestionnaireEnabled: true,
        };
        const result = await setAiFeatureToggles(ctx, { assistant: true });
        expect(result.changed).toEqual(['assistant']);
        const assistant = result.states.find((s) => s.key === 'assistant')!;
        expect(assistant.tenantEnabled).toBe(true);
        expect(assistant.effective).toBe(false);
        expect(assistant.forcedOffByEnv).toBe(true);
    });
});

describe('toggleStatesFrom is the pure comparison, and can fail', () => {
    it('maps a partial row, defaulting absent columns to on', () => {
        const states = toggleStatesFrom({ aiAssistantEnabled: false });
        expect(states.find((s) => s.key === 'assistant')!.tenantEnabled).toBe(false);
        expect(states.find((s) => s.key === 'risk')!.tenantEnabled).toBe(true);
    });

    it('a master of false makes features ineffective without changing their own value', () => {
        const states = toggleStatesFrom({ aiEnabled: false, aiRiskSuggestionsEnabled: true });
        const risk = states.find((s) => s.key === 'risk')!;
        expect(risk.tenantEnabled).toBe(true);
        expect(risk.effective).toBe(false);
    });
});
