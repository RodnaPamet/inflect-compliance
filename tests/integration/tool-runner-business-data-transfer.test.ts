/**
 * THE TOOL RUNNER ASKS THE EXTERNAL-AI TRANSFER GATE (#5364, #3872), END TO END.
 *
 * Real database, real usecases, real invocation build, real offer and funnel,
 * the worker's own body; the model is a fake `fetch` answering Anthropic's
 * Messages API and the external MCP server is a fake transport. The tenant
 * holds one `mcp-server` connection marked as reaching a business system, and
 * an ACTIVE agent granted one read tool on it.
 *
 *   • with no acknowledgement on record, the run is FAILED with the gate's
 *     named reason, naming the connection, and the model receives NO request:
 *     the Tool Runner always calls Anthropic, so it is always outside the
 *     deployment, and a business system's rows may not go there unacknowledged;
 *   • with the acknowledgement recorded, the same run reaches the model and
 *     the business-system tool, and completes (the positive control: without
 *     it, an engine that refused every external tool would pass the first).
 *
 * Before #5364 the Tool Runner built the same offer the Flue engine builds and
 * never asked the gate, so the first case sent the request.
 */
const envOverride: Record<string, string | undefined> = {
    AGENT_DRIVER_TOOL_RUNNER: '1',
    ANTHROPIC_API_KEY: 'sk-ant-integration-faux-key', // pragma: allowlist secret -- a placeholder; the fake fetch answers every request
};
jest.mock('@/env', () => {
    const actual = jest.requireActual('@/env') as { env: Record<string, unknown> };
    return {
        env: new Proxy(actual.env, {
            get: (target, key) => (typeof key === 'string' && key in envOverride ? envOverride[key] : Reflect.get(target, key)),
        }),
    };
});
jest.mock('@/app-layer/jobs/queue', () => ({
    ...jest.requireActual('@/app-layer/jobs/queue'),
    enqueue: jest.fn(async () => undefined),
}));
// THE EXTERNAL MCP SERVER, at its transport. Everything above it — the grant,
// the manifest pin, the rung, the offer, the funnel — is real.
const listToolsMock = jest.fn();
const callToolMock = jest.fn();
jest.mock('@/app-layer/integrations/mcp/client', () => ({
    listTools: (...a: unknown[]) => listToolsMock(...a),
    callTool: (...a: unknown[]) => callToolMock(...a),
}));
jest.mock('@/app-layer/integrations/mcp/token', () => ({
    authorizationFor: jest.fn(async () => 'Bearer test-token'),
}));

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { registerWorkflow } from '@/lib/agentic/workflow-registry';
import { executeQueuedWorkflowRun, startWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import { externalToolName } from '@/lib/mcp/external-tool-name';
import { hashToolManifest } from '@/lib/mcp/tool-manifest';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `trbd-${randomUUID().slice(0, 8)}`;
const T = `t-${SUITE}`;
const OWNER = `u-owner-${SUITE}`;
const AGENT = `ag-${SUITE}`;
const CONNECTION_NAME = `Ledger ERP ${SUITE}`;
const WORKFLOW = `wf-${SUITE}`;

const READ_DEF = {
    name: 'get_order',
    description: 'Read one sales order.',
    inputSchema: { type: 'object', properties: { orderId: { type: 'string' } } },
    annotations: { readOnlyHint: true },
};

let toolName = '';

// ─── The fake model ─────────────────────────────────────────────────

const wire = { bodies: [] as Array<Record<string, unknown>> };
const originalFetch = global.fetch;

function installFakeModel(): void {
    wire.bodies = [];
    global.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const n = wire.bodies.length;
        wire.bodies.push(body);
        const answer =
            n === 0
                ? { content: [{ type: 'tool_use', id: 'toolu_0', name: toolName, input: { orderId: 'o1' } }], stop_reason: 'tool_use' }
                : { content: [{ type: 'text', text: 'One open order.' }], stop_reason: 'end_turn' };
        return new Response(
            JSON.stringify({
                id: `msg_${n}`,
                type: 'message',
                role: 'assistant',
                model: String(body.model),
                stop_sequence: null,
                usage: { input_tokens: 10, output_tokens: 5 },
                ...answer,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        );
    }) as typeof fetch;
}

const agentCtx = () => ({ ...makeRequestContext('OWNER', { tenantId: T, tenantSlug: T, userId: OWNER }), agentId: AGENT });

async function runOnce(): Promise<{ status: string; errorMessage: string | null }> {
    installFakeModel();
    const started = await startWorkflowRun(agentCtx(), WORKFLOW, {});
    await executeQueuedWorkflowRun(T, started.runId);
    return prisma.workflowRun.findUniqueOrThrow({
        where: { id: started.runId },
        select: { status: true, errorMessage: true },
    });
}

async function cleanup(): Promise<void> {
    const where = { tenantId: T };
    await prisma.workflowStep.deleteMany({ where });
    await prisma.aiDecisionLog.deleteMany({ where });
    await prisma.workflowRun.deleteMany({ where });
    await prisma.mcpToolManifestPin.deleteMany({ where });
    await prisma.registeredAgentTool.deleteMany({ where });
    await prisma.registeredAgent.deleteMany({ where });
    await prisma.aiSystem.deleteMany({ where });
    await prisma.integrationConnection.deleteMany({ where });
    await prisma.tenantSecuritySettings.deleteMany({ where });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, T);
    });
    await deleteAuditRowsForTenants(prisma, [T]);
    await prisma.user.deleteMany({ where: { id: OWNER } });
    await prisma.tenant.deleteMany({ where: { id: T } });
}

describeFn('the Tool Runner asks the external-AI transfer gate (real DB, fake model)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await cleanup();
        await createTenantWithDek({ id: T, name: T, slug: T });
        const email = `${OWNER}@example.test`;
        await prisma.user.create({ data: { id: OWNER, email, emailHash: hashForLookup(email) } });
        await prisma.tenantMembership.create({ data: { tenantId: T, userId: OWNER, role: 'OWNER', status: 'ACTIVE' } });

        const connection = await prisma.integrationConnection.create({
            data: {
                tenantId: T,
                provider: 'mcp-server',
                name: CONNECTION_NAME,
                isEnabled: true,
                configJson: { url: 'https://ledger-mcp.example.test/mcp' },
                // Reads are reachable from DRY_RUN up (#2861).
                externalWriteMode: 'DRY_RUN',
                externalWriteModeSince: new Date('2026-09-01T00:00:00.000Z'),
                reachesBusinessSystem: true,
            },
        });
        toolName = externalToolName(connection.id, READ_DEF.name);
        const h = hashToolManifest(READ_DEF);
        await prisma.mcpToolManifestPin.create({
            data: {
                tenantId: T,
                toolName,
                descriptionHash: h.descriptionHash,
                schemaHash: h.schemaHash,
                manifestHash: h.manifestHash,
                annotationsHash: h.annotationsHash,
                approvalSource: 'APPROVED',
                approvedByUserId: OWNER,
                revision: 1,
            },
        });

        const sys = await prisma.aiSystem.create({ data: { tenantId: T, name: `sys-${SUITE}` } });
        await prisma.registeredAgent.create({
            data: {
                id: AGENT,
                tenantId: T,
                aiSystemId: sys.id,
                name: `agent ${SUITE}`,
                // An external read is an autonomy-2 call, and an agent that
                // reaches outside the deployment is scoped EXTERNAL_EGRESS,
                // which floors its tier at HIGH.
                autonomyLevel: 2,
                dataAccessScope: 'EXTERNAL_EGRESS',
                reversibility: 'REVERSIBLE',
                provenance: 'FIRST_PARTY',
                ownerUserId: OWNER,
                status: 'ACTIVE',
                riskTier: 'HIGH',
                riskTierScoredAt: new Date(),
            },
        });
        await prisma.registeredAgentTool.create({ data: { tenantId: T, agentId: AGENT, toolName, grantedByUserId: OWNER } });
        await prisma.tenantSecuritySettings.create({ data: { tenantId: T, agentDriver: 'TOOL_RUNNER' } });

        registerWorkflow({
            key: WORKFLOW,
            name: 'Order review',
            description: 'Read the open sales order and say what it is.',
            driver: 'tool-runner',
            readOnly: true,
            steps: [{ kind: 'SYNTHESIS', label: 'Report the order', synthesize: () => ({ text: 'ok' }) }],
        });
    });

    beforeEach(() => {
        listToolsMock.mockReset().mockResolvedValue({ tools: [READ_DEF], refusedNames: 0 });
        callToolMock.mockReset().mockResolvedValue({ order: { id: 'o1', status: 'open' } });
    });

    afterAll(async () => {
        global.fetch = originalFetch;
        await cleanup();
        await prisma.$disconnect();
    });

    it('unacknowledged: the run is FAILED with the gate`s reason, and the model receives nothing', async () => {
        const run = await runOnce();
        expect(run.status).toBe('FAILED');
        expect(run.errorMessage).toMatch(/^tool_runner_external_ai_business_data_unacknowledged: /);
        expect(run.errorMessage).toContain(`(${CONNECTION_NAME})`);
        expect(wire.bodies).toHaveLength(0);
        expect(callToolMock).not.toHaveBeenCalled();
        // Non-vacuity: the connection's catalogue WAS read, so the tool was in
        // the offer the gate judged — the refusal is about it, not its absence.
        expect(listToolsMock).toHaveBeenCalled();
    });

    it('acknowledged: the same run reaches the model and the business-system tool, and completes', async () => {
        await prisma.tenantSecuritySettings.update({
            where: { tenantId: T },
            data: { externalAiBusinessDataAckAt: new Date(), externalAiBusinessDataAckByUserId: OWNER },
        });
        const run = await runOnce();
        expect(run).toEqual({ status: 'COMPLETED', errorMessage: null });
        expect(wire.bodies).toHaveLength(2);
        expect((wire.bodies[0].tools as Array<{ name: string }>).map((t) => t.name)).toEqual([toolName]);
        expect(callToolMock).toHaveBeenCalledTimes(1);
        expect(callToolMock.mock.calls[0][1]).toBe(READ_DEF.name);
    });
});
