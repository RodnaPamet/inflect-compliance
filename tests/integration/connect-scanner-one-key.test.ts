/**
 * ONE KEY POSTS EVERY REPORT IT NAMES (owner decision, 2026-11-24).
 *
 * "Connect a scanner" creates one API key, bound to the scanner's agent,
 * carrying the ingest scope of every ticked report. This holds that against the
 * real stack: the key is minted by the REAL `createApiKey` with the scopes the
 * panel computes (`scannerKeyScopes`), the register read's token exchange
 * included, and then used as a Bearer at the three REAL ingest routes, each with
 * a report the scanner's registered signing key signed:
 *
 *   • the agent report, the integrations report and the agent-surface report
 *     are each accepted (201) and stored;
 *   • a key the panel made for two reports is refused at the third (403), so
 *     the scopes, not the binding, decide what a key posts.
 */
import { MembershipStatus, PrismaClient, Role } from '@prisma/client';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

import { prismaTestClient } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { createFakeScanner, validV3ReportBody, type FakeScanner } from '../helpers/agent-harness-fake-scanner';
import { agentRulesBody } from '../helpers/agent-rule-fake-report';
import { integrationsBody } from '../helpers/third-party-app-fake-report';
import { createApiKey } from '@/app-layer/usecases/api-keys';
import { addHarnessScannerKey } from '@/app-layer/usecases/agent-harness-scanner-keys';
import { scannerKeyCeiling, scannerKeyRequiresExchange, scannerKeyScopes, type ScannerConnectSelection } from '@/lib/agentic/scanner-connect';
import { POST as postHarnessScan } from '@/app/api/t/[tenantSlug]/admin/agents/harness-scans/route';
import { POST as postIntegrationsScan } from '@/app/api/t/[tenantSlug]/admin/agents/integration-scans/route';
import { POST as postAgentRuleScan } from '@/app/api/t/[tenantSlug]/admin/agents/agent-rule-scans/route';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const TENANT = `connect-scanner-${randomUUID().slice(0, 8)}`;
const EMAIL = `owner@${TENANT}.test`;

let ownerUserId = '';
let agentId = '';
let scanner: FakeScanner;

const ownerCtx = () => makeRequestContext('OWNER', { tenantId: TENANT, tenantSlug: TENANT, userId: ownerUserId });

const ALL: ScannerConnectSelection = { agentReport: true, integrations: true, agentRules: true, readRegister: true };

async function mint(sel: ScannerConnectSelection): Promise<string> {
    const created = await createApiKey(ownerCtx(), {
        name: 'Estate scanner',
        scopes: scannerKeyScopes(sel),
        expiresAt: null,
        agentId,
        maxAutonomyLevel: scannerKeyCeiling(1),
        requiresTokenExchange: scannerKeyRequiresExchange(sel),
    });
    return created.plaintext;
}

type Route = (req: NextRequest, ctx: never) => Promise<Response>;

function post(route: Route, path: string, key: string, body: unknown): Promise<Response> {
    const req = new NextRequest(`http://localhost/api/t/${TENANT}/admin/agents/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: scanner.serialise(body),
    });
    return route(req, { params: Promise.resolve({ tenantSlug: TENANT }) } as never);
}

function harnessBody(scanId: string) {
    const body = validV3ReportBody();
    body.scan.scanner.agentId = agentId;
    body.scan.id = scanId;
    return body;
}

async function clear(): Promise<void> {
    const t = { tenantId: TENANT };
    await prisma.agentRuleScanItem.deleteMany({ where: t });
    await prisma.agentRuleScan.deleteMany({ where: t });
    await prisma.thirdPartyAppScanItem.deleteMany({ where: t });
    await prisma.thirdPartyAppScan.deleteMany({ where: t });
    await prisma.discoveredThirdPartyApp.deleteMany({ where: t });
    await prisma.agentHarnessAcceptance.deleteMany({ where: t });
    await prisma.agentHarnessScanItem.deleteMany({ where: t });
    await prisma.agentHarnessScan.deleteMany({ where: t });
    await prisma.discoveredAgent.deleteMany({ where: t });
    await prisma.agentHarnessScannerKey.deleteMany({ where: t });
    await prisma.tenantApiKey.deleteMany({ where: t });
    await prisma.finding.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, [TENANT]);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT);
    });
    await prisma.user.deleteMany({ where: { emailHash: hashForLookup(EMAIL) } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
}

beforeAll(async () => {
    await clear();
    await prisma.tenant.create({ data: { id: TENANT, name: TENANT, slug: TENANT } });
    const user = await prisma.user.create({ data: { email: EMAIL, emailHash: hashForLookup(EMAIL) } });
    ownerUserId = user.id;
    await prisma.tenantMembership.create({
        data: { tenantId: TENANT, userId: user.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
    const aiSystem = await prisma.aiSystem.create({ data: { tenantId: TENANT, name: 'Scanner host', ownerUserId: user.id } });
    // ACTIVE: only an active agent can hold a key, and its keys work only while it is.
    const agent = await prisma.registeredAgent.create({
        data: {
            tenantId: TENANT,
            aiSystemId: aiSystem.id,
            name: 'Estate scanner',
            autonomyLevel: 1,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: user.id,
            status: 'ACTIVE',
            riskTier: 'LOW',
            riskTierScoredAt: new Date(),
        },
    });
    agentId = agent.id;
    scanner = createFakeScanner();
    await addHarnessScannerKey(ownerCtx(), { agentId, publicKey: scanner.publicKeyHex });
});

afterAll(async () => {
    await clear();
    await prisma.$disconnect();
});

describe('one key from "Connect a scanner"', () => {
    it('is stored with every ticked scope, bound to the scanner, and made to exchange for the register read', async () => {
        await mint(ALL);
        const row = await prisma.tenantApiKey.findFirstOrThrow({
            where: { tenantId: TENANT },
            select: { scopes: true, agentId: true, maxAutonomyLevel: true, requiresTokenExchange: true },
        });
        expect(row).toEqual({
            scopes: ['admin:agent_rules_ingest', 'admin:harness_ingest', 'admin:integrations_ingest', 'mcp:read'],
            agentId,
            maxAutonomyLevel: 1,
            requiresTokenExchange: true,
        });
    });

    it('posts the agent report, the integrations report and the agent-surface report', async () => {
        const key = await mint(ALL);

        const harness = await post(postHarnessScan as unknown as Route, 'harness-scans', key, harnessBody('one-key-harness'));
        expect(harness.status).toBe(201);
        const integrations = await post(
            postIntegrationsScan as unknown as Route,
            'integration-scans',
            key,
            integrationsBody(agentId, 'one-key-integrations'),
        );
        expect(integrations.status).toBe(201);
        const rules = await post(postAgentRuleScan as unknown as Route, 'agent-rule-scans', key, agentRulesBody(agentId, 'one-key-rules'));
        expect(rules.status).toBe(201);

        expect(await prisma.agentHarnessScan.count({ where: { tenantId: TENANT } })).toBe(1);
        expect(await prisma.thirdPartyAppScan.count({ where: { tenantId: TENANT } })).toBe(1);
        expect(await prisma.agentRuleScan.count({ where: { tenantId: TENANT } })).toBe(1);
    });

    it('a key made for two reports is refused at the third', async () => {
        const key = await mint({ agentReport: true, integrations: true, agentRules: false, readRegister: false });
        const before = await prisma.agentRuleScan.count({ where: { tenantId: TENANT } });
        const rules = await post(postAgentRuleScan as unknown as Route, 'agent-rule-scans', key, agentRulesBody(agentId, 'two-key-rules'));
        expect(rules.status).toBe(403);
        expect(await prisma.agentRuleScan.count({ where: { tenantId: TENANT } })).toBe(before);
    });
});
