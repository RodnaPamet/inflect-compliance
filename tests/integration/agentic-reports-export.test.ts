/**
 * #2467 — filing the pack, against a real database.
 *
 * `tests/unit/agentic-pack-document.test.ts` proves what the DOCUMENT says. This
 * suite proves what the WRITE does, which is the part a pure test cannot reach:
 * that a row lands, that it lands with a retention horizon rather than the
 * library's default, that the audit trail records whether the pack meant
 * anything when it was filed, and that two exports are two documents.
 *
 * ## Its own tenants, not the derivation suite's
 *
 * `agentic-reports.test.ts` already seeds four tenants for the arithmetic. This
 * suite deliberately does not reuse them: it WRITES Evidence and AuditLog rows,
 * and a suite that mutates another suite's fixture makes both of them
 * order-dependent in a way that shows up as an unrelated flake months later.
 * The cost is a second fixture; the alternative is a shared one whose failures
 * belong to whichever suite ran second.
 *
 * ## The enforcement flag is the reason for two tenants here
 *
 * `TX_ON` enforces registration and `TX_OFF` does not. The filed document must
 * differ between them at the top, and the audit row must record WHICH — because
 * the flag can be flipped afterwards, and an audit entry saying only "a pack was
 * exported" cannot answer whether the pack was meaningful when it was.
 */
import { PrismaClient, MembershipStatus, RetentionPolicy, Role } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { createRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import {
    exportAgentGovernancePack,
    PACK_EVIDENCE_CATEGORY,
    PACK_EVIDENCE_FOLDER,
    PACK_RETENTION_DAYS,
} from '@/app-layer/usecases/agent-governance-pack-export';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(60_000);

const TX_ON = 'agrepexp-enforcing';
const TX_OFF = 'agrepexp-permissive';
const TENANTS = [TX_ON, TX_OFF] as const;

const users: Record<string, string> = {};

const ctxFor = (tenantId: string, over: Record<string, unknown> = {}) =>
    makeRequestContext('OWNER', {
        tenantId,
        tenantSlug: tenantId,
        userId: users[tenantId],
        ...over,
    });

/** See the derivation suite's teardown for why the last two go through replica. */
async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: [...TENANTS] } };
    await prisma.evidenceControlLink.deleteMany({ where: t });
    await prisma.evidence.deleteMany({ where: t });
    await prisma.registeredAgentTool.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystemRequirementLink.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await prisma.tenantSecuritySettings.deleteMany({ where: t });
    await prisma.tenantApiKey.deleteMany({ where: t });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = ANY($1::text[])`, [
            ...TENANTS,
        ]);
        await tx.$executeRawUnsafe(
            `DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`,
            [...TENANTS],
        );
    });
    await prisma.user.deleteMany({
        where: { emailHash: { in: TENANTS.map((x) => hashForLookup(`owner@${x}.test`)) } },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: [...TENANTS] } } });
}

beforeAll(async () => {
    await clearOwnRows();
    for (const tenantId of TENANTS) {
        await prisma.tenant.create({
            data: { id: tenantId, name: `Workspace ${tenantId}`, slug: tenantId },
        });
        const email = `owner@${tenantId}.test`;
        const user = await prisma.user.create({
            data: { email, emailHash: hashForLookup(email) },
        });
        users[tenantId] = user.id;
        await prisma.tenantMembership.create({
            data: {
                tenantId,
                userId: user.id,
                role: Role.OWNER,
                status: MembershipStatus.ACTIVE,
            },
        });
        await prisma.tenantSecuritySettings.create({
            data: { tenantId, requireRegisteredAgent: tenantId === TX_ON },
        });
        // One AiSystem per agent — the register's 1:1 link is required.
        const aiSystem = await prisma.aiSystem.create({
            data: { tenantId, name: `System of ${tenantId}`, ownerUserId: user.id },
        });
        await createRegisteredAgent(ctxFor(tenantId), {
            aiSystemId: aiSystem.id,
            name: `Agent of ${tenantId}`,
            description: 'fixture',
            autonomyLevel: 2,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: user.id,
        });
    }
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('the filed record', () => {
    it('lands as retained, approved, foldered TEXT evidence', async () => {
        const result = await exportAgentGovernancePack(ctxFor(TX_ON));

        const row = await prisma.evidence.findFirst({
            where: { id: result.evidenceId, tenantId: TX_ON },
        });
        expect(row).not.toBeNull();
        expect(row!.type).toBe('TEXT');
        expect(row!.title).toBe(result.title);
        expect(row!.folder).toBe(PACK_EVIDENCE_FOLDER);
        expect(row!.category).toBe(PACK_EVIDENCE_CATEGORY);
        // APPROVED rather than DRAFT: no person drafted it, so there is no
        // draft state for anyone to move it out of.
        expect(row!.status).toBe('APPROVED');
        expect(row!.ownerUserId).toBe(users[TX_ON]);

        // The retention horizon is SET, not inherited. A governance pack that
        // ages out on the library's operational default disappears looking like
        // a policy rather than a gap.
        expect(row!.retentionPolicy).toBe(RetentionPolicy.DAYS_AFTER_UPLOAD);
        expect(row!.retentionDays).toBe(PACK_RETENTION_DAYS);
        expect(row!.retentionUntil).not.toBeNull();
        const horizonDays =
            (row!.retentionUntil!.getTime() - result.generatedAt.getTime()) / 86_400_000;
        expect(Math.round(horizonDays)).toBe(PACK_RETENTION_DAYS);
    });

    it('attaches to NO control, because the pack discharges no single one', async () => {
        const result = await exportAgentGovernancePack(ctxFor(TX_ON));
        const links = await prisma.evidenceControlLink.count({
            where: { tenantId: TX_ON, evidenceId: result.evidenceId },
        });
        expect(links).toBe(0);
    });

    it('contains the whole pack, not a summary of it', async () => {
        const result = await exportAgentGovernancePack(ctxFor(TX_ON));
        const row = await prisma.evidence.findFirst({ where: { id: result.evidenceId } });
        const content = row!.content ?? '';
        for (const heading of [
            '1 — AGENT INVENTORY',
            '2 — ASI RISK COVERAGE',
            '3 — APPROVAL QUALITY',
            '4 — INCIDENTS',
            '5 — THIRD-PARTY ASSURANCE',
            'APPENDIX',
        ]) {
            expect(content).toContain(heading);
        }
        expect(result.documentBytes).toBeGreaterThan(500);
    });
});

describe('the caveat survives the round trip to the database', () => {
    it('warns, in the STORED text, when registration is not enforced', async () => {
        const result = await exportAgentGovernancePack(ctxFor(TX_OFF));
        expect(result.enforcing).toBe(false);
        const row = await prisma.evidence.findFirst({ where: { id: result.evidenceId } });
        expect(row!.content).toContain('SAMPLE, NOT A POPULATION');
    });

    it('and does NOT warn, in the stored text, when it is enforced', async () => {
        // The other direction, against the real flag rather than a fixture
        // boolean: a usecase reading the wrong tenant's settings would pass the
        // test above and fail this one.
        const result = await exportAgentGovernancePack(ctxFor(TX_ON));
        expect(result.enforcing).toBe(true);
        const row = await prisma.evidence.findFirst({ where: { id: result.evidenceId } });
        expect(row!.content).not.toContain('SAMPLE, NOT A POPULATION');
        expect(row!.content).toContain('REGISTRATION IS ENFORCED');
    });
});

describe('the audit trail', () => {
    it('records whether the pack meant anything at the moment it was filed', async () => {
        const result = await exportAgentGovernancePack(ctxFor(TX_OFF));
        const entry = await prisma.auditLog.findFirst({
            where: {
                tenantId: TX_OFF,
                action: 'AGENT_GOVERNANCE_PACK_EXPORTED',
                entityId: result.evidenceId,
            },
        });
        expect(entry).not.toBeNull();
        // The STRUCTURED column. `details` is free text that `logEvent`
        // appends a context line to, and is not parseable as JSON.
        const details = (entry!.detailsJson ?? {}) as Record<string, unknown>;
        // The flag can be flipped afterwards, so the row carries it. Without
        // this, a later reader cannot tell a meaningful pack from a sample.
        expect(details.enforcing).toBe(false);
        expect(details.retentionDays).toBe(PACK_RETENTION_DAYS);
        expect(details.documentBytes).toBeGreaterThan(0);
    });
});

describe('two exports are two documents', () => {
    it('does not overwrite the earlier one', async () => {
        const first = await exportAgentGovernancePack(ctxFor(TX_ON));
        const second = await exportAgentGovernancePack(ctxFor(TX_ON));

        expect(second.evidenceId).not.toBe(first.evidenceId);
        const both = await prisma.evidence.count({
            where: { tenantId: TX_ON, id: { in: [first.evidenceId, second.evidenceId] } },
        });
        // The point of the whole non-idempotent decision: an assessor may
        // already be holding the first one.
        expect(both).toBe(2);
    });
});

describe('isolation', () => {
    it('files into the exporting tenant and nowhere else', async () => {
        const before = await prisma.evidence.count({ where: { tenantId: TX_OFF } });
        const result = await exportAgentGovernancePack(ctxFor(TX_ON));
        const after = await prisma.evidence.count({ where: { tenantId: TX_OFF } });
        expect(after).toBe(before);

        const row = await prisma.evidence.findFirst({ where: { id: result.evidenceId } });
        expect(row!.tenantId).toBe(TX_ON);
        // And the document describes the exporting tenant, not the other one.
        expect(row!.content).toContain(TX_ON);
        expect(row!.content).not.toContain(TX_OFF);
    });
});

describe('both gates, asserted before the work', () => {
    it('refuses a caller without the agent registry key', async () => {
        const ctx = ctxFor(TX_ON, {
            appPermissions: {
                ...makeRequestContext('OWNER').appPermissions,
                admin: { ...makeRequestContext('OWNER').appPermissions.admin, agent_registry: false },
            },
        });
        await expect(exportAgentGovernancePack(ctx)).rejects.toThrow(/agent registry/i);
    });

    it('refuses a caller who may read the pack but may not write evidence', async () => {
        // The gate that would otherwise have fired from deep inside
        // `createEvidence`, AFTER five reports had already been computed.
        const base = makeRequestContext('OWNER').appPermissions;
        const ctx = ctxFor(TX_ON, {
            appPermissions: { ...base, evidence: { ...base.evidence, edit: false } },
        });
        await expect(exportAgentGovernancePack(ctx)).rejects.toThrow(/evidence/i);
    });

    it('writes NOTHING when it refuses', async () => {
        const before = await prisma.evidence.count({ where: { tenantId: TX_ON } });
        const base = makeRequestContext('OWNER').appPermissions;
        const ctx = ctxFor(TX_ON, {
            appPermissions: { ...base, evidence: { ...base.evidence, edit: false } },
        });
        await expect(exportAgentGovernancePack(ctx)).rejects.toThrow();
        expect(await prisma.evidence.count({ where: { tenantId: TX_ON } })).toBe(before);
    });
});
