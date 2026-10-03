/**
 * THE TOOL BOUNDARY WITH OPEN FIELDS IN FORCE (#3051 step 5b).
 *
 * With exact-value sets the narrowing is TOTAL: the tool advertises one
 * argument, a label, and dispatches the row a human approved. A template gives
 * the model one choice back — a field, within a bound two humans approved — and
 * that is the only widening #3051 step 5b introduces. So the claims worth
 * proving are the edges of exactly that:
 *
 *   · a set that opens NOTHING behaves exactly as before, byte for byte;
 *   · the advertised schema offers the label PLUS the open fields, with their
 *     bounds, and nothing else;
 *   · `argsSchema` still refuses a key no set opens — the smuggled-argument
 *     case the total narrowing existed for;
 *   · `run` validates every supplied value against the STORED constraint, and
 *     fails CLOSED on an unknown name, a missing one, an unreadable bound, and
 *     a name that collides with an approved exact value;
 *   · the dispatched object is the approved values with the validated open ones
 *     merged, and nothing the model sent otherwise.
 *
 * Every refusal below is paired with the value that must still be ACCEPTED, so
 * a check that refuses everything cannot pass as a check that refuses the right
 * thing.
 */
const mockTx = {
    integrationConnection: { findMany: jest.fn() },
    mcpToolManifestPin: { findMany: jest.fn() },
    externalToolParameterSet: { findMany: jest.fn() },
    // #3051 step 5c — the target-population resolvers read these through the
    // same mocked `runInTenantContext`, so the dispatch refusals can be exercised
    // against a population whose contents this test controls.
    employee: { findMany: jest.fn() },
    identityAccountLink: { findMany: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockTx)),
}));

const listToolsMock = jest.fn();
const callToolMock = jest.fn();
jest.mock('@/app-layer/integrations/mcp/client', () => ({
    listTools: (...a: unknown[]) => listToolsMock(...a),
    callTool: (...a: unknown[]) => callToolMock(...a),
}));

jest.mock('@/app-layer/usecases/external-prior-state-read', () => ({
    getPriorStateRead: jest.fn(async () => null),
}));
jest.mock('@/app-layer/usecases/external-write-journal', () => ({
    recordIntent: jest.fn(async () => ({ journalId: 'jrn_1' })),
}));
jest.mock('@/app-layer/usecases/agent-proposals', () => ({
    createAgentProposal: jest.fn(async () => ({ id: 'prp_1', status: 'PENDING' })),
}));
jest.mock('@/lib/security/encryption', () => ({
    ...jest.requireActual('@/lib/security/encryption'),
    decryptField: (s: string) => s,
}));

import { NO_POLICY_CARD } from '@/lib/agentic/policy-card';
import { resolveExternalReadTools } from '@/lib/mcp/tools/external-tools';
import { externalToolName } from '@/lib/mcp/external-tool-name';
import { hashToolManifest } from '@/lib/mcp/tool-manifest';
import { MAX_VALUE_LENGTH, type ValueConstraint } from '@/lib/integrations/parameter-constraints';

const CONN = 'cmconnaaa';
const ctx = { tenantId: 'tnt_1' } as never;

const ALERTS = {
    name: 'list_alerts',
    description: 'List firing alerts.',
    inputSchema: { type: 'object', properties: { severity: { type: 'string' } } },
    annotations: { readOnlyHint: true },
};
const QUALIFIED = externalToolName(CONN, 'list_alerts');

const EMAIL: ValueConstraint = { kind: 'regex', pattern: '^[a-z.]{1,64}@company\\.test$' };
const SEVERITY: ValueConstraint = { kind: 'enum', values: ['low', 'high'] };

const pinFor = (def: typeof ALERTS) => {
    const h = hashToolManifest(def);
    return {
        toolName: QUALIFIED,
        descriptionHash: h.descriptionHash,
        schemaHash: h.schemaHash,
        manifestHash: h.manifestHash,
        revision: 1,
        approvedByUserId: 'usr_9',
        approvalSource: 'APPROVED',
    };
};

type SetRow = {
    toolName: string;
    label: string;
    parameters: Record<string, unknown>;
    openFields: unknown;
    targetPopulation?: string | null;
};
const sets = (...rows: Array<Omit<SetRow, 'toolName'>>) => {
    mockTx.externalToolParameterSet.findMany.mockResolvedValue(
        rows.map((r) => ({ toolName: QUALIFIED, ...r })),
    );
};

const theTool = async () => {
    const [tool] = await resolveExternalReadTools(ctx, new Set([QUALIFIED]), NO_POLICY_CARD);
    return tool;
};

beforeEach(() => {
    jest.clearAllMocks();
    mockTx.integrationConnection.findMany.mockResolvedValue([
        {
            id: CONN,
            name: 'Example MCP',
            configJson: { url: 'https://mcp.example.com' },
            secretEncrypted: JSON.stringify({ authorization: 'Bearer abc' }),
            externalWriteMode: 'DRY_RUN',
        },
    ]);
    mockTx.mcpToolManifestPin.findMany.mockResolvedValue([pinFor(ALERTS)]);
    mockTx.externalToolParameterSet.findMany.mockResolvedValue([]);
    mockTx.employee.findMany.mockResolvedValue([]);
    mockTx.identityAccountLink.findMany.mockResolvedValue([]);
    listToolsMock.mockResolvedValue([ALERTS]);
    callToolMock.mockResolvedValue({ content: [] });
});

describe('a set that opens nothing is unchanged', () => {
    it('still advertises only the label', async () => {
        sets({ label: 'prod', parameters: { query: 'up' }, openFields: null });
        const tool = await theTool();
        expect(tool.inputSchema).toEqual({
            type: 'object',
            properties: {
                parameterSet: {
                    type: 'string',
                    enum: ['prod'],
                    description: 'Which approved parameter set to run.',
                },
            },
            required: ['parameterSet'],
            additionalProperties: false,
        });
        expect(tool.description).not.toMatch(/open/i);
    });

    it('still dispatches the approved row and nothing the model sent', async () => {
        sets({ label: 'prod', parameters: { query: 'up' }, openFields: null });
        const tool = await theTool();
        await tool.run(ctx, { parameterSet: 'prod' });
        expect(callToolMock.mock.calls[0][2]).toEqual({ query: 'up' });
    });
});

describe('the advertised schema with open fields', () => {
    it('offers the label PLUS each open field with its bound', async () => {
        sets({
            label: 'prod',
            parameters: { userId: '7' },
            openFields: { workEmail: EMAIL },
        });
        const tool = await theTool();
        const props = (tool.inputSchema as { properties: Record<string, Record<string, unknown>> })
            .properties;
        expect(Object.keys(props).sort()).toEqual(['parameterSet', 'workEmail']);
        expect(props.workEmail).toMatchObject({
            type: 'string',
            pattern: EMAIL.kind === 'regex' ? EMAIL.pattern : '',
            maxLength: MAX_VALUE_LENGTH,
        });
        expect(tool.inputSchema).toMatchObject({
            required: ['parameterSet'],
            additionalProperties: false,
        });
        expect(tool.description).toMatch(/workEmail/);
    });

    it('says the bound VARIES when two sets disagree about one name', async () => {
        // There is one `inputSchema` per tool and one set is chosen per call,
        // so a name two sets bound differently cannot be advertised with one
        // bound. The model is told so; `run` enforces whichever applies.
        sets(
            { label: 'prod', parameters: {}, openFields: { severity: SEVERITY } },
            {
                label: 'staging',
                parameters: {},
                openFields: { severity: { kind: 'enum', values: ['low'] } },
            },
        );
        const tool = await theTool();
        const props = (tool.inputSchema as { properties: Record<string, Record<string, unknown>> })
            .properties;
        expect(props.severity).not.toHaveProperty('enum');
        expect(String(props.severity.description)).toMatch(/depends on which parameter set/);
    });

    it('advertises the shared bound when the two sets AGREE — the control', async () => {
        sets(
            { label: 'prod', parameters: {}, openFields: { severity: SEVERITY } },
            { label: 'staging', parameters: {}, openFields: { severity: { ...SEVERITY } } },
        );
        const tool = await theTool();
        const props = (tool.inputSchema as { properties: Record<string, Record<string, unknown>> })
            .properties;
        expect(props.severity).toMatchObject({ type: 'string', enum: ['low', 'high'] });
    });
});

describe('argsSchema still refuses what no set opens', () => {
    it('accepts the label plus a declared open field, and refuses anything else', async () => {
        sets({ label: 'prod', parameters: { userId: '7' }, openFields: { workEmail: EMAIL } });
        const tool = await theTool();
        expect(
            tool.argsSchema.safeParse({ parameterSet: 'prod', workEmail: 'a@company.test' }).success,
        ).toBe(true);
        // The smuggled-argument case the total narrowing exists for: an
        // undeclared key is a PARSE failure, so `run` is never entered.
        expect(
            tool.argsSchema.safeParse({ parameterSet: 'prod', query: 'up{job="secrets"}' }).success,
        ).toBe(false);
        expect(tool.argsSchema.safeParse({ parameterSet: 'nope' }).success).toBe(false);
    });
});

describe('run — every value is checked against the STORED bound', () => {
    beforeEach(() => {
        sets({ label: 'prod', parameters: { userId: '7' }, openFields: { workEmail: EMAIL } });
    });

    it('merges the approved values with the validated open one', async () => {
        const tool = await theTool();
        await tool.run(ctx, { parameterSet: 'prod', workEmail: 'first.last@company.test' });
        expect(callToolMock.mock.calls[0][2]).toEqual({
            userId: '7',
            workEmail: 'first.last@company.test',
        });
    });

    it('refuses a value outside the bound, and sends nothing', async () => {
        const tool = await theTool();
        await expect(
            tool.run(ctx, { parameterSet: 'prod', workEmail: 'evil@attacker.test' }),
        ).rejects.toThrow(/external_open_field_refused/);
        expect({ sent: callToolMock.mock.calls.length }).toEqual({ sent: 0 });
    });

    it('refuses a declared field left out', async () => {
        const tool = await theTool();
        await expect(tool.run(ctx, { parameterSet: 'prod' })).rejects.toThrow(
            /external_open_field_missing/,
        );
        expect({ sent: callToolMock.mock.calls.length }).toEqual({ sent: 0 });
    });

    it('refuses a supplied name this set does not open', async () => {
        // Reachable past `argsSchema` when ANOTHER set opens the name: the
        // schema is the union, `run` is the per-label authority.
        sets(
            { label: 'prod', parameters: { userId: '7' }, openFields: { workEmail: EMAIL } },
            { label: 'staging', parameters: { userId: '8' }, openFields: { severity: SEVERITY } },
        );
        const tool = await theTool();
        expect(
            tool.argsSchema.safeParse({
                parameterSet: 'prod',
                workEmail: 'a@company.test',
                severity: 'high',
            }).success,
        ).toBe(true);
        await expect(
            tool.run(ctx, {
                parameterSet: 'prod',
                workEmail: 'a@company.test',
                severity: 'high',
            }),
        ).rejects.toThrow(/external_open_field_unknown/);
        expect({ sent: callToolMock.mock.calls.length }).toEqual({ sent: 0 });
    });
});

describe('run — fails closed on bad configuration', () => {
    it('refuses a set whose stored bounds will not parse, and does NOT fall back', async () => {
        // The dangerous alternative is treating an unreadable blob as "no open
        // fields": the call would then dispatch exact values and look fine,
        // while the tool shape nobody reviewed had silently changed. The label
        // is KEPT in the enum so the tool does not widen back to the server's
        // own schema either.
        sets({ label: 'prod', parameters: { userId: '7' }, openFields: { workEmail: 'rubbish' } });
        const tool = await theTool();
        expect(tool.inputSchema).toMatchObject({ additionalProperties: false });
        expect(
            ((tool.inputSchema as { properties: Record<string, unknown> }).properties
                .parameterSet as { enum: string[] }).enum,
        ).toEqual(['prod']);
        await expect(tool.run(ctx, { parameterSet: 'prod' })).rejects.toThrow(
            /external_parameter_set_malformed/,
        );
        expect({ sent: callToolMock.mock.calls.length }).toEqual({ sent: 0 });
    });

    it('refuses an open field that shadows an approved exact value', async () => {
        // Refused at save time too. Checked again here because the merge order
        // means the open value would REPLACE the approved one, and a row that
        // predates the save-time check must not dispatch.
        sets({
            label: 'prod',
            parameters: { workEmail: 'fixed@company.test' },
            openFields: { workEmail: EMAIL },
        });
        const tool = await theTool();
        await expect(
            tool.run(ctx, { parameterSet: 'prod', workEmail: 'other@company.test' }),
        ).rejects.toThrow(/external_open_field_shadows_value/);
        expect({ sent: callToolMock.mock.calls.length }).toEqual({ sent: 0 });
    });
});

// ═════════════════════════════════════════════════════════════════════
// #3051 step 5c — THE TARGET FIELD AT THE TOOL BOUNDARY
//
// The target is the argument that says WHICH ROW the call is about, and its
// bound is a named population of our own data rather than a pattern. That makes
// the interesting assertions different in kind from the value-field ones above:
//
//   · the population is resolved AT DISPATCH, per call, so a row leaving it
//     between two calls stops being addressable immediately;
//   · the advertised schema does NOT enumerate the members;
//   · FIVE distinct refusals, because they are fixed by different people — an
//     unknown key is a deploy, an empty population is a stale feed, a failed
//     read is a broken database, and only the last is the model's mistake;
//   · nothing is sent on any of them.
//
// Each refusal is paired with the value that must still be ACCEPTED.
// ═════════════════════════════════════════════════════════════════════

const TARGET = { kind: 'target' } as const;
const POP = 'terminated_employee_work_emails';

/** The population returns exactly these work emails. */
const population = (...emails: string[]) => {
    mockTx.employee.findMany.mockResolvedValue(emails.map((workEmail) => ({ workEmail })));
};

describe('5c — the target is resolved at DISPATCH, not at assembly', () => {
    beforeEach(() => {
        sets({
            label: 'prod',
            parameters: { reason: 'offboarding' },
            openFields: { employeeEmail: TARGET },
            targetPopulation: POP,
        });
    });

    it('dispatches a value the population currently returns', async () => {
        population('gone@company.test', 'other@company.test');
        const tool = await theTool();
        await tool.run(ctx, { parameterSet: 'prod', employeeEmail: 'gone@company.test' });
        expect(callToolMock.mock.calls[0][2]).toEqual({
            reason: 'offboarding',
            employeeEmail: 'gone@company.test',
        });
    });

    it('refuses the SAME value once the data stops returning it', async () => {
        // THE REASON THE RESOLUTION IS NOT CACHED AT ASSEMBLY. One tool object,
        // two calls, and the only thing that changed is the data. A set resolved
        // when the invocation was built would still be sending this.
        population('gone@company.test');
        const tool = await theTool();
        await tool.run(ctx, { parameterSet: 'prod', employeeEmail: 'gone@company.test' });
        expect({ sent: callToolMock.mock.calls.length }).toEqual({ sent: 1 });

        population('someone.else@company.test');
        await expect(
            tool.run(ctx, { parameterSet: 'prod', employeeEmail: 'gone@company.test' }),
        ).rejects.toThrow(/external_target_not_in_population/);
        expect({ sent: callToolMock.mock.calls.length }).toEqual({ sent: 1 });
    });

    it('reads the population ONCE PER CALL, so the read is on the dispatch path', async () => {
        population('gone@company.test');
        const tool = await theTool();
        const readsAfterAssembly = mockTx.employee.findMany.mock.calls.length;
        expect(readsAfterAssembly).toBe(0);
        await tool.run(ctx, { parameterSet: 'prod', employeeEmail: 'gone@company.test' });
        expect(mockTx.employee.findMany.mock.calls.length).toBe(1);
    });

    it('resolves the population TENANT-SCOPED and bounded', async () => {
        population('gone@company.test');
        const tool = await theTool();
        await tool.run(ctx, { parameterSet: 'prod', employeeEmail: 'gone@company.test' });
        const query = mockTx.employee.findMany.mock.calls[0][0];
        // The tenant filter and the status predicate are what make this a
        // population rather than a table, and the `take` is what keeps it a
        // BOUND. A query missing any of the three would still pass every
        // membership assertion above.
        expect(query.where).toMatchObject({ tenantId: 'tnt_1', status: 'TERMINATED' });
        expect(typeof query.take).toBe('number');
        expect(query.take).toBeGreaterThan(0);
    });
});

describe('5c — the advertised schema describes the bound without listing it', () => {
    it('offers the target as a bounded string, naming the population', async () => {
        population('gone@company.test', 'other@company.test');
        sets({
            label: 'prod',
            parameters: { reason: 'offboarding' },
            openFields: { employeeEmail: TARGET },
            targetPopulation: POP,
        });
        const tool = await theTool();
        const props = (tool.inputSchema as { properties: Record<string, Record<string, unknown>> })
            .properties;
        expect(Object.keys(props).sort()).toEqual(['employeeEmail', 'parameterSet']);
        expect(props.employeeEmail).toMatchObject({ type: 'string', maxLength: MAX_VALUE_LENGTH });
        expect(props.employeeEmail).not.toHaveProperty('enum');
        expect(String(props.employeeEmail.description)).toContain(POP);
        // NO MEMBER OF THE POPULATION APPEARS ANYWHERE IN THE TOOL. A snapshot
        // in the listing would be a stale bound the model trusts, and it would
        // put tenant identifiers where nothing asked for them.
        const whole = JSON.stringify({ s: tool.inputSchema, d: tool.description });
        expect(whole).not.toContain('gone@company.test');
        expect(whole).not.toContain('other@company.test');
    });

    it('says the bound VARIES when two sets target different populations', async () => {
        sets(
            {
                label: 'prod',
                parameters: {},
                openFields: { employeeEmail: TARGET },
                targetPopulation: POP,
            },
            {
                label: 'staging',
                parameters: {},
                openFields: { employeeEmail: TARGET },
                targetPopulation: 'terminated_employee_hris_record_ids',
            },
        );
        const tool = await theTool();
        const props = (tool.inputSchema as { properties: Record<string, Record<string, unknown>> })
            .properties;
        expect(String(props.employeeEmail.description)).toMatch(/depends on which parameter set/);
    });

    it('advertises the shared population when the two sets AGREE — the control', async () => {
        sets(
            {
                label: 'prod',
                parameters: {},
                openFields: { employeeEmail: TARGET },
                targetPopulation: POP,
            },
            {
                label: 'staging',
                parameters: {},
                openFields: { employeeEmail: TARGET },
                targetPopulation: POP,
            },
        );
        const tool = await theTool();
        const props = (tool.inputSchema as { properties: Record<string, Record<string, unknown>> })
            .properties;
        expect(String(props.employeeEmail.description)).toContain(POP);
        expect(String(props.employeeEmail.description)).not.toMatch(/depends on which/);
    });
});

describe('5c — five refusals, each distinguishable, and nothing sent on any', () => {
    it('refuses an UNKNOWN population key — a removed or renamed registry entry', async () => {
        sets({
            label: 'prod',
            parameters: {},
            openFields: { employeeEmail: TARGET },
            targetPopulation: 'a_population_this_build_does_not_define',
        });
        const tool = await theTool();
        await expect(
            tool.run(ctx, { parameterSet: 'prod', employeeEmail: 'anything@company.test' }),
        ).rejects.toThrow(/external_target_population_unknown/);
        expect({ sent: callToolMock.mock.calls.length }).toEqual({ sent: 0 });
    });

    it('refuses an EMPTY population, and says so rather than blaming the value', async () => {
        // An empty population means the template is inert — a stale feed, a sync
        // that has not run — which is an operator's problem. Reporting it as "your
        // value is not in the set" would send the one person who can fix it
        // looking at the agent instead.
        population();
        sets({
            label: 'prod',
            parameters: {},
            openFields: { employeeEmail: TARGET },
            targetPopulation: POP,
        });
        const tool = await theTool();
        await expect(
            tool.run(ctx, { parameterSet: 'prod', employeeEmail: 'gone@company.test' }),
        ).rejects.toThrow(/external_target_population_empty/);
        expect({ sent: callToolMock.mock.calls.length }).toEqual({ sent: 0 });
    });

    it('refuses an UNRESOLVABLE population — "could not look" is not "nothing matched"', async () => {
        mockTx.employee.findMany.mockRejectedValue(new Error('connection terminated'));
        sets({
            label: 'prod',
            parameters: {},
            openFields: { employeeEmail: TARGET },
            targetPopulation: POP,
        });
        const tool = await theTool();
        await expect(
            tool.run(ctx, { parameterSet: 'prod', employeeEmail: 'gone@company.test' }),
        ).rejects.toThrow(/external_target_population_unresolvable/);
        expect({ sent: callToolMock.mock.calls.length }).toEqual({ sent: 0 });
    });

    it('refuses a population PAST THE CAP, because membership cannot be decided', async () => {
        // At the cap, "not in the population" and "past the cap" are
        // indistinguishable, so answering with the truncated set would answer the
        // question with the wrong one of those.
        mockTx.employee.findMany.mockImplementation(async (q: { take: number }) =>
            Array.from({ length: q.take }, (_, i) => ({ workEmail: `p${i}@company.test` })),
        );
        sets({
            label: 'prod',
            parameters: {},
            openFields: { employeeEmail: TARGET },
            targetPopulation: POP,
        });
        const tool = await theTool();
        await expect(
            tool.run(ctx, { parameterSet: 'prod', employeeEmail: 'p0@company.test' }),
        ).rejects.toThrow(/external_target_population_too_large/);
        expect({ sent: callToolMock.mock.calls.length }).toEqual({ sent: 0 });
    });

    it('refuses a non-string target, and a value outside the population', async () => {
        population('gone@company.test');
        sets({
            label: 'prod',
            parameters: {},
            openFields: { employeeEmail: TARGET },
            targetPopulation: POP,
        });
        const tool = await theTool();
        await expect(
            tool.run(ctx, { parameterSet: 'prod', employeeEmail: 7 }),
        ).rejects.toThrow(/external_target_not_a_string/);
        await expect(
            tool.run(ctx, { parameterSet: 'prod', employeeEmail: 'still.here@company.test' }),
        ).rejects.toThrow(/external_target_not_in_population/);
        expect({ sent: callToolMock.mock.calls.length }).toEqual({ sent: 0 });
        // The control: the member IS accepted, so the four refusals above are
        // about their rules and not about an unconditional block.
        await tool.run(ctx, { parameterSet: 'prod', employeeEmail: 'gone@company.test' });
        expect({ sent: callToolMock.mock.calls.length }).toEqual({ sent: 1 });
    });

    it('names the population SIZE and never a member', async () => {
        population('a@company.test', 'b@company.test');
        sets({
            label: 'prod',
            parameters: {},
            openFields: { employeeEmail: TARGET },
            targetPopulation: POP,
        });
        const tool = await theTool();
        const err = await tool
            .run(ctx, { parameterSet: 'prod', employeeEmail: 'c@company.test' })
            .catch((e: Error) => e);
        const message = (err as Error).message;
        expect(message).toContain('2 member(s)');
        // A count tells an operator whether the bound is doing work. A LIST would
        // hand the model every identifier it was not allowed to have.
        expect(message).not.toContain('a@company.test');
        expect(message).not.toContain('b@company.test');
    });
});

describe('5c — an incoherent row cannot dispatch at all', () => {
    it('refuses a target marker with NO population', async () => {
        // Unreachable through the usecase and through the database CHECK. Checked
        // here because this is the state in which the agent would choose a row
        // bounded by nothing, and the fail-closed reader is what guarantees a row
        // written by any other path cannot dispatch.
        population('gone@company.test');
        sets({
            label: 'prod',
            parameters: {},
            openFields: { employeeEmail: TARGET },
            targetPopulation: null,
        });
        const tool = await theTool();
        await expect(
            tool.run(ctx, { parameterSet: 'prod', employeeEmail: 'gone@company.test' }),
        ).rejects.toThrow(/external_parameter_set_malformed/);
        expect({ sent: callToolMock.mock.calls.length }).toEqual({ sent: 0 });
    });

    it('refuses a population with NO target marker', async () => {
        sets({
            label: 'prod',
            parameters: { userId: '7' },
            openFields: { workEmail: EMAIL },
            targetPopulation: POP,
        });
        const tool = await theTool();
        await expect(
            tool.run(ctx, { parameterSet: 'prod', workEmail: 'a@company.test' }),
        ).rejects.toThrow(/external_parameter_set_malformed/);
        expect({ sent: callToolMock.mock.calls.length }).toEqual({ sent: 0 });
    });

    it('refuses a target that shadows an approved exact value', async () => {
        // The widest version of the shadow bug: the open target would REPLACE
        // the row a human named with whatever the agent chose.
        population('gone@company.test');
        sets({
            label: 'prod',
            parameters: { employeeEmail: 'named.by.a.human@company.test' },
            openFields: { employeeEmail: TARGET },
            targetPopulation: POP,
        });
        const tool = await theTool();
        await expect(
            tool.run(ctx, { parameterSet: 'prod', employeeEmail: 'gone@company.test' }),
        ).rejects.toThrow(/external_open_field_shadows_value/);
        expect({ sent: callToolMock.mock.calls.length }).toEqual({ sent: 0 });
    });

    it('still refuses a target left out entirely', async () => {
        population('gone@company.test');
        sets({
            label: 'prod',
            parameters: {},
            openFields: { employeeEmail: TARGET },
            targetPopulation: POP,
        });
        const tool = await theTool();
        await expect(tool.run(ctx, { parameterSet: 'prod' })).rejects.toThrow(
            /external_open_field_missing/,
        );
        expect({ sent: callToolMock.mock.calls.length }).toEqual({ sent: 0 });
    });
});
