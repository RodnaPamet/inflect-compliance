/**
 * A READ-ONLY RUN WRITES NOTHING OUTSIDE THE PLATFORM EITHER (#5365).
 *
 * `offerToolSet` withheld only the PROPOSE list under `readOnly`, and external
 * tools ride the READ surface, so a Test run of an agent profile, an Ask run or
 * a Flue workflow with no PROPOSE step was still offered every write-classified
 * external tool and every A2A send. Their dispatch opens a proposal at
 * PROPOSE_ONLY, a journal row at DRY_RUN, and at AUTOMATIC a journal row the
 * dispatch pass sends with no approval.
 *
 * The offer now withholds them (unit-tested in `engine-tools-core.test.ts`).
 * This suite is the BACKSTOP, against a real database: a call that reaches the
 * dispatch anyway, on the context a read-only run's tools execute on
 * (`readOnlyRun`), opens no proposal, no journal row and no decision record at
 * any rung, and sends nothing — not even the prior-state read. The control
 * beside each refusal is the same call without the flag, so "nothing was
 * written" cannot pass for a call that never reached the seam.
 */
const listToolsMock = jest.fn();
const callToolMock = jest.fn();
jest.mock('@/app-layer/integrations/mcp/client', () => ({
    listTools: (...a: unknown[]) => listToolsMock(...a),
    callTool: (...a: unknown[]) => callToolMock(...a),
}));
jest.mock('@/app-layer/integrations/mcp/token', () => ({
    authorizationFor: jest.fn(async () => 'Bearer test-token'),
}));
jest.mock('@/lib/integrations/external-write-ladder', () => ({
    ...jest.requireActual('@/lib/integrations/external-write-ladder'),
    EXTERNAL_MAX_MODE: 'AUTOMATIC',
}));

import { PrismaClient, MembershipStatus, Role } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { hashForLookup } from '@/lib/security/encryption';
import { NO_POLICY_CARD } from '@/lib/agentic/policy-card';
import { externalToolName } from '@/lib/mcp/external-tool-name';
import { hashToolManifest } from '@/lib/mcp/tool-manifest';
import { resolveExternalReadTools } from '@/lib/mcp/tools/external-tools';
import { saveParameterSet } from '@/app-layer/usecases/external-tool-parameters';
import { dispatchA2aSend } from '@/app-layer/usecases/a2a-outbound';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const T = 'rorun-tenant';
const EMAIL = `owner@${T}.test`;
let userId = '';
let connectionId = '';
let WRITE = '';
let READ = '';

const WRITE_DEF = {
    name: 'disable_user',
    description: 'Disable a directory user.',
    inputSchema: { type: 'object', properties: { userPrincipalName: { type: 'string' } } },
    annotations: { readOnlyHint: false },
};
const READ_DEF = {
    name: 'get_user',
    description: 'Read a directory user.',
    inputSchema: { type: 'object', properties: { userPrincipalName: { type: 'string' } } },
    annotations: { readOnlyHint: true },
};
const LABEL = 'disable-leaver';
const ARGS = { userPrincipalName: 'leaver@rorun.test' };

const ctx = (): RequestContext => makeRequestContext('OWNER', { tenantId: T, tenantSlug: T, userId });
const readOnlyCtx = (): RequestContext => ({ ...ctx(), readOnlyRun: true });

const pinFor = (def: typeof WRITE_DEF, toolName: string) => {
    const h = hashToolManifest(def);
    return {
        tenantId: T,
        toolName,
        descriptionHash: h.descriptionHash,
        schemaHash: h.schemaHash,
        manifestHash: h.manifestHash,
        annotationsHash: h.annotationsHash,
        approvalSource: 'APPROVED' as const,
        approvedByUserId: userId,
        revision: 1,
    };
};

async function writesRecorded(): Promise<{ journal: number; proposals: number; decisions: number }> {
    return {
        journal: await prisma.externalWriteJournal.count({ where: { tenantId: T } }),
        proposals: await prisma.agentProposal.count({ where: { tenantId: T } }),
        decisions: await prisma.aiDecisionLog.count({ where: { tenantId: T } }),
    };
}

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: T };
    await prisma.externalWriteJournal.deleteMany({ where: t });
    await prisma.agentProposal.deleteMany({ where: t });
    await prisma.aiDecisionLog.deleteMany({ where: t });
    await prisma.externalToolPriorStateRead.deleteMany({ where: t });
    await prisma.externalToolParameterSetApproval.deleteMany({ where: t });
    await prisma.externalToolParameterSet.deleteMany({ where: t });
    await prisma.mcpToolManifestPin.deleteMany({ where: t });
    await prisma.integrationConnection.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, [T]);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, T);
    });
    await prisma.user.deleteMany({ where: { emailHash: hashForLookup(EMAIL) } });
    await prisma.tenant.deleteMany({ where: { id: T } });
}

async function theWriteTool() {
    const tools = await resolveExternalReadTools(ctx(), new Set([WRITE, READ]), NO_POLICY_CARD);
    const tool = tools.find((t) => t.name === WRITE);
    if (!tool) throw new Error(`the write tool did not resolve; got ${tools.map((t) => t.name)}`);
    return tool;
}

async function atRung(mode: 'DRY_RUN' | 'PROPOSE_ONLY' | 'AUTOMATIC'): Promise<void> {
    await prisma.integrationConnection.update({ where: { id: connectionId }, data: { externalWriteMode: mode } });
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();
    await prisma.tenant.create({ data: { id: T, name: T, slug: T } });
    const user = await prisma.user.create({ data: { email: EMAIL, emailHash: hashForLookup(EMAIL) } });
    userId = user.id;
    await prisma.tenantMembership.create({
        data: { tenantId: T, userId, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
    const conn = await prisma.integrationConnection.create({
        data: {
            tenantId: T,
            provider: 'mcp-server',
            name: 'Directory',
            isEnabled: true,
            configJson: { url: 'https://directory-mcp.example.test/mcp' },
            externalWriteMode: 'PROPOSE_ONLY',
            externalWriteModeSince: new Date('2026-09-01T00:00:00.000Z'),
        },
    });
    connectionId = conn.id;
    WRITE = externalToolName(connectionId, WRITE_DEF.name);
    READ = externalToolName(connectionId, READ_DEF.name);
    await prisma.mcpToolManifestPin.createMany({ data: [pinFor(WRITE_DEF, WRITE), pinFor(READ_DEF, READ)] });
    await prisma.externalToolPriorStateRead.create({
        data: { tenantId: T, writeToolName: WRITE, readToolName: READ },
    });
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

beforeEach(async () => {
    jest.clearAllMocks();
    await prisma.externalWriteJournal.deleteMany({ where: { tenantId: T } });
    await prisma.agentProposal.deleteMany({ where: { tenantId: T } });
    await prisma.aiDecisionLog.deleteMany({ where: { tenantId: T } });
    await prisma.externalToolParameterSet.deleteMany({ where: { tenantId: T } });
    listToolsMock.mockResolvedValue({ tools: [WRITE_DEF, READ_DEF], refusedNames: 0 });
    callToolMock.mockImplementation(async (_t: unknown, name: string) =>
        name === READ_DEF.name ? { accountEnabled: true } : { content: [] },
    );
});

describe('the external write dispatch refuses a read-only run at every rung (#5365)', () => {
    it.each(['DRY_RUN', 'PROPOSE_ONLY'] as const)(
        'at %s: no row, no proposal, nothing sent — while the same call outside a read-only run records one',
        async (mode) => {
            await atRung(mode);
            const tool = await theWriteTool();

            await expect(tool.run(readOnlyCtx(), ARGS)).rejects.toThrow(
                /external_write_refused_for_read_only_run[\s\S]*Nothing was sent\./,
            );
            expect(callToolMock).not.toHaveBeenCalled();
            expect(await writesRecorded()).toEqual({ journal: 0, proposals: 0, decisions: 0 });

            // THE CONTROL: the call reaches the seam, which is what makes the
            // empty tables above mean something.
            await tool.run(ctx(), ARGS);
            const after = await writesRecorded();
            expect(mode === 'DRY_RUN' ? after.journal : after.proposals).toBe(1);
        },
    );

    it('at AUTOMATIC, under an approved set: no journal row for the dispatch pass to send', async () => {
        await atRung('AUTOMATIC');
        await saveParameterSet(ctx(), { toolName: WRITE, label: LABEL, parameters: ARGS });
        const tool = await theWriteTool();

        await expect(tool.run(readOnlyCtx(), { parameterSet: LABEL })).rejects.toThrow(
            /external_write_refused_for_read_only_run/,
        );
        expect(callToolMock).not.toHaveBeenCalled();
        expect(await writesRecorded()).toEqual({ journal: 0, proposals: 0, decisions: 0 });

        await tool.run(ctx(), { parameterSet: LABEL });
        const rows = await prisma.externalWriteJournal.findMany({ where: { tenantId: T } });
        expect(rows.map((r) => [r.mode, r.outcome])).toEqual([['AUTOMATIC', 'PENDING']]);
    });

    it('an external READ still runs for a read-only run', async () => {
        const tools = await resolveExternalReadTools(ctx(), new Set([WRITE, READ]), NO_POLICY_CARD);
        const read = tools.find((t) => t.name === READ)!;

        await read.run(readOnlyCtx(), ARGS);

        expect(callToolMock.mock.calls.map((c) => c[1])).toEqual([READ_DEF.name]);
        expect(await writesRecorded()).toEqual({ journal: 0, proposals: 0, decisions: 0 });
    });
});

describe('the A2A send refuses a read-only run (#5365)', () => {
    it('before any read or row', async () => {
        await expect(
            dispatchA2aSend(readOnlyCtx(), {
                qualified: 'a2a__peer__send_task',
                peerId: 'peer-1',
                connection: { id: connectionId, name: 'Directory' },
                policyCardVersion: NO_POLICY_CARD,
                outbound: { text: 'please disable the leaver' },
                parameterSetLabel: null,
            }),
        ).rejects.toThrow(/a2a_send_refused_for_read_only_run[\s\S]*Nothing was sent\./);
        expect(await writesRecorded()).toEqual({ journal: 0, proposals: 0, decisions: 0 });
        expect(await prisma.peerAgentMessage.count({ where: { tenantId: T } })).toBe(0);
    });
});
