/**
 * The agent-surface rules ingest against a real database.
 *
 *   1. A REFUSED REPORT WRITES NOTHING: an untrusted signer, another contract's
 *      report given here, a scanner naming another agent.
 *   2. A VERIFIED REPORT IS STORED AS PLANNED, and a REPLAY is a conflict —
 *      the usecase's read and, behind it, the `(tenantId, scanRef)` unique.
 *   3. WHAT A SCAN CLOSES: only the same scanner's complete read of the
 *      finding's server, with the rule silent, closes it; a server read in part
 *      does not.
 *   4. TWO TENANTS. One tenant's scanner key is not trusted by the other, and
 *      the usecases of one tenant read nothing of the other's.
 *   5. RLS. Both tables under `app_user`, with each tenant bound, with none,
 *      and against a write into another tenant.
 */
import { MembershipStatus, PrismaClient, Role } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { createFakeScanner, validV3ReportBody, type FakeScanner } from '../helpers/agent-harness-fake-scanner';
import { agentRulesBody, complete, CRM, partial, REPO, ruleFinding, skillFinding, TICKETS } from '../helpers/agent-rule-fake-report';
import { createRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { addHarnessScannerKey } from '@/app-layer/usecases/agent-harness-scanner-keys';
import {
    AGENT_RULE_FINDING_SOURCE_KIND,
    getAgentRuleInventory,
    ingestAgentRuleReport,
    listAgentRuleScans,
} from '@/app-layer/usecases/agent-rule-scans';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const T1 = 'agent-rules-ingest-one';
const T2 = 'agent-rules-ingest-two';
const ALL_TENANTS = [T1, T2];

interface Seeded {
    ownerUserId: string;
    scannerAgentId: string;
    scanner: FakeScanner;
    keyId: string;
}
const seeded: Record<string, Seeded> = {};

const ctxFor = (tenantId: string): RequestContext =>
    makeRequestContext('OWNER', { tenantId, tenantSlug: tenantId, userId: seeded[tenantId].ownerUserId });

const emailOf = (tenantId: string) => `owner@${tenantId}.test`;

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: ALL_TENANTS } };
    await prisma.agentRuleScanItem.deleteMany({ where: t });
    await prisma.agentRuleScan.deleteMany({ where: t });
    await prisma.agentHarnessScannerKey.deleteMany({ where: t });
    await prisma.finding.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, ALL_TENANTS);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, ALL_TENANTS);
    });
    await prisma.user.deleteMany({ where: { emailHash: { in: ALL_TENANTS.map(emailOf).map(hashForLookup) } } });
    await prisma.tenant.deleteMany({ where: { id: { in: ALL_TENANTS } } });
}

async function seedTenant(tenantId: string): Promise<void> {
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
    const email = emailOf(tenantId);
    const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await prisma.tenantMembership.create({
        data: { tenantId, userId: user.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
    seeded[tenantId] = { ownerUserId: user.id } as Seeded;
    const aiSystem = await prisma.aiSystem.create({ data: { tenantId, name: `Host of scanner ${tenantId}`, ownerUserId: user.id } });
    const scannerAgent = await createRegisteredAgent(ctxFor(tenantId), {
        aiSystemId: aiSystem.id,
        name: `Agent-rules scanner ${tenantId}`,
        autonomyLevel: 2,
        dataAccessScope: 'READ_TENANT_DATA',
        reversibility: 'COMPENSABLE',
        provenance: 'FIRST_PARTY',
        ownerUserId: user.id,
    });
    const scanner = createFakeScanner();
    const key = await addHarnessScannerKey(ctxFor(tenantId), { agentId: scannerAgent.id, publicKey: scanner.publicKeyHex });
    Object.assign(seeded[tenantId], { scannerAgentId: scannerAgent.id, scanner, keyId: key.id });
}

const ingest = (tenantId: string, body: unknown, scanner = seeded[tenantId].scanner) =>
    ingestAgentRuleReport(ctxFor(tenantId), scanner.serialise(body));

async function counts(tenantId: string) {
    const t = { tenantId };
    return {
        scans: await prisma.agentRuleScan.count({ where: t }),
        items: await prisma.agentRuleScanItem.count({ where: t }),
        findings: await prisma.finding.count({ where: { ...t, sourceKind: AGENT_RULE_FINDING_SOURCE_KIND } }),
    };
}

async function asTenant<T>(tenantId: string | null, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        if (tenantId) await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenantId}', true)`);
        return fn(tx as unknown as PrismaClient);
    });
}

beforeAll(async () => {
    await clearOwnRows();
    for (const t of ALL_TENANTS) await seedTenant(t);
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

const LOOKUP = ruleFinding(CRM, 'lookup_account');

describe('1. a refused report writes nothing', () => {
    it('an untrusted signer, another contract, a scanner naming another agent', async () => {
        const before = await counts(T1);
        await expect(
            ingestAgentRuleReport(ctxFor(T1), createFakeScanner().serialise(agentRulesBody(seeded[T1].scannerAgentId, 'r1'))),
        ).rejects.toThrow('agent_rules_report_refused: UNTRUSTED_SIGNER');
        const harness = validV3ReportBody();
        harness.scan.scanner.agentId = seeded[T1].scannerAgentId;
        await expect(ingest(T1, harness)).rejects.toThrow('agent_rules_report_refused: SCHEMA');
        await expect(ingest(T1, agentRulesBody('agent-that-is-not-the-scanner', 'r2'))).rejects.toThrow(
            'agent_rules_report_refused: SCANNER_MISMATCH',
        );
        expect(await counts(T1)).toEqual(before);
    });
});

describe('2. a verified report is stored as planned, and a replay is a conflict', () => {
    it('stores the scan, its item and its finding, and audits the ingest', async () => {
        const result = await ingest(T1, agentRulesBody(seeded[T1].scannerAgentId, 'scan-1', [complete(CRM, 3), complete(TICKETS, 1)], [LOOKUP]));
        expect(result).toMatchObject({ scanRef: 'scan-1', complete: true, findingCount: 1, findingsOpened: 1 });
        expect(await counts(T1)).toEqual({ scans: 1, items: 1, findings: 1 });
        const scan = await prisma.agentRuleScan.findFirstOrThrow({ where: { tenantId: T1, scanRef: 'scan-1' } });
        expect(scan).toMatchObject({ scannerAgentId: seeded[T1].scannerAgentId, scannerKeyId: seeded[T1].keyId, outcome: 'FINDINGS', subjects: 4 });
        expect(scan.reportDigest).toMatch(/^[0-9a-f]{64}$/);
        const finding = await prisma.finding.findFirstOrThrow({ where: { tenantId: T1, sourceKind: AGENT_RULE_FINDING_SOURCE_KIND } });
        expect(finding).toMatchObject({ type: 'OBSERVATION', severity: 'HIGH', status: 'OPEN' });
        const audit = await prisma.auditLog.findFirst({ where: { tenantId: T1, action: 'AGENT_RULE_SCAN_INGESTED', entityId: scan.id } });
        expect(audit).not.toBeNull();
    });

    it('refuses a replay of the same scan id, and the database holds the rule on its own', async () => {
        const before = await counts(T1);
        await expect(ingest(T1, agentRulesBody(seeded[T1].scannerAgentId, 'scan-1'))).rejects.toThrow('agent_rules_report_refused: REPLAY');
        expect(await counts(T1)).toEqual(before);
        const scan = await prisma.agentRuleScan.findFirstOrThrow({ where: { tenantId: T1, scanRef: 'scan-1' } });
        const { id: _id, createdAt: _c, ...copy } = scan;
        await expect(
            prisma.agentRuleScan.create({ data: { ...copy, populationJson: copy.populationJson as object, originsJson: copy.originsJson as object } }),
        ).rejects.toThrow();
    });
});

describe('3. what a scan closes', () => {
    it('a server read in part closes nothing; the same scanner\'s complete read of it, the rule silent, closes the finding', async () => {
        const partly = await ingest(T1, agentRulesBody(seeded[T1].scannerAgentId, 'scan-2', [partial(CRM, 1), complete(TICKETS, 1)], []));
        expect(partly.findingsResolved).toBe(0);
        const fully = await ingest(T1, agentRulesBody(seeded[T1].scannerAgentId, 'scan-3', [complete(CRM, 3), complete(TICKETS, 1)], []));
        expect(fully.findingsResolved).toBe(1);
        const finding = await prisma.finding.findFirstOrThrow({ where: { tenantId: T1, sourceKind: AGENT_RULE_FINDING_SOURCE_KIND } });
        expect(finding.status).toBe('CLOSED');
    });

    it('a skill finding is stored against its code root, and only that root read in full closes it', async () => {
        const scanner = seeded[T1].scannerAgentId;
        const skill = skillFinding(REPO, 'skills/report/SKILL.md');
        await ingest(T1, agentRulesBody(scanner, 'scan-4', [complete(CRM, 3), complete(REPO, 2)], [skill]));
        const item = await prisma.agentRuleScanItem.findFirstOrThrow({ where: { tenantId: T1, locator: skill.locator } });
        expect(item.originRef).toBe(REPO);
        const onlyServer = await ingest(T1, agentRulesBody(scanner, 'scan-5', [complete(CRM, 3)], []));
        expect(onlyServer.findingsResolved).toBe(0);
        const root = await ingest(T1, agentRulesBody(scanner, 'scan-6', [complete(CRM, 3), complete(REPO, 2)], []));
        expect(root.findingsResolved).toBe(1);
        const finding = await prisma.finding.findFirstOrThrow({ where: { tenantId: T1, sourceRef: { startsWith: 'agent-rule:cisco-skill:' } } });
        expect(finding).toMatchObject({ status: 'CLOSED', title: 'Possible prompt injection in an agent skill' });
    });
});

describe('4. two tenants', () => {
    it("one tenant's scanner key is not trusted by the other", async () => {
        const before = await counts(T2);
        await expect(ingest(T2, agentRulesBody(seeded[T1].scannerAgentId, 'cross'), seeded[T1].scanner)).rejects.toThrow('UNTRUSTED_SIGNER');
        expect(await counts(T2)).toEqual(before);
    });

    it("each tenant's usecases read its own scans and findings only", async () => {
        await ingest(T2, agentRulesBody(seeded[T2].scannerAgentId, 'scan-1', [complete(CRM, 2)], [LOOKUP]));
        const one = await getAgentRuleInventory(ctxFor(T1));
        const two = await getAgentRuleInventory(ctxFor(T2));
        expect(one.sections.map((s) => s.scannerAgentId)).toEqual([seeded[T1].scannerAgentId]);
        expect(two.sections.map((s) => s.scannerAgentId)).toEqual([seeded[T2].scannerAgentId]);
        // T1's finding is closed; T2's is its own, open.
        expect(one.sections[0].findings).toEqual([]);
        expect(two.sections[0].findings.map((f) => f.code)).toEqual(['MCP_PROMPT_INJECTION']);
        expect((await listAgentRuleScans(ctxFor(T2))).map((s) => s.scanRef)).toEqual(['scan-1']);
    });
});

describe('5. RLS on both tables', () => {
    const TABLES = ['agentRuleScan', 'agentRuleScanItem'] as const;

    it.each(TABLES)('%s: a bound tenant reads its own rows only', async (table) => {
        const own = await asTenant(T1, (tx) => (tx[table] as unknown as { findMany: () => Promise<{ tenantId: string }[]> }).findMany());
        expect(own.length).toBeGreaterThan(0);
        expect(new Set(own.map((r) => r.tenantId))).toEqual(new Set([T1]));
    });

    it.each(TABLES)('%s: with no tenant bound, app_user reads nothing', async (table) => {
        const none = await asTenant(null, (tx) => (tx[table] as unknown as { count: () => Promise<number> }).count());
        expect(none).toBe(0);
    });

    it('app_user cannot write a row into another tenant', async () => {
        const scan = await prisma.agentRuleScan.findFirstOrThrow({ where: { tenantId: T1 } });
        await expect(
            asTenant(T2, (tx) =>
                tx.agentRuleScanItem.create({
                    data: {
                        tenantId: T1,
                        scanId: scan.id,
                        sourceRef: 'agent-rule:x@y@z',
                        originRef: CRM,
                        code: 'MCP_PROMPT_INJECTION',
                        ruleId: 'cisco-mcp:instruction-override',
                        severity: 'HIGH',
                        subjectRef: `${CRM}:tool:x`,
                        locator: `mcp-tool:${CRM}:tool:x#description`,
                    },
                }),
            ),
        ).rejects.toThrow();
    });
});
