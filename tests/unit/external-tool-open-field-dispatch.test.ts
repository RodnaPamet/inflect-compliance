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
