/**
 * #3301 — a human fills an approved template's open fields, and cannot widen it.
 *
 * WHAT IS BEING PROTECTED
 * ───────────────────────
 * The four-eyes trigger exists because an UNREVIEWED predicate is the risk. A
 * surface that let an operator edit the template rather than fill it would have
 * removed the control while looking like a feature — #3301 says so in as many
 * words, and it is the one requirement here with teeth.
 *
 * So the approved `parameters` are merged UNDER the open values and are never
 * part of the request at all. There is no shape a caller can send that changes
 * them, which is a stronger statement than "we validate the request".
 *
 * AND THE CHECKS ARE THE AGENT PATH'S CHECKS
 * ──────────────────────────────────────────
 * `parseOpenFields`, `refusalForValue` and `checkTargetInPopulation` are the
 * same primitives the agent path uses. That is the point rather than a
 * convenience: they are the teeth that make an approved template a bound
 * instead of a suggestion, and a second copy is a copy that can drift into
 * permitting what the agent path refuses. The third was private until this
 * issue extracted it.
 */
const findFirstSetMock = jest.fn();
const findFirstConnMock = jest.fn();
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_c: unknown, fn: (db: unknown) => unknown) =>
        fn({
            externalToolParameterSet: { findFirst: findFirstSetMock },
            integrationConnection: { findFirst: findFirstConnMock },
        }),
}));
jest.mock('@/lib/security/encryption', () => ({ decryptField: (v: string) => v }));

// PARAMETERS DECLARED, because the assertions index `mock.calls[0][1]`.
// A zero-arity `jest.fn` types `calls` as `[][]`, so indexing an argument is
// a type error — and the test would still PASS at runtime, which is how it
// goes unnoticed until `tsc` runs.
const callToolMock = jest.fn(
    async (_opts: unknown, _name: string, _args: Record<string, unknown>) => ({
        content: [{ type: 'text', text: '{"prior":true}' }],
    }),
);
jest.mock('@/app-layer/integrations/mcp/client', () => ({
    // Forwarded POSITIONALLY rather than spread through an empty-tuple cast:
    // the mock now declares three parameters so its arguments can be asserted,
    // and `...(a as [])` would pass none of them.
    callTool: (opts: unknown, name: string, args: Record<string, unknown>) =>
        callToolMock(opts, name, args),
}));
jest.mock('@/app-layer/integrations/mcp/token', () => ({
    authorizationFor: async () => 'Bearer conn.secret',
}));

const getPairingMock = jest.fn(async () => ({ readToolName: 'mcp__conn-1__get_thing' }));
jest.mock('@/app-layer/usecases/external-prior-state-read', () => ({
    getPriorStateRead: (...a: unknown[]) => getPairingMock(...(a as [])),
}));

const populationMock = jest.fn(async () => ({ ok: true }));
const resolveMock = jest.fn(async () => ({
    state: 'ok', key: 'employee_entra_account_ids', values: new Set(['subject-1', 'subject-2']),
}));
const labelMock = jest.fn(async (_c: unknown, _v: readonly string[]) =>
    new Map([['subject-1', 'Ada Lovelace (ada@example.test)']]));
jest.mock('@/app-layer/usecases/external-tool-target-populations', () => ({
    checkTargetInPopulation: (...a: unknown[]) => populationMock(...(a as [])),
    resolveTargetPopulation: (...a: unknown[]) => resolveMock(...(a as [])),
    // The registry, with a label resolver on the population the fixture names.
    TARGET_POPULATIONS: {
        employee_entra_account_ids: {
            key: 'employee_entra_account_ids',
            label: (c: unknown, v: readonly string[]) => labelMock(c, v),
        },
    },
}));

const createProposalMock = jest.fn(async () => ({
    id: 'prop-1', status: 'PENDING', guardVerdict: null,
}));
jest.mock('@/app-layer/usecases/agent-proposals', () => ({
    createAgentProposal: (...a: unknown[]) => createProposalMock(...(a as [])),
}));

import {
    composeExternalWriteProposal,
    describeComposeRefusal,
    listComposeOffer,
} from '@/app-layer/usecases/external-write-compose';
import { NO_POLICY_CARD } from '@/lib/agentic/policy-card';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('EDITOR', { tenantId: 'tenant-A' });
const SET_ID = 'set-1';

const set = (over: Record<string, unknown> = {}) => ({
    id: SET_ID,
    label: 'grant 7 days',
    toolName: 'mcp__conn-1__grant_time_bounded_access',
    parameters: { accessPackageId: 'pkg-1', assignmentPolicyId: 'pol-1' },
    // STORED shape: the marker only. `parseOpenFields` hydrates it with the
    // population from the row's own column — `TargetBound` is deliberately
    // distinct from what is stored.
    openFields: { targetId: { kind: 'target' } },
    targetPopulation: 'employee_entra_account_ids',
    ...over,
});

/** The arguments handed to createAgentProposal. */
const proposed = () => {
    const c = createProposalMock.mock.calls[0] as unknown as [unknown, { payload: { arguments: Record<string, unknown> }; policyCardVersion: number }];
    return c[1];
};

beforeEach(() => {
    jest.clearAllMocks();
    // RE-ESTABLISHED, not merely cleared. `clearAllMocks` resets recorded CALLS
    // and leaves IMPLEMENTATIONS in place, so a `mockResolvedValue` set inside
    // one test leaks into every later one — which is the cross-test cascade
    // this repo bans in E2E, and it is no better here. Every mock that any test
    // reconfigures is restored to its default below.
    getPairingMock.mockResolvedValue({ readToolName: 'mcp__conn-1__get_thing' });
    resolveMock.mockResolvedValue({
        state: 'ok', key: 'employee_entra_account_ids',
        values: new Set(['subject-1', 'subject-2']),
    });
    labelMock.mockResolvedValue(new Map([['subject-1', 'Ada Lovelace (ada@example.test)']]));
    callToolMock.mockResolvedValue({ content: [{ type: 'text', text: '{"prior":true}' }] });
    findFirstSetMock.mockResolvedValue(set());
    findFirstConnMock.mockResolvedValue({
        id: 'conn-1', name: 'Grant endpoint',
        configJson: { url: 'https://app.example.test/api/mcp/entra-grant' },
        secretEncrypted: JSON.stringify({ authorization: 'Bearer conn-1.s' }),
    });
    populationMock.mockResolvedValue({ ok: true });
    createProposalMock.mockResolvedValue({ id: 'prop-1', status: 'PENDING', guardVerdict: null });
});

describe('the happy path proposes, and never dispatches', () => {
    it('creates an EXTERNAL_WRITE proposal carrying the merged arguments', async () => {
        const out = await composeExternalWriteProposal(ctx, {
            parameterSetId: SET_ID, openFieldValues: { targetId: 'subject-1' },
        });
        expect(out.ok).toBe(true);
        expect(out.ok && out.proposalId).toBe('prop-1');
        const p = proposed();
        expect(p.payload.arguments).toEqual({
            accessPackageId: 'pkg-1', assignmentPolicyId: 'pol-1', targetId: 'subject-1',
        });
    });

    it('pins NO_POLICY_CARD, because a human proposal has no agent', async () => {
        // The sentinel rather than null: the row records that the question was
        // asked and the answer was "none".
        await composeExternalWriteProposal(ctx, {
            parameterSetId: SET_ID, openFieldValues: { targetId: 'subject-1' },
        });
        expect(proposed().policyCardVersion).toBe(NO_POLICY_CARD);
    });

    it('captures prior state through the PAIRED read before proposing', async () => {
        await composeExternalWriteProposal(ctx, {
            parameterSetId: SET_ID, openFieldValues: { targetId: 'subject-1' },
        });
        // The read tool's own name, from the pairing — not the write's.
        expect(callToolMock.mock.calls[0][1]).toBe('get_thing');
        const readAt = callToolMock.mock.invocationCallOrder[0];
        const proposedAt = createProposalMock.mock.invocationCallOrder[0];
        expect(readAt).toBeLessThan(proposedAt);
    });

    it('refuses when the tool has no prior-state pairing, rather than proposing blind', async () => {
        getPairingMock.mockResolvedValue(null as never);
        const out = await composeExternalWriteProposal(ctx, {
            parameterSetId: SET_ID, openFieldValues: { targetId: 'subject-1' },
        });
        expect(out.ok === false && out.refusal.kind).toBe('unpaired');
        expect(createProposalMock).not.toHaveBeenCalled();
    });

    it('an unreadable prior state is NOT reported as no prior state', async () => {
        callToolMock.mockRejectedValue(new Error('connection reset') as never);
        const out = await composeExternalWriteProposal(ctx, {
            parameterSetId: SET_ID, openFieldValues: { targetId: 'subject-1' },
        });
        expect(out.ok === false && out.refusal.kind).toBe('prior_state_unreadable');
        expect(createProposalMock).not.toHaveBeenCalled();
        const text = describeComposeRefusal({ kind: 'prior_state_unreadable', detail: 'x' });
        expect(text).toContain('we could not look');
    });
});

describe('the surface can FILL open fields and cannot WIDEN them', () => {
    it('REFUSES a key the template does not open', async () => {
        // The load-bearing assertion. If this passed, the approved template
        // would be a suggestion and the re-approval requirement would protect
        // nothing.
        const out = await composeExternalWriteProposal(ctx, {
            parameterSetId: SET_ID,
            openFieldValues: { targetId: 'subject-1', assignmentPolicyId: 'pol-ATTACKER' },
        });
        expect(out.ok === false && out.refusal.kind).toBe('field_not_opened');
        expect(createProposalMock).not.toHaveBeenCalled();
    });

    it('the approved values are NOT part of the request, so they cannot be edited', async () => {
        // Submitting an approved key is refused by the check above; this asserts
        // the stronger property — what is sent comes from the ROW, not the
        // caller. A caller that omits everything still gets the template.
        await composeExternalWriteProposal(ctx, {
            parameterSetId: SET_ID, openFieldValues: { targetId: 'subject-1' },
        });
        expect(proposed().payload.arguments.accessPackageId).toBe('pkg-1');
        expect(proposed().payload.arguments.assignmentPolicyId).toBe('pol-1');
    });

    it('refuses an open field left unfilled', async () => {
        const out = await composeExternalWriteProposal(ctx, {
            parameterSetId: SET_ID, openFieldValues: {},
        });
        expect(out.ok === false && out.refusal.kind).toBe('field_missing');
    });

    it('refuses a field that shadows an approved exact value', async () => {
        // The template itself is wrong: the open value would be merged over the
        // approved one, so the approved value would never be sent while still
        // reading as in force.
        findFirstSetMock.mockResolvedValue(
            // `targetPopulation: null` as well: a template that NAMES a
            // population while opening no target field is incoherent and
            // `parseOpenFields` refuses it, which would mask the check under
            // test with an unreadable-bounds refusal.
            set({
                openFields: { accessPackageId: { kind: 'enum', values: ['pkg-2'] } },
                targetPopulation: null,
            }),
        );
        const out = await composeExternalWriteProposal(ctx, {
            parameterSetId: SET_ID, openFieldValues: { accessPackageId: 'pkg-2' },
        });
        expect(out.ok === false && out.refusal.kind).toBe('field_shadows_value');
    });

    it('refuses a value outside its approved bound, using the SHARED check', async () => {
        findFirstSetMock.mockResolvedValue({
            ...set(),
            parameters: { accessPackageId: 'pkg-1' },
            openFields: { note: { kind: 'enum', values: ['alpha', 'beta'] } },
            targetPopulation: null,
        });
        const out = await composeExternalWriteProposal(ctx, {
            parameterSetId: SET_ID, openFieldValues: { note: 'gamma' },
        });
        expect(out.ok === false && out.refusal.kind).toBe('value_refused');
        expect(createProposalMock).not.toHaveBeenCalled();
    });

    it('refuses a subject outside the approved population, and says which way', async () => {
        populationMock.mockResolvedValue({ ok: false, kind: 'not_a_member', size: 12 } as never);
        const out = await composeExternalWriteProposal(ctx, {
            parameterSetId: SET_ID, openFieldValues: { targetId: 'not-ours' },
        });
        expect(out.ok === false && out.refusal.kind).toBe('target_refused');
        const text = out.ok === false ? describeComposeRefusal(out.refusal) : '';
        expect(text).toContain('12 member(s)');
        expect(createProposalMock).not.toHaveBeenCalled();
    });

    it('does NOT collapse "could not look" into "not allowed" for a population', async () => {
        // The distinction `resolveTargetPopulation` exists to preserve: a
        // caller told "not allowed" when the truth is "the read failed" would
        // go and change the subject rather than the database.
        populationMock.mockResolvedValue({ ok: false, kind: 'unresolvable', detail: 'db down' } as never);
        const out = await composeExternalWriteProposal(ctx, {
            parameterSetId: SET_ID, openFieldValues: { targetId: 'subject-1' },
        });
        const text = out.ok === false ? describeComposeRefusal(out.refusal) : '';
        expect(text).toContain('NOT');
        expect(text).toContain('db down');
    });

    it('refuses a template whose open-field bounds will not parse', async () => {
        // Keeping the label but refusing is the safe direction: widening back
        // to the server's own schema would be the alternative.
        findFirstSetMock.mockResolvedValue(set({ openFields: { 'not a valid name!': {} } }));
        const out = await composeExternalWriteProposal(ctx, {
            parameterSetId: SET_ID, openFieldValues: {},
        });
        expect(out.ok === false && out.refusal.kind).toBe('open_fields_unreadable');
    });
});

describe('every refusal names a different action', () => {
    it('the sentences are DISTINCT — a collapse would make the union pointless', () => {
        const texts = [
            describeComposeRefusal({ kind: 'set_not_found' }),
            describeComposeRefusal({ kind: 'open_fields_unreadable' }),
            describeComposeRefusal({ kind: 'field_not_opened', field: 'x' }),
            describeComposeRefusal({ kind: 'field_shadows_value', field: 'x' }),
            describeComposeRefusal({ kind: 'field_missing', field: 'x' }),
            describeComposeRefusal({ kind: 'value_refused', field: 'x', detail: 'd' }),
            describeComposeRefusal({
                kind: 'target_refused',
                field: 'targetId',
                // A realistic detail, because this sentence is composed from a
                // caller-supplied clause rather than owned whole.
                detail: 'must name a row in the approved population "employee_entra_account_ids".',
            }),
            describeComposeRefusal({ kind: 'tool_name_unusable' }),
            describeComposeRefusal({ kind: 'connection_unusable' }),
            describeComposeRefusal({ kind: 'unpaired' }),
            describeComposeRefusal({ kind: 'prior_state_unreadable', detail: 'd' }),
        ];
        expect(new Set(texts).size).toBe(texts.length);
        texts.forEach((t) => expect(t.length).toBeGreaterThan(30));
    });
});

// ═════════════════════════════════════════════════════════════════════
// WHAT THE FORM MAY OFFER — #3301
// ═════════════════════════════════════════════════════════════════════

describe('listComposeOffer — a picker of people, not GUIDs', () => {
    it('labels a candidate the population knows, and falls back to the raw id', async () => {
        // The fallback is the load-bearing half: a label resolver that
        // under-returns must lose a NAME, never a candidate. Losing a candidate
        // would make the bound a function of the presentation layer.
        const out = await listComposeOffer(ctx, SET_ID);
        expect(out.ok).toBe(true);
        const target = out.ok ? out.fields.find((f) => f.kind === 'target') : undefined;
        expect(target?.candidates).toEqual([
            { value: 'subject-1', label: 'Ada Lovelace (ada@example.test)' },
            { value: 'subject-2', label: 'subject-2' },
        ]);
    });

    it('a BROKEN label resolver loses names, not candidates', async () => {
        labelMock.mockRejectedValue(new Error('join exploded') as never);
        const out = await listComposeOffer(ctx, SET_ID);
        const target = out.ok ? out.fields.find((f) => f.kind === 'target') : undefined;
        expect(target?.candidates?.map((c) => c.value)).toEqual(['subject-1', 'subject-2']);
        expect(target?.candidates?.every((c) => c.value === c.label)).toBe(true);
    });

    it('offers NO approved parameter values, so the form cannot render them editable', async () => {
        const out = await listComposeOffer(ctx, SET_ID);
        const names = out.ok ? out.fields.map((f) => f.name) : [];
        expect(names).toEqual(['targetId']);
        expect(names).not.toContain('accessPackageId');
        expect(names).not.toContain('assignmentPolicyId');
    });

    it('resolves the population PER REQUEST rather than once', async () => {
        // A cached list would be a snapshot presented as a live bound: the first
        // subject to leave the population would stay offerable.
        await listComposeOffer(ctx, SET_ID);
        await listComposeOffer(ctx, SET_ID);
        expect(resolveMock).toHaveBeenCalledTimes(2);
    });

    it.each([
        ['empty', { state: 'empty', key: 'p' }, 'no candidates'],
        ['unresolvable', { state: 'unresolvable', key: 'p', detail: 'db down' }, 'NOT'],
        ['too_large', { state: 'too_large', key: 'p', cap: 500 }, 'cannot be checked'],
    ])('a %s population says WHY rather than showing an empty picker', async (_l, res, needle) => {
        resolveMock.mockResolvedValue(res as never);
        const out = await listComposeOffer(ctx, SET_ID);
        const target = out.ok ? out.fields.find((f) => f.kind === 'target') : undefined;
        expect(target?.candidates).toBeUndefined();
        expect(target?.unavailable ?? '').toContain(needle);
    });

    it('refuses a template that does not exist', async () => {
        findFirstSetMock.mockResolvedValue(null);
        const out = await listComposeOffer(ctx, SET_ID);
        expect(out.ok === false && out.refusal.kind).toBe('set_not_found');
    });
});
