/**
 * Emitted agentic evidence — tenant isolation, and what it would mean to lose it.
 *
 * An emitted artefact is a description of one customer's agent estate: how many
 * mediated actions their agents took in a month, which tools they reached for,
 * how many of their model invocations a human ever looked at. A cross-tenant
 * READ of that is a competitor's operating profile. A cross-tenant WRITE is
 * worse and quieter — evidence attached to somebody else's control, which their
 * assessor would read as their own.
 *
 * Three layers, and the third is the one a mocked client cannot reach:
 *
 *   1. THE USECASE under two tenant contexts. Each tenant's emission counts only
 *      its own records and lands only on its own controls, with a SHARED
 *      framework underneath both — the realistic case, and the one where a
 *      missing `tenantId` filter on the requirement→control join would leak.
 *   2. RAW READS under `app_user`, with the other tenant bound and with no
 *      tenant bound at all. RLS, not application code.
 *   3. A CROSS-TENANT INSERT, refused by `tenant_isolation_insert`. The split
 *      USING / WITH CHECK form exists so a write cannot go where a read cannot
 *      follow, and only a real Postgres will say so.
 */
import { PrismaClient, MembershipStatus, Role } from '@prisma/client';
import { type KeyObject, generateKeyPairSync, sign as cryptoSign } from 'crypto';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';

const mockKey: { value?: string } = {};
jest.mock('@/env', () => {
    const actual = jest.requireActual('@/env');
    return {
        ...actual,
        env: new Proxy(actual.env as Record<string, unknown>, {
            get: (target, prop) =>
                prop === 'PIPELOCK_PUBLIC_KEY' ? mockKey.value : Reflect.get(target, prop),
        }),
    };
});

import { receiptSignedMessage } from '@/lib/mcp/receipt-verification';
import { ingestReceipt } from '@/app-layer/usecases/agent-action-receipt';
import { emitAgenticEvidence } from '@/app-layer/usecases/agentic-evidence-emission';
import { ASI_LIBRARY_URN } from '@/lib/agentic/evidence-artefact';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(90_000);

const T1 = 'agentic-evidence-iso-one';
const T2 = 'agentic-evidence-iso-two';
const AS_OF = new Date('2026-08-14T09:00:00.000Z');
const OCCURRED = '2026-08-05T12:00:00.000Z';
const FRAMEWORK_KEY = 'TEST-ISO-ASI-REPRESENTATION';

let privateKey: KeyObject;
const owners: Record<string, string> = {};
const controlIds: Record<string, string> = {};

const ctxFor = (tenantId: string) =>
    makeRequestContext('OWNER', {
        tenantId,
        tenantSlug: tenantId,
        userId: owners[tenantId],
    });

function signedReceipt(tool: string) {
    const record = {
        tool,
        verdict: 'allow',
        policy: 'default',
        agent_id: 'agent-under-test',
        timestamp: OCCURRED,
    };
    const sig = cryptoSign(null, receiptSignedMessage(record), privateKey);
    return {
        action_record: record,
        signature: `ed25519:${sig.toString('hex')}`,
        signer_key: mockKey.value as string,
    };
}

async function asTenant<T>(tenantId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenantId}', true)`);
        return fn(tx as unknown as PrismaClient);
    });
}

async function asAppUserWithNoTenant<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        return fn(tx as unknown as PrismaClient);
    });
}

/**
 * `resetDatabase` truncates a fixed table list, and CI always starts clean —
 * which is exactly what would hide a suite that passes once and fails every
 * re-run. This clears its own rows.
 */
async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: [T1, T2] } };
    await prisma.agenticEvidenceArtefact.deleteMany({ where: t });
    await prisma.agentActionReceipt.deleteMany({ where: t });
    await prisma.evidenceControlLink.deleteMany({ where: t });
    await prisma.evidence.deleteMany({ where: t });
    await prisma.controlRequirementLink.deleteMany({ where: t });
    await prisma.control.deleteMany({ where: t });
    await prisma.frameworkRequirement.deleteMany({
        where: { framework: { key: FRAMEWORK_KEY } },
    });
    await prisma.framework.deleteMany({ where: { key: FRAMEWORK_KEY } });
    // The immutable-audit trigger and the last-OWNER guard both fire on an
    // ordinary DELETE and would take the teardown down with them.
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = ANY($1)`, [T1, T2]);
        await tx.$executeRawUnsafe(
            `DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1)`,
            [T1, T2],
        );
    });
    for (const tenantId of [T1, T2]) {
        await prisma.user.deleteMany({
            where: { emailHash: hashForLookup(`owner@${tenantId}.test`) },
        });
    }
    await prisma.tenant.deleteMany({ where: { id: { in: [T1, T2] } } });
}

beforeAll(async () => {
    const pair = generateKeyPairSync('ed25519');
    privateKey = pair.privateKey;
    mockKey.value = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');

    await resetDatabase(prisma);
    await clearOwnRows();

    // ONE framework, shared. `Framework` is a global catalogue table with no
    // tenantId, so both tenants' controls hang off the same requirement row —
    // which is what makes a missing tenantId filter on the requirement→control
    // join leak rather than merely return nothing.
    const framework = await prisma.framework.create({
        data: {
            key: FRAMEWORK_KEY,
            name: 'OWASP Agentic AI Top 10',
            version: '1.0',
            kind: 'INDUSTRY_STANDARD',
            sourceUrn: ASI_LIBRARY_URN,
        },
    });
    const requirement = await prisma.frameworkRequirement.create({
        data: { frameworkId: framework.id, code: 'ASI02', title: 'Tool Misuse and Exploitation' },
    });

    for (const tenantId of [T1, T2]) {
        await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
        const email = `owner@${tenantId}.test`;
        const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        owners[tenantId] = user.id;
        await prisma.tenantMembership.create({
            data: { tenantId, userId: user.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
        });
        const control = await prisma.control.create({
            data: { tenantId, code: 'CTL-ASI02', name: 'Tool mediation', status: 'IMPLEMENTED' },
        });
        controlIds[tenantId] = control.id;
        await prisma.controlRequirementLink.create({
            data: { tenantId, controlId: control.id, requirementId: requirement.id },
        });
    }

    // Two receipts for T1, one for T2 — different counts, so a leak shows up as
    // a NUMBER rather than as a row that happens to look plausible.
    await ingestReceipt(ctxFor(T1), signedReceipt('list_risks'));
    await ingestReceipt(ctxFor(T1), signedReceipt('list_controls'));
    await ingestReceipt(ctxFor(T2), signedReceipt('list_evidence'));

    await emitAgenticEvidence(ctxFor(T1), { asOf: AS_OF });
    await emitAgenticEvidence(ctxFor(T2), { asOf: AS_OF });
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('emission counts only the emitting tenant', () => {
    it('each tenant gets its own population, on its own control', async () => {
        const rows = await prisma.agenticEvidenceArtefact.findMany({
            where: { tenantId: { in: [T1, T2] } },
            select: { tenantId: true, controlId: true, recordCount: true },
        });
        expect(rows).toHaveLength(2);

        const one = rows.find((r) => r.tenantId === T1)!;
        const two = rows.find((r) => r.tenantId === T2)!;
        expect(one.recordCount).toBe(2);
        expect(two.recordCount).toBe(1);
        expect(one.controlId).toBe(controlIds[T1]);
        expect(two.controlId).toBe(controlIds[T2]);
        // Neither tenant's artefact landed on the other's control — the failure
        // a shared framework row makes possible.
        expect(one.controlId).not.toBe(controlIds[T2]);
    });

    it('the evidence body of one tenant names none of the other tenant\'s tools', async () => {
        const artefact = await prisma.agenticEvidenceArtefact.findFirstOrThrow({
            where: { tenantId: T2 },
            select: { evidenceId: true },
        });
        const evidence = await prisma.evidence.findUniqueOrThrow({
            where: { id: artefact.evidenceId },
            select: { content: true },
        });
        expect(evidence.content).toContain('list_evidence: 1');
        expect(evidence.content).not.toContain('list_risks');
        expect(evidence.content).not.toContain('list_controls');
        expect(evidence.content).toContain('Mediated agent actions recorded: 1');
    });
});

describe('row-level security, not application code', () => {
    it('a tenant-bound app_user sees only its own artefacts', async () => {
        const mine = await asTenant(T1, (tx) =>
            tx.agenticEvidenceArtefact.findMany({ select: { tenantId: true } }),
        );
        expect(mine.length).toBeGreaterThan(0);
        expect(mine.every((r) => r.tenantId === T1)).toBe(true);

        const theirs = await asTenant(T2, (tx) =>
            tx.agenticEvidenceArtefact.findMany({ select: { tenantId: true } }),
        );
        expect(theirs.every((r) => r.tenantId === T2)).toBe(true);
    });

    it('an app_user with NO tenant bound sees nothing', async () => {
        const rows = await asAppUserWithNoTenant((tx) =>
            tx.agenticEvidenceArtefact.findMany({ select: { id: true } }),
        );
        expect(rows).toEqual([]);
    });

    it('refuses an insert claiming another tenant', async () => {
        const victim = await prisma.agenticEvidenceArtefact.findFirstOrThrow({
            where: { tenantId: T2 },
            select: { evidenceId: true },
        });
        await expect(
            asTenant(T1, (tx) =>
                tx.agenticEvidenceArtefact.create({
                    data: {
                        tenantId: T2,
                        controlId: controlIds[T2],
                        kind: 'AGENT_ACTION_RECEIPTS',
                        periodStart: new Date('2026-07-01T00:00:00.000Z'),
                        periodEnd: new Date('2026-08-01T00:00:00.000Z'),
                        evidenceId: victim.evidenceId,
                        sourceDigest: 'f'.repeat(64),
                    },
                }),
            ),
        ).rejects.toThrow();

        // And it really did not land — a rejection that wrote first would still
        // satisfy the assertion above.
        expect(
            await prisma.agenticEvidenceArtefact.count({
                where: { tenantId: T2, periodStart: new Date('2026-07-01T00:00:00.000Z') },
            }),
        ).toBe(0);
    });
});
