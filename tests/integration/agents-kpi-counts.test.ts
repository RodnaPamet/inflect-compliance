/**
 * EACH KPI COUNT EQUALS THE ROW COUNT ITS OWN CLICK PRODUCES (#2432).
 *
 * The register's four cards are a promise: the number on a card is how many
 * rows you will see if you click it. Before this landed, the cards were derived
 * from the loaded array — the SSR window, capped — while each card's filter
 * resolves against the whole tenant. So a card read 3 and produced 47. That is
 * #1905, and it is the defect this file exists to make unrepeatable.
 *
 * ── THE SEED IS BIGGER THAN ONE PAGE, DELIBERATELY ──────────────────────────
 *
 * `SEEDED` is above the register's `take` default (200), so a client-side
 * derivation CANNOT satisfy these assertions: the loaded array physically
 * cannot hold the tenant. That is the whole point of the size — it is not a
 * stress test, it is the only seed size at which the two implementations give
 * different answers.
 *
 * ── WHAT "THE ROW COUNT ITS CLICK PRODUCES" MEANS HERE ──────────────────────
 *
 * The click sets a filter and the page re-renders SERVER-side against it. So
 * the comparison is `kpiCounts.X` against `listRegisteredAgents(ctx, { filters:
 * <the filter that card sets> })` — the same call the page makes after the
 * click, with `take` raised past the seed so the LIST is not the thing doing
 * the capping. Raising `take` on the right-hand side is not a cheat: the card's
 * claim is about the population its filter selects, and a capped list would
 * make the assertion about the cap.
 *
 * A second, independent counter runs beside it — a raw `prisma.count` over the
 * same predicate, written out by hand rather than through the repository — so
 * the two sides of each assertion do not come from one function that could be
 * wrong in the same direction twice.
 */
import { PrismaClient, MembershipStatus, Role } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    listAgentKpiCounts,
    listRegisteredAgents,
    parseAgentListFilters,
} from '@/app-layer/usecases/agent-registry';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(180_000);

const T1 = 'agentkpi-tenant-one';

/**
 * 260 agents — above the register's 200-row `take`.
 *
 * The populations below are chosen so no two cards can coincide: if `active`
 * and `egress` produced the same number, a test that swapped their filters
 * would still pass.
 */
const SEEDED = {
    /** ACTIVE, scored MODERATE, reads tenant data. */
    activeScored: 120,
    /** ACTIVE, UNSCORED (riskTier null) — the state the register exists for. */
    activeUnscored: 47,
    /** SUSPENDED, scored, EXTERNAL_EGRESS. */
    suspendedEgress: 33,
    /** DRAFT, UNSCORED, EXTERNAL_EGRESS — in BOTH of the two narrow buckets. */
    draftUnscoredEgress: 60,
} as const;
const TOTAL =
    SEEDED.activeScored +
    SEEDED.activeUnscored +
    SEEDED.suspendedEgress +
    SEEDED.draftUnscoredEgress;

/** Deliberately above the seed, so the LIST is not what caps the comparison. */
const UNCAPPED = TOTAL + 50;

let ownerUserId = '';
let aiSystemId = '';

const ctx = () =>
    makeRequestContext('OWNER', { tenantId: T1, tenantSlug: T1, userId: ownerUserId });

async function clearOwnRows(): Promise<void> {
    await prisma.registeredAgent.deleteMany({ where: { tenantId: T1 } });
    await prisma.aiSystem.deleteMany({ where: { tenantId: T1 } });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, T1);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, T1);
    });
    await prisma.user.deleteMany({
        where: { emailHash: hashForLookup(`owner@${T1}.test`) },
    });
    await prisma.tenant.deleteMany({ where: { id: T1 } });
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();

    await prisma.tenant.create({ data: { id: T1, name: 'KPI tenant', slug: T1 } });
    const email = `owner@${T1}.test`;
    const user = await prisma.user.create({
        data: { email, emailHash: hashForLookup(email) },
    });
    ownerUserId = user.id;
    await prisma.tenantMembership.create({
        data: {
            tenantId: T1,
            userId: user.id,
            role: Role.OWNER,
            status: MembershipStatus.ACTIVE,
        },
    });
    // ONE AiSystem PER AGENT. `RegisteredAgent.aiSystemId` is UNIQUE — the
    // link is 1:1, because an agent IS the AI system as the Regulation's
    // register sees it — so a shared host id fails the constraint on the
    // second row. Seeded first, with deterministic ids the agent rows below
    // name, so the whole seed is two `createMany` calls rather than 260 pairs.
    const aiSystemIdFor = (n: number) => `agentkpi-sys-${String(n).padStart(4, '0')}`;
    await prisma.aiSystem.createMany({
        data: Array.from({ length: TOTAL }, (_, n) => ({
            id: aiSystemIdFor(n),
            tenantId: T1,
            name: `Agent host ${n}`,
            ownerUserId: user.id,
        })),
    });
    aiSystemId = aiSystemIdFor(0);

    // Seeded through `createMany` rather than the create usecase: 260 audited
    // creates is minutes, and this file asserts nothing about the write path.
    // The columns the four cards read are set explicitly on every row.
    // The element type of `createMany`'s `data`, spelled without reaching
    // through an optional parameter — `Parameters<…>[0]` is `T | undefined`.
    type AgentSeedRow = Parameters<
        typeof prisma.registeredAgent.createMany
    >[0] extends { data: infer D } | undefined
        ? D extends readonly (infer E)[]
            ? E
            : D
        : never;
    const rows: AgentSeedRow[] = [];
    let seq = 0;
    const push = (
        n: number,
        prefix: string,
        status: 'ACTIVE' | 'SUSPENDED' | 'DRAFT',
        riskTier: 'MODERATE' | null,
        scope: 'READ_TENANT_DATA' | 'EXTERNAL_EGRESS',
    ) => {
        for (let i = 0; i < n; i++) {
            rows.push({
                tenantId: T1,
                aiSystemId: aiSystemIdFor(seq++),
                name: `${prefix}-${i}`,
                autonomyLevel: 2,
                dataAccessScope: scope,
                reversibility: 'COMPENSABLE',
                provenance: 'FIRST_PARTY',
                status,
                riskTier,
                // The CHECK constraint pins `riskTier IS NULL` ⇔
                // `riskTierScoredAt IS NULL`, so the two move together.
                riskTierScoredAt: riskTier === null ? null : new Date(),
                ownerUserId,
                createdByUserId: ownerUserId,
            });
        }
    };
    push(SEEDED.activeScored, 'active-scored', 'ACTIVE', 'MODERATE', 'READ_TENANT_DATA');
    push(SEEDED.activeUnscored, 'active-unscored', 'ACTIVE', null, 'READ_TENANT_DATA');
    push(SEEDED.suspendedEgress, 'susp-egress', 'SUSPENDED', 'MODERATE', 'EXTERNAL_EGRESS');
    push(
        SEEDED.draftUnscoredEgress,
        'draft-unscored-egress',
        'DRAFT',
        null,
        'EXTERNAL_EGRESS',
    );
    await prisma.registeredAgent.createMany({ data: rows });
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('the seed is bigger than one page — otherwise this suite proves nothing', () => {
    it('holds more agents than the register loads at once', async () => {
        const page = await listRegisteredAgents(ctx(), {});
        // The DEFAULT take, with no filters: capped, and BELOW the tenant.
        expect(page.length).toBe(200);
        expect(TOTAL).toBeGreaterThan(page.length);
        // …and the uncapped read sees all of them, so the comparisons below
        // are against the real population rather than a second cap.
        const all = await listRegisteredAgents(ctx(), { take: UNCAPPED });
        expect(all.length).toBe(TOTAL);
    });
});

describe('each card’s number equals the rows its own click produces', () => {
    /**
     * The four cards, each paired with the FILTER its click sets.
     *
     * Written as the query string the FilterProvider pushes and parsed by the
     * page's own `parseAgentListFilters`, so the test drives the same code path
     * a click does rather than constructing the filter object by hand — a hand
     * construction could agree with the counts while the URL round trip did
     * not.
     */
    const CARDS = [
        { id: 'total', query: {} as Record<string, string>, expected: TOTAL },
        {
            id: 'active',
            query: { status: 'ACTIVE' },
            expected: SEEDED.activeScored + SEEDED.activeUnscored,
        },
        {
            id: 'unscored',
            query: { riskTier: 'UNSCORED' },
            expected: SEEDED.activeUnscored + SEEDED.draftUnscoredEgress,
        },
        {
            id: 'egress',
            query: { dataAccessScope: 'EXTERNAL_EGRESS' },
            expected: SEEDED.suspendedEgress + SEEDED.draftUnscoredEgress,
        },
    ] as const;

    it.each(CARDS.map((c) => [c.id, c] as const))(
        'the %s card’s count is the row count its click produces',
        async (_id, card) => {
            const counts = await listAgentKpiCounts(ctx(), {});
            const shown = counts[card.id as keyof typeof counts];

            // The rows the click actually produces — the page's own list call
            // with the card's filter, read past the cap.
            const filters = parseAgentListFilters(card.query);
            const produced = await listRegisteredAgents(ctx(), { filters, take: UNCAPPED });

            expect(shown).toBe(produced.length);
            // Pinned to the SEEDED figure too, so a bug that made both sides
            // wrong in the same direction — a predicate that matched nothing,
            // or everything — cannot pass.
            expect(shown).toBe(card.expected);
        },
    );

    it('no two cards report the same number — a swapped filter could not hide', async () => {
        const counts = await listAgentKpiCounts(ctx(), {});
        const values = [counts.total, counts.active, counts.unscored, counts.egress];
        expect(new Set(values).size).toBe(values.length);
    });

    it('the counts agree with a SECOND, independently written counter', async () => {
        // The same predicates spelled out against Prisma directly rather than
        // through the repository, so the expectation does not come from the
        // code under test.
        const counts = await listAgentKpiCounts(ctx(), {});
        const base = { tenantId: T1, deletedAt: null };
        expect(counts.total).toBe(await prisma.registeredAgent.count({ where: base }));
        expect(counts.active).toBe(
            await prisma.registeredAgent.count({ where: { ...base, status: 'ACTIVE' } }),
        );
        expect(counts.unscored).toBe(
            await prisma.registeredAgent.count({ where: { ...base, riskTier: null } }),
        );
        expect(counts.egress).toBe(
            await prisma.registeredAgent.count({
                where: { ...base, dataAccessScope: 'EXTERNAL_EGRESS' },
            }),
        );
    });
});

describe('the cards survive a filter already being set', () => {
    it('total IGNORES the active filters, because its click clears them', async () => {
        // The card calls `clearAll()`, so the tenant-wide number is exactly
        // what the click produces. Intersecting it with the current filters
        // would make the card disagree with itself the moment any filter was
        // set — which is what `total` did on Policies before #1905.
        const withFilter = await listAgentKpiCounts(ctx(), { status: ['DRAFT'] });
        expect(withFilter.total).toBe(TOTAL);
    });

    it('the three narrow cards REPLACE their own term and keep the rest', async () => {
        // Active + egress already set. The `egress` card replaces
        // `dataAccessScope` and keeps `status`, so its number is the
        // ACTIVE ∩ EXTERNAL_EGRESS population — which this seed makes ZERO,
        // and zero is a real answer the card has to be able to give.
        const counts = await listAgentKpiCounts(ctx(), {
            status: ['ACTIVE'],
            dataAccessScope: ['READ_TENANT_DATA'],
        });
        expect(counts.egress).toBe(0);
        const produced = await listRegisteredAgents(ctx(), {
            filters: {
                status: ['ACTIVE'],
                dataAccessScope: ['EXTERNAL_EGRESS'],
            },
            take: UNCAPPED,
        });
        expect(produced.length).toBe(0);

        // …and the `unscored` card, under the same two filters, replaces
        // `riskTier` (which was not set) and keeps both — so it is the ACTIVE
        // ∩ READ_TENANT_DATA ∩ unscored population, a NON-zero number. Paired
        // with the zero above so "replaces its own term" is distinguishable
        // from "matches nothing".
        expect(counts.unscored).toBe(SEEDED.activeUnscored);
    });
});

describe('UNSCORED is a filter member, not an absence', () => {
    it('composes with a real tier rather than overwriting it', async () => {
        // Selecting UNSCORED and MODERATE together must yield BOTH — an OR of
        // `riskTier IS NULL` and `riskTier IN (…)`. A predicate that let one
        // arm overwrite the other would return one of the two sub-populations
        // and look entirely plausible.
        const filters = parseAgentListFilters({ riskTier: 'UNSCORED,MODERATE' });
        const rows = await listRegisteredAgents(ctx(), { filters, take: UNCAPPED });
        expect(rows.length).toBe(TOTAL);

        const unscoredOnly = await listRegisteredAgents(ctx(), {
            filters: parseAgentListFilters({ riskTier: 'UNSCORED' }),
            take: UNCAPPED,
        });
        const moderateOnly = await listRegisteredAgents(ctx(), {
            filters: parseAgentListFilters({ riskTier: 'MODERATE' }),
            take: UNCAPPED,
        });
        // Both arms are non-empty, so the union above is a real union.
        expect(unscoredOnly.length).toBe(
            SEEDED.activeUnscored + SEEDED.draftUnscoredEgress,
        );
        expect(moderateOnly.length).toBe(SEEDED.activeScored + SEEDED.suspendedEgress);
        expect(unscoredOnly.length + moderateOnly.length).toBe(rows.length);
    });

    it('refuses a tier value that is not in the vocabulary', async () => {
        // A 400 rather than a Prisma 500, and rather than silently ignoring
        // the member — which would show the unfiltered register under a filter
        // chip claiming otherwise.
        expect(() => parseAgentListFilters({ riskTier: 'EXTREME' })).toThrow(
            /Invalid agent authority tier/,
        );
        expect(() => parseAgentListFilters({ status: 'RETIRING' })).toThrow(
            /Invalid agent status/,
        );
    });
});
