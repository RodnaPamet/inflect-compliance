/**
 * `inflect-agent-harness/4` through the real ingest, against a real database
 * (Agent Pay Phase 2, `docs/ai-architecture/mastercard-agent-pay.md`).
 *
 *   1. A REGISTERED AGENT WHOSE CODE PAYS, WITH NO ENVELOPE, raises
 *      SPENDING_AGENT_UNDECLARED end to end, keyed by the register row.
 *   2. AN ENVELOPE AWAITING REVIEW HOLDS IT: a later scan neither closes nor
 *      re-raises it while the declaration waits for its second person.
 *   3. A COMPLETE CODE READ THAT NO LONGER SHOWS THE PAYMENT CLIENT CLOSES
 *      NOTHING: a static read cannot show the agent has no other way to pay.
 *      A person closes it; a later scan that sees nothing leaves it closed,
 *      and one that sees the client again reopens it.
 *   4. TWO TENANTS: the finding is invisible to the other tenant.
 */
import { MembershipStatus, PrismaClient, Role } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { createFakeScanner, PAYING_AGENT_ID, validV4ReportBody, type FakeScanner } from '../helpers/agent-harness-fake-scanner';
import { createRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { ingestHarnessReport } from '@/app-layer/usecases/agent-harness-scans';
import { addHarnessScannerKey } from '@/app-layer/usecases/agent-harness-scanner-keys';
import {
    declareAgentSpendingAuthority,
    withdrawAgentSpendingAuthority,
} from '@/app-layer/usecases/agent-spending-authority';
import type { HarnessReportBodyV4 } from '@/lib/agentic/harness-contract';
import { HARNESS_FINDING_SOURCE_KIND, spendingUndeclaredRefOf } from '@/lib/agentic/harness-findings';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const T1 = 'harness-v4-pay-one';
const T2 = 'harness-v4-pay-two';
const ALL_TENANTS = [T1, T2];

interface Seeded {
    ownerUserId: string;
    declarerUserId: string;
    scannerAgentId: string;
    payingAgentId: string;
    scanner: FakeScanner;
}
const seeded: Record<string, Seeded> = {};

const emailOf = (tenantId: string, who: string) => `${who}@${tenantId}.test`;
const ctxAs = (tenantId: string, userId: string): RequestContext =>
    makeRequestContext('OWNER', { tenantId, tenantSlug: tenantId, userId });

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: ALL_TENANTS } };
    await prisma.agentSpendingAuthority.deleteMany({ where: t });
    await prisma.agentHarnessScanItem.deleteMany({ where: t });
    await prisma.agentHarnessScan.deleteMany({ where: t });
    await prisma.discoveredAgent.deleteMany({ where: t });
    await prisma.agentHarnessScannerKey.deleteMany({ where: t });
    await prisma.finding.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, ALL_TENANTS);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, ALL_TENANTS);
    });
    const emails = ALL_TENANTS.flatMap((t) => [emailOf(t, 'owner'), emailOf(t, 'declarer')]);
    await prisma.user.deleteMany({ where: { emailHash: { in: emails.map(hashForLookup) } } });
    await prisma.tenant.deleteMany({ where: { id: { in: ALL_TENANTS } } });
}

async function seedTenant(tenantId: string): Promise<void> {
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
    const member = async (who: string) => {
        const email = emailOf(tenantId, who);
        const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        await prisma.tenantMembership.create({ data: { tenantId, userId: user.id, role: Role.OWNER, status: MembershipStatus.ACTIVE } });
        return user.id;
    };
    const ownerUserId = await member('owner');
    const declarerUserId = await member('declarer');
    const ctx = ctxAs(tenantId, ownerUserId);
    const agent = async (name: string) =>
        createRegisteredAgent(ctx, {
            aiSystemId: (await prisma.aiSystem.create({ data: { tenantId, name: `Host of ${name}`, ownerUserId } })).id,
            name,
            autonomyLevel: 2,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'COMPENSABLE',
            provenance: 'FIRST_PARTY',
            ownerUserId,
        });
    const scannerAgent = await agent(`Harness scanner ${tenantId}`);
    const payingAgent = await agent(`Shopping agent ${tenantId}`);
    const scanner = createFakeScanner();
    await addHarnessScannerKey(ctx, { agentId: scannerAgent.id, publicKey: scanner.publicKeyHex });
    seeded[tenantId] = { ownerUserId, declarerUserId, scannerAgentId: scannerAgent.id, payingAgentId: payingAgent.id, scanner };
}

let scanSeq = 0;

/** The `/4` fixture pointed at this tenant: its paying agent linked to the register row. */
function pointed(tenantId: string, edit: (paying: HarnessReportBodyV4['agents'][number]) => void = () => {}): HarnessReportBodyV4 {
    const body = validV4ReportBody();
    body.scan.id = `scan_v4_pay_${++scanSeq}`;
    body.scan.asOf = new Date().toISOString();
    body.scan.scanner.agentId = seeded[tenantId].scannerAgentId;
    const paying = body.agents.find((a) => a.discoveredId === PAYING_AGENT_ID)!;
    paying.registeredAgentId = seeded[tenantId].payingAgentId;
    edit(paying);
    return body;
}

const ingest = (tenantId: string, body: unknown) =>
    ingestHarnessReport(ctxAs(tenantId, seeded[tenantId].ownerUserId), seeded[tenantId].scanner.serialise(body));

const finding = (tenantId: string) =>
    prisma.finding.findFirst({
        where: { tenantId, sourceKind: HARNESS_FINDING_SOURCE_KIND, sourceRef: spendingUndeclaredRefOf(seeded[tenantId].payingAgentId) },
        select: { status: true, severity: true },
    });

beforeAll(async () => {
    await clearOwnRows();
    for (const t of ALL_TENANTS) await seedTenant(t);
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('SPENDING_AGENT_UNDECLARED through the real ingest', () => {
    it('1. opens for a registered paying agent with no envelope', async () => {
        await ingest(T1, pointed(T1));
        expect(await finding(T1)).toMatchObject({ severity: 'HIGH' });
        expect((await finding(T1))?.status).not.toBe('CLOSED');
    });

    it('2. an envelope awaiting review holds it: a later paying scan leaves it as it is', async () => {
        const ctx = ctxAs(T1, seeded[T1].declarerUserId);
        await declareAgentSpendingAuthority(ctx, seeded[T1].payingAgentId, {
            rail: 'AP4M',
            perTransactionLimitMinor: 500,
            periodBudgetMinor: 5_000,
            budgetPeriod: 'MONTH',
            currency: 'USD',
            merchantDomains: ['api.example.com'],
            merchantCategoryCodes: [],
            expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
            consentedByUserId: seeded[T1].ownerUserId,
            tokenRequestor: 'Example Agent Platform',
            tokenReference: 'ref-ap4m-budget-1',
        });
        const before = await finding(T1);
        await ingest(T1, pointed(T1));
        expect(await finding(T1)).toEqual(before);
    });

    it('3. a complete code read that no longer shows the client closes nothing; a person does', async () => {
        await withdrawAgentSpendingAuthority(ctxAs(T1, seeded[T1].declarerUserId), seeded[T1].payingAgentId, 'AP4M');
        const noLongerPays = (p: HarnessReportBodyV4['agents'][number]) => {
            (p as { paymentCapabilities?: unknown[] }).paymentCapabilities = [];
        };
        await ingest(T1, pointed(T1, noLongerPays));
        expect((await finding(T1))?.status).not.toBe('CLOSED');

        // The team removed the client and closes the finding itself.
        await prisma.finding.updateMany({
            where: { tenantId: T1, sourceKind: HARNESS_FINDING_SOURCE_KIND, sourceRef: spendingUndeclaredRefOf(seeded[T1].payingAgentId) },
            data: { status: 'CLOSED' },
        });
        await ingest(T1, pointed(T1, noLongerPays));
        expect((await finding(T1))?.status).toBe('CLOSED');

        // A scan that sees the client again reopens it.
        await ingest(T1, pointed(T1));
        expect((await finding(T1))?.status).toBe('OPEN');
    });

    it('4. the other tenant sees none of it', async () => {
        expect(await finding(T2)).toBeNull();
        const leaked = await prisma.finding.count({
            where: { tenantId: T2, sourceRef: spendingUndeclaredRefOf(seeded[T1].payingAgentId) },
        });
        expect(leaked).toBe(0);
    });
});
