/**
 * The UNCLASSIFIED AI-system risk tier against a real database (#3691, deploy 1
 * of 2).
 *
 * Deploy 1 ADDS the value and teaches every reader it; nothing in `src/` writes
 * it. The rows below are inserted with the test's own client for exactly that
 * reason — the registration intake (#3669) that will write them ships in
 * deploy 2. Four properties, none of which a mocked repository can establish:
 *
 *   1. THE TYPE ORDERS IT FIRST. `ADD VALUE ... BEFORE 'PROHIBITED'` is what the
 *      migration says; `pg_enum.enumsortorder` is what Postgres actually did,
 *      and it is the order `ORDER BY "riskTier"` sorts by.
 *   2. THE REGISTER READS IT AS ITS OWN VALUE. `?riskTier=UNCLASSIFIED` finds
 *      the provisional entry, `?riskTier=MINIMAL` does not, and the unfiltered
 *      register lists "not classified" ahead of every classified tier.
 *   3. CONFORMITY DRAFTING REFUSES IT FOR ITS OWN REASON, and queues nothing.
 *      "Not high-risk" would be a classification the system never received.
 *   4. THE ONE WRITER STILL CANNOT PRODUCE IT. An unanswered questionnaire is
 *      classified MINIMAL by the classifier, never stored as UNCLASSIFIED.
 */
import { AiRiskTier, MembershipStatus, PrismaClient, Role } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { createAiSystem, listAiSystems } from '@/app-layer/usecases/ai-system';
import { generateConformityDraft } from '@/app-layer/usecases/ai-system-conformity';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const TENANT = 'ai-tier-unclassified-one';
const ALL_TENANTS = [TENANT];
const OWNER_EMAIL = `owner@${TENANT}.test`;

/** Every value of the column, in the order the migration must leave them. */
const STORED_ORDER = ['UNCLASSIFIED', 'PROHIBITED', 'HIGH', 'LIMITED', 'MINIMAL'] as const;
type StoredTier = (typeof STORED_ORDER)[number];

const NOT_CLASSIFIED_REASON = 'has not been classified against the EU AI Act yet';
const NOT_HIGH_REASON = 'only generated for HIGH-risk AI systems';

let ownerUserId = '';
/** One seeded row per stored tier, keyed by that tier. */
const seededIdByTier = {} as Record<StoredTier, string>;

const ctx = (): RequestContext =>
    makeRequestContext('OWNER', { tenantId: TENANT, tenantSlug: TENANT, userId: ownerUserId });

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: ALL_TENANTS } };
    await prisma.agentProposal.deleteMany({ where: t });
    await prisma.aiDecisionLog.deleteMany({ where: t });
    await prisma.aiSystemRequirementLink.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, ALL_TENANTS);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, ALL_TENANTS);
    });
    await prisma.user.deleteMany({ where: { emailHash: hashForLookup(OWNER_EMAIL) } });
    await prisma.tenant.deleteMany({ where: { id: { in: ALL_TENANTS } } });
}

beforeAll(async () => {
    await clearOwnRows();
    await prisma.tenant.create({ data: { id: TENANT, name: TENANT, slug: TENANT } });
    const user = await prisma.user.create({ data: { email: OWNER_EMAIL, emailHash: hashForLookup(OWNER_EMAIL) } });
    ownerUserId = user.id;
    await prisma.tenantMembership.create({
        data: { tenantId: TENANT, userId: ownerUserId, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });

    // The UNCLASSIFIED row is the OLDEST, so the `createdAt desc` tie-break
    // would put it LAST: only the enum's own order can put it first.
    const base = Date.UTC(2026, 0, 1);
    for (const [i, riskTier] of STORED_ORDER.entries()) {
        const row = await prisma.aiSystem.create({
            data: {
                tenantId: TENANT,
                name: `Seeded ${riskTier} system`,
                riskTier,
                ownerUserId,
                createdAt: new Date(base + i * 60_000),
            },
            select: { id: true },
        });
        seededIdByTier[riskTier] = row.id;
    }
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('the AiRiskTier type', () => {
    it('lists UNCLASSIFIED first, then the four classified tiers in precedence order', async () => {
        const rows = await prisma.$queryRaw<{ enumlabel: string }[]>`
            SELECT e.enumlabel
              FROM pg_enum e
             WHERE e.enumtypid = '"AiRiskTier"'::regtype
             ORDER BY e.enumsortorder`;
        expect(rows.map((r) => r.enumlabel)).toEqual([...STORED_ORDER]);
    });

    it('the generated client declares the same values in the same order', () => {
        expect(Object.values(AiRiskTier)).toEqual([...STORED_ORDER]);
    });
});

describe('the register reads UNCLASSIFIED as its own value', () => {
    it('?riskTier=UNCLASSIFIED returns the provisional entry and nothing else', async () => {
        const rows = await listAiSystems(ctx(), { riskTier: 'UNCLASSIFIED' });
        expect(rows.map((r) => r.id)).toEqual([seededIdByTier.UNCLASSIFIED]);
        expect(rows[0].riskTier).toBe('UNCLASSIFIED');
    });

    it('?riskTier=MINIMAL does not return it', async () => {
        const rows = await listAiSystems(ctx(), { riskTier: 'MINIMAL' });
        const ids = rows.map((r) => r.id);
        // Non-empty first: a filter that returned nothing would also "not
        // return" the provisional entry.
        expect(ids).toContain(seededIdByTier.MINIMAL);
        expect(ids).not.toContain(seededIdByTier.UNCLASSIFIED);
        expect(new Set(rows.map((r) => r.riskTier))).toEqual(new Set(['MINIMAL']));
    });

    it('an unfiltered list orders it before every classified tier', async () => {
        const rows = await listAiSystems(ctx());
        const ids = rows.map((r) => r.id);
        for (const tier of STORED_ORDER) expect(ids).toContain(seededIdByTier[tier]);

        expect(ids[0]).toBe(seededIdByTier.UNCLASSIFIED);
        const tierRuns = rows.map((r) => r.riskTier).filter((tier, i, all) => i === 0 || all[i - 1] !== tier);
        expect(tierRuns).toEqual([...STORED_ORDER]);
    });
});

describe('conformity drafting', () => {
    const DRAFT = { docType: 'ANNEX_IV_TECHNICAL_DOCUMENTATION' } as const;
    const proposals = () => prisma.agentProposal.count({ where: { tenantId: TENANT } });

    it('refuses an UNCLASSIFIED system as not classified, and queues no proposal', async () => {
        const before = await proposals();
        expect(before).toBe(0);

        const err = await generateConformityDraft(ctx(), seededIdByTier.UNCLASSIFIED, DRAFT).then(
            () => null,
            (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(Error);
        expect(err).toMatchObject({ status: 400 });
        expect((err as Error).message).toContain(NOT_CLASSIFIED_REASON);
        expect((err as Error).message).not.toContain(NOT_HIGH_REASON);
        expect(await proposals()).toBe(0);

        // The count above can move: the same call on a HIGH system queues
        // exactly one proposal, so the zero is a refusal rather than a table
        // this test cannot see.
        const queued = await generateConformityDraft(ctx(), seededIdByTier.HIGH, DRAFT);
        expect(queued.aiSystemId).toBe(seededIdByTier.HIGH);
        expect(await proposals()).toBe(1);
        expect(
            await prisma.agentProposal.count({ where: { tenantId: TENANT, id: queued.proposalId } }),
        ).toBe(1);
    });
});

describe('createAiSystem with no classification answers', () => {
    it.each([
        ['an absent questionnaire', {}],
        [
            'four explicit nulls',
            {
                classification: {
                    prohibitedPractice: null,
                    isAnnexIProductSafetyComponent: null,
                    annexIIIArea: null,
                    transparencyCase: null,
                },
            },
        ],
    ])('stores MINIMAL for %s, never UNCLASSIFIED', async (label, extra) => {
        const created = await createAiSystem(ctx(), { name: `Unanswered: ${label}`, ...extra });
        expect(created.riskTier).toBe('MINIMAL');

        const stored = await prisma.aiSystem.findUniqueOrThrow({
            where: { id: created.id },
            select: { tenantId: true, riskTier: true },
        });
        expect(stored).toEqual({ tenantId: TENANT, riskTier: 'MINIMAL' });
    });
});
