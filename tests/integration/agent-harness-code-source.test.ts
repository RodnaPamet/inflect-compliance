/**
 * The LangChain and LangGraph detector's reports through the real ingest
 * (#3737), with no change to the contract beyond `inflect-agent-harness/2`.
 *
 *   1. The real scanner, pointed at the three fixture estates, signs a report
 *      the ingest verifies and records: one discovered agent per definition,
 *      `discoveredVia: ['code']`, its tools stored, and the planner's findings —
 *      not the scanner's — raised on them.
 *   2. A definition the detector cannot resolve makes the `code` source
 *      INCOMPLETE `UNPARSEABLE`, and the ingest raises INCOMPLETE_SOURCE naming
 *      the reason. The agent is still recorded.
 *   3. An estate may declare the `code` source with an owner, and its health
 *      reads that source from the scans.
 *   4. No literal written into the scanned code reaches a stored row.
 *   5. A coded agent's UNPINNED_WRITE_TOOL is judged by the `code` read (owner
 *      answer on #3754, 2026-10-19): a complete read whose definition has no
 *      unpinned write tool left closes it with no `mcp` source in the scan,
 *      and an incomplete one closes nothing.
 *   6. An Agent SDK agent (#4156) is a discovered agent like any other: SHADOW
 *      until the register links it, with its option verdicts stored as
 *      reported and standing in its HARNESS_SHORTFALL; the register's own
 *      intake record links it on the next complete scan.
 */
import { generateKeyPairSync } from 'crypto';
import { rmSync } from 'fs';
import { MembershipStatus, PrismaClient, Role } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import {
    AGENT_SDK_PY,
    AGENT_SDK_TS,
    LANGCHAIN_JS,
    LANGCHAIN_PYTHON,
    LANGGRAPH,
    PLAIN_LITERAL_KEY,
    UNPARSEABLE,
    fakeOpenAiKey,
    literalCredentials,
    writeCodeEstate,
} from '../helpers/agent-harness-code-fixtures';
import { createRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { ingestHarnessReport } from '@/app-layer/usecases/agent-harness-scans';
import { addHarnessScannerKey } from '@/app-layer/usecases/agent-harness-scanner-keys';
import { createHarnessEstate, getHarnessEstateHealth } from '@/app-layer/usecases/agent-harness-estates';
import {
    parseStoredHarnessModels,
    parseStoredHarnessSources,
    parseStoredHarnessTools,
    parseStoredHarnessVerdicts,
} from '@/lib/agentic/harness-contract';
import { runInTenantContext } from '@/lib/db-context';
import { parseScannerConfig } from '../../packages/agent-harness-scanner/src/config';
import { jsonLineLog } from '../../packages/agent-harness-scanner/src/log';
import { rawPublicKeyHex } from '../../packages/agent-harness-scanner/src/report';
import { runScan } from '../../packages/agent-harness-scanner/src/scan';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const T = 'harness-code-source';
const OWNER_EMAIL = `owner@${T}.test`;
let ownerUserId = '';
let scannerAgentId = '';
let signingPem = '';
const dirs: string[] = [];

const ctx = (): RequestContext => makeRequestContext('OWNER', { tenantId: T, tenantSlug: T, userId: ownerUserId });

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: T };
    await prisma.agentHarnessEstateSource.deleteMany({ where: t });
    await prisma.agentHarnessEstate.deleteMany({ where: t });
    await prisma.agentHarnessScanItem.deleteMany({ where: t });
    await prisma.agentHarnessScan.deleteMany({ where: t });
    await prisma.discoveredAgent.deleteMany({ where: t });
    await prisma.agentHarnessScannerKey.deleteMany({ where: t });
    await prisma.finding.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, [T]);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, T);
    });
    await prisma.user.deleteMany({ where: { emailHash: hashForLookup(OWNER_EMAIL) } });
    await prisma.tenant.deleteMany({ where: { id: T } });
}

/** Run the real scanner over `trees` as of `asOf`, and post its report through the real ingest. */
async function scanAndIngest(scanAt: number, ...trees: Readonly<Record<string, string>>[]) {
    const dir = writeCodeEstate(...trees);
    dirs.push(dir);
    const { raw } = await runScan({
        config: parseScannerConfig({
            estate: 'acme-code',
            scanner: { agentId: scannerAgentId, signingKeyEnv: 'SCANNER_SIGNING_KEY' },
            inflect: { baseUrl: 'https://inflect.example.com', tenantSlug: T, apiKeyEnv: 'INFLECT_INGEST_KEY' },
            schedule: { everyHours: 24 },
            sources: [{ kind: 'code', product: 'langchain', roots: [{ label: 'acme', path: dir }] }],
        }),
        env: { SCANNER_SIGNING_KEY: signingPem },
        log: jsonLineLog(() => undefined),
        fetchImpl: async () => {
            throw new Error('the code source makes no request');
        },
        now: () => scanAt,
    });
    return ingestHarnessReport(ctx(), raw);
}

async function openRefs(): Promise<string[]> {
    const rows = await prisma.finding.findMany({
        where: { tenantId: T, sourceKind: 'AGENT_HARNESS', status: { not: 'CLOSED' }, deletedAt: null },
        select: { sourceRef: true },
    });
    return rows.map((r) => r.sourceRef as string).sort();
}

const NOW = Date.now();

beforeAll(async () => {
    await clearOwnRows();
    await prisma.tenant.create({ data: { id: T, name: T, slug: T } });
    const user = await prisma.user.create({ data: { email: OWNER_EMAIL, emailHash: hashForLookup(OWNER_EMAIL) } });
    ownerUserId = user.id;
    await prisma.tenantMembership.create({ data: { tenantId: T, userId: user.id, role: Role.OWNER, status: MembershipStatus.ACTIVE } });
    const aiSystem = await prisma.aiSystem.create({ data: { tenantId: T, name: 'Scanner host', ownerUserId } });
    const scanner = await createRegisteredAgent(ctx(), {
        aiSystemId: aiSystem.id,
        name: 'Code scanner',
        autonomyLevel: 1,
        dataAccessScope: 'READ_TENANT_DATA',
        reversibility: 'COMPENSABLE',
        provenance: 'FIRST_PARTY',
        ownerUserId,
    });
    scannerAgentId = scanner.id;
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    signingPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    await addHarnessScannerKey(ctx(), { agentId: scanner.id, publicKey: rawPublicKeyHex(publicKey) });
});

afterAll(async () => {
    await clearOwnRows();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    await prisma.$disconnect();
});

const AGENTS = [
    'code:acme/ops/graph.py#oncall_agent',
    'code:acme/ops/graph.py#ops_graph',
    'code:acme/research/agent.ts#researchExecutor',
    'code:acme/research/triage.js#triageAgent',
    'code:acme/support/agent.py#support_executor',
];

describe('1. the detector\'s report verifies and ingests through the existing path', () => {
    it('records one discovered agent per definition, its tools, and the planner\'s findings', async () => {
        const result = await scanAndIngest(NOW - 3_600_000, LANGCHAIN_PYTHON, LANGCHAIN_JS, LANGGRAPH);
        expect(result).toMatchObject({ complete: true, agentCount: AGENTS.length });

        const agents = await prisma.discoveredAgent.findMany({
            where: { tenantId: T },
            select: { discoveredId: true, discoveredVia: true, registeredAgentId: true, ownerRef: true, lastLevel: true, lastReach: true },
            orderBy: { discoveredId: 'asc' },
        });
        expect(agents.map((a) => a.discoveredId)).toEqual(AGENTS);
        for (const a of agents) {
            // Code names no owner and no register link, and an undeclared
            // read-only hint is a write: shadow, at H0, write-capable.
            expect(a).toMatchObject({ discoveredVia: ['code'], registeredAgentId: null, ownerRef: null, lastLevel: 'H0', lastReach: 'WRITE_OR_EXTERNAL' });
        }

        const item = await prisma.agentHarnessScanItem.findFirstOrThrow({
            where: { tenantId: T, scanId: result.scanId, discoveredAgent: { discoveredId: 'code:acme/support/agent.py#support_executor' } },
            select: { toolsJson: true },
        });
        expect(parseStoredHarnessTools(item.toolsJson)?.map((t) => [t.name, t.server])).toEqual([
            ['lookup_order', 'code://acme/support/agent.py#L11'],
            ['refund_order', 'code://acme/support/agent.py#L17'],
            ['escalate_ticket', 'code://acme/support/agent.py#L26'],
            ['TavilySearchResults', 'code://acme/support/agent.py#L35'],
        ]);

        const refs = await openRefs();
        for (const id of AGENTS) {
            expect(refs).toContain(`SHADOW_AGENT:${id}`);
            expect(refs).toContain(`UNPINNED_WRITE_TOOL:${id}`);
            expect(refs).toContain(`HARNESS_SHORTFALL:${id}`);
        }
        expect(refs.some((r) => r.startsWith('INCOMPLETE_SOURCE:'))).toBe(false);

        // The model endpoints were in the signed report, verified with it, and
        // are kept on the agent's scan item and nowhere else (#3759).
        const models = await prisma.agentHarnessScanItem.findFirstOrThrow({
            where: { tenantId: T, scanId: result.scanId, discoveredAgent: { discoveredId: 'code:acme/support/agent.py#support_executor' } },
            select: { modelsJson: true },
        });
        expect(parseStoredHarnessModels(models.modelsJson)).toEqual({
            state: 'REPORTED',
            endpoints: [{ endpoint: 'https://llm-gateway.acme.example/v1', model: 'gpt-4o-mini' }],
        });
        const elsewhere = JSON.stringify([
            await prisma.agentHarnessScan.findMany({ where: { tenantId: T } }),
            await prisma.discoveredAgent.findMany({ where: { tenantId: T } }),
        ]);
        expect(elsewhere).not.toContain('https://llm-gateway.acme.example/v1');
    });
});

describe('2. an unresolvable definition: INCOMPLETE UNPARSEABLE, and the agent is still recorded', () => {
    it('raises INCOMPLETE_SOURCE for the code source, naming the reason, and stores the reason with the scan', async () => {
        const result = await scanAndIngest(NOW - 1_800_000, LANGCHAIN_PYTHON, UNPARSEABLE);
        expect(result.complete).toBe(false);
        const scan = await prisma.agentHarnessScan.findUniqueOrThrow({ where: { id: result.scanId }, select: { sourcesJson: true } });
        expect(parseStoredHarnessSources(scan.sourcesJson)).toEqual([{ kind: 'code', status: 'INCOMPLETE', rows: 3, reason: 'UNPARSEABLE' }]);
        expect(await prisma.discoveredAgent.count({ where: { tenantId: T, discoveredId: 'code:acme/dynamic/assistant.py#assistant' } })).toBe(1);

        const finding = await runInTenantContext(ctx(), (db) =>
            db.finding.findFirstOrThrow({
                where: { tenantId: T, sourceRef: `INCOMPLETE_SOURCE:${scannerAgentId}:code`, status: 'OPEN' },
                select: { description: true },
            }),
        );
        expect(finding.description).toContain('read source code incompletely (UNPARSEABLE)');
    });
});

describe('3. an estate declares the code source with an owner', () => {
    it('and its health reads that source from the latest complete scan', async () => {
        await createHarnessEstate(ctx(), {
            name: 'Acme agent code',
            scannerAgentId,
            cadenceHours: 24,
            sources: [{ kind: 'code', ownerUserId }],
        });
        await scanAndIngest(NOW - 600_000, LANGCHAIN_PYTHON, LANGCHAIN_JS, LANGGRAPH);
        const view = await getHarnessEstateHealth(ctx(), { now: new Date(NOW) });
        const row = view.estates.rows.find((r) => r.name === 'Acme agent code')!;
        expect(row).toMatchObject({ status: 'FRESH' });
        expect(row.sources.map((s) => [s.kind, s.status, s.latest?.state])).toEqual([['code', 'FRESH', 'COMPLETE']]);
    });
});

describe('4. no literal written into the scanned code reaches a stored row', () => {
    it('neither a secret-shaped one nor a plain one', async () => {
        await scanAndIngest(NOW - 300_000, literalCredentials());
        const scans = await prisma.agentHarnessScan.findMany({ where: { tenantId: T } });
        const items = await prisma.agentHarnessScanItem.findMany({ where: { tenantId: T } });
        const agents = await prisma.discoveredAgent.findMany({ where: { tenantId: T } });
        const findings = await runInTenantContext(ctx(), (db) => db.finding.findMany({ where: { tenantId: T }, select: { title: true, description: true } }));
        const audits = await prisma.auditLog.findMany({ where: { tenantId: T } });
        const text = JSON.stringify([scans, items, agents, findings, audits]);
        expect(text).toContain('code:acme/hardcoded/agent.py#hardcoded_py');
        for (const literal of [fakeOpenAiKey(), PLAIN_LITERAL_KEY]) expect(text).not.toContain(literal);
    });
});

describe('5. a coded agent\'s UNPINNED_WRITE_TOOL is judged by the code read (owner answer on #3754)', () => {
    const SUPPORT = 'code:acme/support/agent.py#support_executor';
    /** The support agent's definition with its tool list emptied. */
    const withoutTools = {
        'support/agent.py': LANGCHAIN_PYTHON['support/agent.py'].replace(
            'tools = [lookup_order, refund, escalate, TavilySearchResults(max_results=3)]',
            'tools = []',
        ),
    };
    const status = async (sourceRef: string) =>
        (await prisma.finding.findFirst({ where: { tenantId: T, sourceKind: 'AGENT_HARNESS', sourceRef, deletedAt: null }, select: { status: true } }))
            ?.status ?? null;

    it('an incomplete code read closes nothing; a complete one with no unpinned write tool left closes it, with no mcp source', async () => {
        expect(withoutTools['support/agent.py']).not.toEqual(LANGCHAIN_PYTHON['support/agent.py']);
        expect(await status(`UNPINNED_WRITE_TOOL:${SUPPORT}`)).toBe('OPEN');

        // The tools are gone from the definition, but another definition did
        // not resolve: the code source is INCOMPLETE, and is no evidence.
        const partial = await scanAndIngest(NOW - 200_000, withoutTools, UNPARSEABLE);
        expect(partial.complete).toBe(false);
        expect(await status(`UNPINNED_WRITE_TOOL:${SUPPORT}`)).toBe('OPEN');

        // Read in full: the definition, which the code source alone reports,
        // has no unpinned write tool, and the scan lists no mcp source at all.
        const full = await scanAndIngest(NOW - 100_000, withoutTools);
        expect(full.complete).toBe(true);
        const scan = await prisma.agentHarnessScan.findUniqueOrThrow({ where: { id: full.scanId }, select: { sourcesJson: true } });
        expect(parseStoredHarnessSources(scan.sourcesJson)?.map((x) => x.kind)).toEqual(['code']);
        expect(await status(`UNPINNED_WRITE_TOOL:${SUPPORT}`)).toBe('CLOSED');
    });
});

describe('6. an Agent SDK agent is discovered, shadowed, and linked by the existing rules (#4156)', () => {
    const OPS = 'code:acme/ops-bot/agent.ts#opsRun';
    const SUPPORT = 'code:acme/support-bot/agent.ts#options';

    it('records the SDK agents, with their option verdicts, and raises SHADOW and HARNESS_SHORTFALL on them', async () => {
        const result = await scanAndIngest(NOW - 90_000, AGENT_SDK_TS, AGENT_SDK_PY);
        expect(result).toMatchObject({ complete: true, agentCount: 5 });
        const agents = await prisma.discoveredAgent.findMany({
            where: { tenantId: T, discoveredId: { in: [OPS, SUPPORT] } },
            select: { discoveredId: true, discoveredVia: true, registeredAgentId: true, lastLevel: true },
            orderBy: { discoveredId: 'asc' },
        });
        expect(agents).toEqual([
            { discoveredId: OPS, discoveredVia: ['code'], registeredAgentId: null, lastLevel: 'H0' },
            { discoveredId: SUPPORT, discoveredVia: ['code'], registeredAgentId: null, lastLevel: 'H0' },
        ]);

        const item = await prisma.agentHarnessScanItem.findFirstOrThrow({
            where: { tenantId: T, scanId: result.scanId, discoveredAgent: { discoveredId: OPS } },
            select: { verdictsJson: true, blockingNextRung: true },
        });
        expect(parseStoredHarnessVerdicts(item.verdictsJson)).toEqual([
            { criterion: 'H2.tools_allowlisted', met: false, evidence: 'code://acme/ops-bot/agent.ts#L3' },
            { criterion: 'H3.propose_not_commit', met: false, evidence: 'code://acme/ops-bot/agent.ts#L8' },
            { criterion: 'H3.skills_declared', met: false, evidence: 'code://acme/ops-bot/agent.ts#L3' },
        ]);
        // The hardened agent reports no option verdict at all.
        const hardened = await prisma.agentHarnessScanItem.findFirstOrThrow({
            where: { tenantId: T, scanId: result.scanId, discoveredAgent: { discoveredId: SUPPORT } },
            select: { verdictsJson: true },
        });
        expect(parseStoredHarnessVerdicts(hardened.verdictsJson)).toEqual([]);

        const refs = await openRefs();
        for (const id of [OPS, SUPPORT]) {
            expect(refs).toContain(`SHADOW_AGENT:${id}`);
            expect(refs).toContain(`HARNESS_SHORTFALL:${id}`);
        }
    });

    it('the register\'s intake record links it on the next complete scan, which closes SHADOW_AGENT', async () => {
        const opsAgent = await prisma.discoveredAgent.findFirstOrThrow({ where: { tenantId: T, discoveredId: OPS }, select: { id: true } });
        // An AI system holds one register row; the scanner's holds the scanner.
        const aiSystem = await prisma.aiSystem.create({ data: { tenantId: T, name: 'Ops bot host', ownerUserId } });
        const registered = await createRegisteredAgent(ctx(), {
            aiSystemId: aiSystem.id,
            name: 'Ops bot',
            autonomyLevel: 1,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'COMPENSABLE',
            provenance: 'FIRST_PARTY',
            ownerUserId,
        });
        // What the registration intake writes when it registers a discovered agent.
        await prisma.registeredAgent.update({ where: { id: registered.id }, data: { intakeDiscoveredAgentId: opsAgent.id } });

        await scanAndIngest(NOW - 60_000, AGENT_SDK_TS, AGENT_SDK_PY);
        const linked = await prisma.discoveredAgent.findFirstOrThrow({ where: { tenantId: T, discoveredId: OPS }, select: { registeredAgentId: true } });
        expect(linked.registeredAgentId).toBe(registered.id);
        const refs = await openRefs();
        expect(refs).not.toContain(`SHADOW_AGENT:${OPS}`);
        expect(refs).toContain(`SHADOW_AGENT:${SUPPORT}`);
    });
});
