/**
 * Behavioural cover for `computeVelocity` — the RQ-9 velocity orchestrator.
 *
 * WHY THIS EXISTS: `velocityOf` and `classifyTrend` are pure and were
 * already unit-tested, but the orchestrator around them had never executed
 * in a test. Everything interesting lives there and none of it was covered:
 * the `assertCanRead` gate, the `windowDays` cutoff, the "most recent
 * snapshot at or before the cutoff" join, the RISING/FALLING ranking and
 * `limit`, the tenant scope, and the portfolio aggregate.
 *
 * The structural ratchet it replaces (`tests/guards/rq9-trending.test.ts`,
 * deleted in the same change) regex-matched 41 fragments of risk source. It
 * could see that a `.sort(` existed; it could not see that the ranking
 * ordered by percentage rather than absolute delta, that the cutoff picked
 * the nearest earlier snapshot rather than the oldest, or that a risk with
 * no prior snapshot stays out of the rankings instead of counting as a 100%
 * rise. Each of those is a real way for the dashboard to mislead, and each
 * is asserted below.
 *
 * Snapshot ages are expressed relative to the cutoff the usecase computes
 * (`now - windowDays`), so the test does not depend on wall-clock rounding.
 */
import { PrismaClient, Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { ForbiddenError } from '@/lib/errors/types';
import { computeVelocity } from '@/app-layer/usecases/risk-velocity';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

jest.setTimeout(60_000);

const SUITE = `rvel-${randomUUID().slice(0, 8)}`;
const OURS = `t-ours-${SUITE}`;
const THEIRS = `t-theirs-${SUITE}`;

let userId = '';
const DAY = 86_400_000;

/**
 * A risk whose CURRENT ale comes from `sleAmount × aroAmount` (resolveALE's
 * legacy branch) plus a snapshot `daysAgo` old carrying `previousAle`.
 */
async function seedRiskWithHistory(opts: {
    tenantId?: string;
    title: string;
    currentAle: number;
    previousAle?: number | null;
    daysAgo?: number;
}) {
    const tenantId = opts.tenantId ?? OURS;
    const risk = await globalPrisma.risk.create({
        data: {
            tenantId,
            title: opts.title,
            likelihood: 3,
            impact: 3,
            score: 9,
            // resolveALE prefers fairAle; use it directly so the input is
            // unambiguous and the test is about velocity, not FAIR maths.
            fairAle: opts.currentAle,
        },
    });
    if (opts.previousAle != null) {
        await globalPrisma.riskSnapshot.create({
            data: {
                tenantId,
                riskId: risk.id,
                score: 9,
                inherentScore: 9,
                likelihood: 3,
                impact: 3,
                status: 'OPEN',
                ale: opts.previousAle,
                snapshotAt: new Date(Date.now() - (opts.daysAgo ?? 45) * DAY),
            },
        });
    }
    return risk.id;
}

const ctxAs = (role: Role, tenantId = OURS) =>
    makeRequestContext(role, { userId, tenantId });

describeFn('computeVelocity — the RQ-9 orchestrator', () => {
    beforeAll(async () => {
        for (const [id, slug] of [[OURS, `ours-${SUITE}`], [THEIRS, `theirs-${SUITE}`]]) {
            await globalPrisma.tenant.upsert({
                where: { id },
                update: {},
                create: { id, name: `t ${slug}`, slug },
            });
        }
        const email = `${SUITE}@example.test`;
        const u = await globalPrisma.user.create({
            data: { email, emailHash: hashForLookup(email) },
        });
        userId = u.id;
    });

    afterEach(async () => {
        for (const tenantId of [OURS, THEIRS]) {
            await globalPrisma.riskSnapshot.deleteMany({ where: { tenantId } }).catch(() => {});
            await globalPrisma.risk.deleteMany({ where: { tenantId } }).catch(() => {});
        }
    });

    afterAll(async () => {
        for (const tenantId of [OURS, THEIRS]) {
            await globalPrisma.auditLog.deleteMany({ where: { tenantId } }).catch(() => {});
            await globalPrisma.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {});
        }
        await globalPrisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
        await globalPrisma.$disconnect().catch(() => {});
    });

    it('requires read access', async () => {
        // `makeRequestContext` grants canRead for every role, so the gate has
        // to be exercised by overriding the permission itself rather than by
        // picking a weak role — otherwise this test passes without ever
        // reaching `assertCanRead`.
        const noRead = makeRequestContext('READER', {
            userId,
            tenantId: OURS,
            permissions: {
                canRead: false,
                canWrite: false,
                canAdmin: false,
                canAudit: false,
                canExport: false,
            },
        });
        await expect(computeVelocity(noRead)).rejects.toThrow(ForbiddenError);
    });

    it('classifies a rise, a fall and a flat risk from their snapshots', async () => {
        await seedRiskWithHistory({ title: 'rising', currentAle: 200, previousAle: 100 });
        await seedRiskWithHistory({ title: 'falling', currentAle: 50, previousAle: 100 });
        await seedRiskWithHistory({ title: 'stable', currentAle: 101, previousAle: 100 });

        const res = await computeVelocity(ctxAs('ADMIN'));

        expect(res.topRising.map((v) => v.title)).toEqual(['rising']);
        expect(res.topFalling.map((v) => v.title)).toEqual(['falling']);
        // +1% is inside the ±5% dead band, so 'stable' appears in neither.
        expect([...res.topRising, ...res.topFalling].map((v) => v.title)).not.toContain('stable');
    });

    it('ranks by percentage change, not absolute delta', async () => {
        // 'small' moves +900 (10 → 100, +900%); 'large' moves +5000
        // (100_000 → 105_000, +5%… which is exactly the dead-band edge, so
        // nudge it to +20% to keep it RISING). A ranking that sorted by
        // deltaAle would put 'large' first.
        await seedRiskWithHistory({ title: 'small', currentAle: 100, previousAle: 10 });
        await seedRiskWithHistory({ title: 'large', currentAle: 120_000, previousAle: 100_000 });

        const res = await computeVelocity(ctxAs('ADMIN'));

        expect(res.topRising.map((v) => v.title)).toEqual(['small', 'large']);
    });

    it('excludes a risk with no prior snapshot from the rankings', async () => {
        // The tempting bug is to treat "no previous value" as zero, which
        // makes every brand-new risk an infinite riser and floods the widget.
        await seedRiskWithHistory({ title: 'brand new', currentAle: 500, previousAle: null });
        await seedRiskWithHistory({ title: 'genuine riser', currentAle: 200, previousAle: 100 });

        const res = await computeVelocity(ctxAs('ADMIN'));

        expect(res.topRising.map((v) => v.title)).toEqual(['genuine riser']);
    });

    it('uses the most recent snapshot at or before the cutoff, not the oldest', async () => {
        const id = await seedRiskWithHistory({
            title: 'two snapshots',
            currentAle: 200,
            previousAle: 100,
            daysAgo: 40,
        });
        // An OLDER snapshot with a very different value. If the join picked
        // the oldest row, previousAle would be 10 and the delta +1900%.
        await globalPrisma.riskSnapshot.create({
            data: {
                tenantId: OURS,
                riskId: id,
                score: 9,
                inherentScore: 9,
                likelihood: 3,
                impact: 3,
                status: 'OPEN',
                ale: 10,
                snapshotAt: new Date(Date.now() - 300 * DAY),
            },
        });

        const res = await computeVelocity(ctxAs('ADMIN'));

        expect(res.topRising[0].previousAle).toBe(100);
        expect(res.topRising[0].deltaPercent).toBeCloseTo(100);
    });

    it('ignores snapshots newer than the cutoff', async () => {
        // A snapshot from yesterday is INSIDE the 30-day window, so it is not
        // a "previous" value — the risk has no comparable history and must
        // stay out of the rankings.
        await seedRiskWithHistory({
            title: 'too recent',
            currentAle: 500,
            previousAle: 100,
            daysAgo: 1,
        });

        const res = await computeVelocity(ctxAs('ADMIN'));

        expect(res.topRising).toEqual([]);
        expect(res.topFalling).toEqual([]);
    });

    it('honours a custom windowDays', async () => {
        // 10 days old: outside a 7-day window (so it counts as previous),
        // inside a 30-day window (so it does not).
        await seedRiskWithHistory({
            title: 'ten days',
            currentAle: 200,
            previousAle: 100,
            daysAgo: 10,
        });

        expect((await computeVelocity(ctxAs('ADMIN'), { windowDays: 30 })).topRising).toEqual([]);

        const narrow = await computeVelocity(ctxAs('ADMIN'), { windowDays: 7 });
        expect(narrow.topRising.map((v) => v.title)).toEqual(['ten days']);
        expect(narrow.topRising[0].windowDays).toBe(7);
    });

    it('caps each list at `limit`', async () => {
        for (let i = 0; i < 7; i++) {
            await seedRiskWithHistory({
                title: `riser ${i}`,
                currentAle: 100 + i * 100,
                previousAle: 10,
            });
        }

        expect((await computeVelocity(ctxAs('ADMIN'))).topRising).toHaveLength(5); // default
        expect((await computeVelocity(ctxAs('ADMIN'), { limit: 2 })).topRising).toHaveLength(2);
    });

    it('aggregates the portfolio across every risk, including unranked ones', async () => {
        await seedRiskWithHistory({ title: 'a', currentAle: 200, previousAle: 100 });
        await seedRiskWithHistory({ title: 'b', currentAle: 100, previousAle: 100 });

        const { portfolioVelocity } = await computeVelocity(ctxAs('ADMIN'));

        expect(portfolioVelocity.currentTotalAle).toBe(300);
        expect(portfolioVelocity.previousTotalAle).toBe(200);
        expect(portfolioVelocity.deltaPercent).toBeCloseTo(50);
        expect(portfolioVelocity.trend).toBe('RISING');
    });

    it('does not see another tenant’s risks or snapshots', async () => {
        await seedRiskWithHistory({
            tenantId: THEIRS,
            title: 'theirs',
            currentAle: 10_000,
            previousAle: 100,
        });

        const res = await computeVelocity(ctxAs('ADMIN'));

        expect(res.topRising).toEqual([]);
        expect(res.portfolioVelocity.currentTotalAle).toBe(0);
    });

    it('reports a flat portfolio rather than dividing by zero on an empty tenant', async () => {
        const res = await computeVelocity(ctxAs('ADMIN'));
        expect(res.portfolioVelocity).toEqual({
            currentTotalAle: 0,
            previousTotalAle: 0,
            deltaPercent: 0,
            trend: 'STABLE',
        });
    });
});
