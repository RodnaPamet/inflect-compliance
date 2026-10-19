/**
 * The LangSmith source through the real ingest, against a real database (#3738).
 *
 *   1. A FIXTURE ESTATE INGESTS UNCHANGED. The reference scanner reads the fake
 *      LangSmith workspace, signs, and the ingest verifies the very bytes it
 *      signed: the stored digest is the digest of the signed body, and the
 *      discovered agents and their tools are the ones the source found.
 *   2. WHAT THE INGEST DERIVES from a runtime source, by the contract's rules
 *      and nothing the source suggested: every agent unregistered is a shadow
 *      agent, and a tool with no declared hint and no pin is an unpinned write
 *      tool. The estate declaring the `runtime` source reads it as fresh.
 *   3. AN EMPTY WINDOW IS EMPTY_SCAN through the real ingest, and the estate
 *      does not count it as a complete scan.
 *   4. THE KEY AND THE CONTENT ARE NOWHERE: not in a stored harness row and not
 *      in an audit row.
 */
import { generateKeyPairSync } from 'crypto';
import { MembershipStatus, PrismaClient, Role } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import {
    createSourceFakes,
    INGEST,
    LANGSMITH_API_KEY_VALUE,
    LANGSMITH_MARKERS,
    LANGSMITH_US,
    langSmithFixture,
    LS,
    NEVER_REPORTED,
    type Fakes,
} from '../helpers/agent-harness-source-fakes';
import { harnessSignedMessage, verifyAndParseHarnessReport } from '@/lib/agentic/harness-contract';
import { createRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { ingestHarnessReport } from '@/app-layer/usecases/agent-harness-scans';
import { addHarnessScannerKey } from '@/app-layer/usecases/agent-harness-scanner-keys';
import { createHarnessEstate, getHarnessEstateHealth } from '@/app-layer/usecases/agent-harness-estates';
import { parseScannerConfig } from '../../packages/agent-harness-scanner/src/config';
import { jsonLineLog } from '../../packages/agent-harness-scanner/src/log';
import { rawPublicKeyHex } from '../../packages/agent-harness-scanner/src/report';
import { runScan } from '../../packages/agent-harness-scanner/src/scan';
import { reportableToolName } from '../../packages/agent-harness-scanner/src/sources/langsmith';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(180_000);

const T1 = 'harness-langsmith-one';
const HOUR = 3_600_000;
const START = Date.now();

let ownerUserId = '';
let scannerAgentId = '';
let scannerPem = '';
let scannerPublicKey = '';
let fakes: Fakes;

const ctx = (): RequestContext => makeRequestContext('OWNER', { tenantId: T1, tenantSlug: T1, userId: ownerUserId });
const ownerEmail = `owner@${T1}.test`;

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: T1 };
    await prisma.agentHarnessEstateSource.deleteMany({ where: t });
    await prisma.agentHarnessEstate.deleteMany({ where: t });
    await prisma.agentHarnessAcceptance.deleteMany({ where: t });
    await prisma.agentHarnessScanItem.deleteMany({ where: t });
    await prisma.agentHarnessScan.deleteMany({ where: t });
    await prisma.discoveredAgent.deleteMany({ where: t });
    await prisma.agentHarnessScannerKey.deleteMany({ where: t });
    await prisma.finding.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, [T1]);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, T1);
    });
    await prisma.user.deleteMany({ where: { emailHash: hashForLookup(ownerEmail) } });
    await prisma.tenant.deleteMany({ where: { id: T1 } });
}

/** Run the real scanner, LangSmith only, as of `hoursAgo`; return the signed report it would post. */
async function scan(hoursAgo: number): Promise<{ raw: string; lines: string[] }> {
    const config = parseScannerConfig({
        estate: 'acme-agents',
        scanner: { agentId: scannerAgentId, signingKeyEnv: 'SCANNER_SIGNING_KEY' },
        inflect: { baseUrl: INGEST, tenantSlug: T1, apiKeyEnv: 'INFLECT_INGEST_KEY' },
        schedule: { everyHours: 24 },
        sources: [{ kind: 'runtime', product: 'langsmith', endpoint: { cloud: 'us' }, apiKeyEnv: 'LANGSMITH_API_KEY' }],
    });
    const lines: string[] = [];
    const { raw } = await runScan({
        config,
        env: { SCANNER_SIGNING_KEY: scannerPem, LANGSMITH_API_KEY: LANGSMITH_API_KEY_VALUE },
        log: jsonLineLog((l) => lines.push(l)),
        fetchImpl: fakes.fetchImpl,
        now: () => START - hoursAgo * HOUR,
    });
    return { raw, lines };
}

/** Every stored row this tenant's harness and audit trail hold, as text. */
async function storedText(): Promise<string> {
    const tables = ['AgentHarnessScan', 'AgentHarnessScanItem', 'DiscoveredAgent', 'AuditLog'];
    const parts: string[] = [];
    for (const table of tables) {
        const rows = await prisma.$queryRawUnsafe<{ j: string }[]>(
            `SELECT row_to_json(t)::text AS j FROM "${table}" t WHERE "tenantId" = $1`,
            T1,
        );
        parts.push(...rows.map((r) => r.j));
    }
    const findings = await prisma.finding.findMany({ where: { tenantId: T1 }, select: { title: true, sourceRef: true } });
    parts.push(JSON.stringify(findings));
    return parts.join('\n');
}

const openRefs = async () =>
    (
        await prisma.finding.findMany({
            where: { tenantId: T1, sourceKind: 'AGENT_HARNESS', status: { not: 'CLOSED' }, deletedAt: null },
            select: { sourceRef: true },
        })
    ).map((f) => f.sourceRef as string);

beforeAll(async () => {
    await clearOwnRows();
    await prisma.tenant.create({ data: { id: T1, name: T1, slug: T1 } });
    const user = await prisma.user.create({ data: { email: ownerEmail, name: 'owner', emailHash: hashForLookup(ownerEmail) } });
    await prisma.tenantMembership.create({ data: { tenantId: T1, userId: user.id, role: Role.OWNER, status: MembershipStatus.ACTIVE } });
    ownerUserId = user.id;
    const aiSystem = await prisma.aiSystem.create({ data: { tenantId: T1, name: 'Scanner host', ownerUserId } });
    const agent = await createRegisteredAgent(ctx(), {
        aiSystemId: aiSystem.id,
        name: 'Harness scanner for the agents estate',
        autonomyLevel: 1,
        dataAccessScope: 'READ_TENANT_DATA',
        reversibility: 'COMPENSABLE',
        provenance: 'FIRST_PARTY',
        ownerUserId,
    });
    scannerAgentId = agent.id;
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    scannerPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    scannerPublicKey = rawPublicKeyHex(publicKey);
    await addHarnessScannerKey(ctx(), { agentId: agent.id, publicKey: scannerPublicKey });
    await createHarnessEstate(ctx(), {
        name: 'Acme agents',
        scannerAgentId,
        cadenceHours: 24,
        sources: [{ kind: 'runtime', ownerUserId }],
    });
    // The workspace's runs sit days before NOW, so the seven-day window holds them.
    fakes = createSourceFakes({ langsmith: { [LANGSMITH_US]: langSmithFixture(new Date(START).toISOString()) } });
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('1. a fixture estate ingests unchanged', () => {
    it('the ingest verifies the signed bytes, stores their digest, and holds the agents with their tools', async () => {
        const { raw, lines } = await scan(2);
        const verified = verifyAndParseHarnessReport(raw, [scannerPublicKey]);
        if (!verified.ok) throw new Error(`the report did not verify: ${verified.reason}`);

        const result = await ingestHarnessReport(ctx(), raw);
        expect(result).toMatchObject({ complete: true, agentCount: 3 });

        const stored = await prisma.agentHarnessScan.findFirstOrThrow({ where: { tenantId: T1, scanRef: verified.body.scan.id } });
        const { signature: _signature, ...signedBody } = JSON.parse(raw) as Record<string, unknown>;
        expect(stored.reportDigest).toBe(harnessSignedMessage(signedBody).toString('hex'));
        expect(stored.sourcesJson).toEqual([{ kind: 'runtime', status: 'COMPLETE', rows: 6 }]);

        const items = await prisma.agentHarnessScanItem.findMany({
            where: { tenantId: T1, scanId: stored.id },
            include: { discoveredAgent: { select: { discoveredId: true, discoveredVia: true, ownerRef: true } } },
        });
        const byId = new Map(items.map((i) => [i.discoveredAgent.discoveredId, i]));
        expect([...byId.keys()].sort()).toEqual([
            `langsmith:deployment:${LS.deploymentSupport}`,
            `langsmith:deployment:${LS.deploymentIdle}`,
            `langsmith:project:${LS.projectResearch}`,
        ]);
        const toolNames = (id: string) => (byId.get(id)?.toolsJson as { name: string }[]).map((t) => t.name);
        expect(toolNames(`langsmith:deployment:${LS.deploymentSupport}`)).toEqual(['refund_order', 'search_orders']);
        expect(toolNames(`langsmith:deployment:${LS.deploymentIdle}`)).toEqual([]);
        expect(toolNames(`langsmith:project:${LS.projectResearch}`)).toEqual([
            reportableToolName(LANGSMITH_MARKERS.dynamicRunName),
            'web_search',
        ]);
        for (const item of items) expect(item.discoveredAgent).toMatchObject({ discoveredVia: ['runtime'], ownerRef: null });
        // A tool nobody declared read-only is a write: the agents that call tools reach further.
        expect(byId.get(`langsmith:deployment:${LS.deploymentSupport}`)?.reach).toBe('WRITE_OR_EXTERNAL');
        expect(byId.get(`langsmith:deployment:${LS.deploymentIdle}`)?.reach).toBe('UNKNOWN');

        // The counts the contract cannot carry reached the log as a total.
        expect(lines.find((l) => l.includes('"source read"'))).toContain('"toolCalls":7');
    });
});

describe('2. what the ingest derives from a runtime source', () => {
    it('every agent is a shadow agent, and each tool-calling one has an unpinned write tool', async () => {
        const refs = await openRefs();
        for (const id of [LS.deploymentSupport, LS.deploymentIdle]) expect(refs).toContain(`SHADOW_AGENT:langsmith:deployment:${id}`);
        expect(refs).toContain(`SHADOW_AGENT:langsmith:project:${LS.projectResearch}`);
        expect(refs).toContain(`UNPINNED_WRITE_TOOL:langsmith:deployment:${LS.deploymentSupport}`);
        expect(refs).toContain(`UNPINNED_WRITE_TOOL:langsmith:project:${LS.projectResearch}`);
        expect(refs).not.toContain(`UNPINNED_WRITE_TOOL:langsmith:deployment:${LS.deploymentIdle}`);
        expect(refs.some((r) => r.startsWith('EMPTY_SCAN:'))).toBe(false);
    });

    it('the estate that declares the runtime source reads it as fresh', async () => {
        const view = await getHarnessEstateHealth(ctx(), { now: new Date(START + 60_000) });
        const row = view.estates.rows.find((r) => r.name === 'Acme agents');
        expect(row).toMatchObject({ status: 'FRESH', latest: { completeness: 'COMPLETE' } });
        expect(row?.sources.map((s) => [s.kind, s.status, s.latest?.state])).toEqual([['runtime', 'FRESH', 'COMPLETE']]);
    });
});

describe('3. an empty window is EMPTY_SCAN, not a clean bill', () => {
    it('a later scan whose window holds nothing raises EMPTY_SCAN and is not the estate\'s complete scan', async () => {
        const quiet = langSmithFixture(new Date(START).toISOString());
        quiet.deployments = [];
        for (const p of quiet.projects) for (const r of p.runs) (r as { startTime: string }).startTime = '2026-01-01T00:00:00.000Z';
        fakes = createSourceFakes({ langsmith: { [LANGSMITH_US]: quiet } });

        const { raw } = await scan(1);
        const result = await ingestHarnessReport(ctx(), raw);
        expect(result).toMatchObject({ complete: true, agentCount: 0 });
        expect(await openRefs()).toContain(`EMPTY_SCAN:${scannerAgentId}`);

        // Nothing the earlier scan found is resolved by a scan that saw nothing.
        expect(await openRefs()).toContain(`SHADOW_AGENT:langsmith:deployment:${LS.deploymentSupport}`);

        const view = await getHarnessEstateHealth(ctx(), { now: new Date(START + 60_000) });
        const row = view.estates.rows.find((r) => r.name === 'Acme agents');
        expect(row?.latest?.completeness).toBe('EMPTY');
        expect(row?.lastComplete?.at).toBe(new Date(START - 2 * HOUR).toISOString());
    });
});

describe('4. the key and the content are nowhere in what was stored', () => {
    it('no stored harness row and no audit row carries the API key or a marker of run content', async () => {
        const text = await storedText();
        expect(text.length).toBeGreaterThan(0);
        expect(text).toContain('AGENT_HARNESS_SCAN_INGESTED');
        for (const marker of [...NEVER_REPORTED, LANGSMITH_API_KEY_VALUE]) expect(text).not.toContain(marker);
    });
});
