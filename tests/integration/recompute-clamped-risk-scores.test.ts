/**
 * #5080 — the audited recompute, against a real database.
 *
 * This writes to every tenant's risks, so it is proved on real rows rather
 * than a double: the correction, the ledger event that must accompany it, the
 * dry run writing nothing, idempotency, and the rows it must leave alone.
 *
 * The stored likelihood and impact were always correct — a person chose them.
 * Only the derived product was clamped by `Tenant.maxRiskScale`, which nothing
 * in `src/` ever wrote. So every assertion below checks that the DIMENSIONS
 * are untouched and only the score moved.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import {
    recomputeClampedRiskScores,
    findClampedScores,
    type RecomputeClient,
} from '@/lib/risk-matrix/recompute-clamped-scores';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
}) as unknown as PrismaClient;
const db = prisma as unknown as RecomputeClient;

const SUITE = randomUUID().slice(0, 8);
let tenantSix = '';
let tenantDefault = '';

async function makeTenant(slug: string, grid: { l: number; i: number } | null): Promise<string> {
    const t = await prisma.tenant.create({
        data: { name: slug, slug: `${slug}-${SUITE}` },
    });
    if (grid) {
        await prisma.riskMatrixConfig.create({
            data: { tenantId: t.id, likelihoodLevels: grid.l, impactLevels: grid.i },
        });
    }
    return t.id;
}

/** A risk written as the OLD code would have written it. */
async function makeRisk(
    tenantId: string,
    fields: {
        likelihood: number; impact: number; inherentScore: number;
        residualLikelihood?: number; residualImpact?: number; residualScore?: number;
    },
): Promise<string> {
    const r = await prisma.risk.create({
        data: { tenantId, title: `r-${randomUUID().slice(0, 6)}`, ...fields },
    });
    return r.id;
}

describeFn('recomputeClampedRiskScores (#5080)', () => {
    beforeAll(async () => {
        tenantSix = await makeTenant('six', { l: 6, i: 6 });
        tenantDefault = await makeTenant('plain', null);
    });

    afterAll(async () => {
        for (const id of [tenantSix, tenantDefault].filter(Boolean)) {
            await prisma.riskScoreEvent.deleteMany({ where: { tenantId: id } });
            await prisma.risk.deleteMany({ where: { tenantId: id } });
            await prisma.riskMatrixConfig.deleteMany({ where: { tenantId: id } });
            await prisma.tenant.delete({ where: { id } }).catch(() => undefined);
        }
        await prisma.$disconnect();
    });

    it('finds a 6x6 score clamped to 25, and says what it should be', async () => {
        const riskId = await makeRisk(tenantSix, { likelihood: 6, impact: 6, inherentScore: 25 });
        const found = (await findClampedScores(db)).filter((c) => c.riskId === riskId);
        expect(found).toEqual([
            expect.objectContaining({ kind: 'INHERENT', from: 25, to: 36 }),
        ]);
    });

    it('a DRY RUN writes nothing at all', async () => {
        const riskId = await makeRisk(tenantSix, { likelihood: 6, impact: 5, inherentScore: 25 });
        const out = await recomputeClampedRiskScores(db, { execute: false });
        expect(out.applied).toBe(0);
        expect(out.found).toBeGreaterThan(0);

        const row = await prisma.risk.findUniqueOrThrow({ where: { id: riskId } });
        expect(row.inherentScore).toBe(25);
        const events = await prisma.riskScoreEvent.count({ where: { riskId } });
        expect(events).toBe(0);
    });

    it('corrects the score AND appends a MIGRATION ledger event, atomically', async () => {
        const riskId = await makeRisk(tenantSix, { likelihood: 6, impact: 6, inherentScore: 25 });

        await recomputeClampedRiskScores(db, { execute: true });

        const row = await prisma.risk.findUniqueOrThrow({ where: { id: riskId } });
        // Only the DERIVED value moved.
        expect({ l: row.likelihood, i: row.impact, score: row.inherentScore })
            .toEqual({ l: 6, i: 6, score: 36 });

        const events = await prisma.riskScoreEvent.findMany({ where: { riskId } });
        expect(events).toHaveLength(1);
        expect({
            kind: events[0].kind,
            source: events[0].source,
            score: events[0].score,
            user: events[0].createdByUserId,
        }).toEqual({ kind: 'INHERENT', source: 'MIGRATION', score: 36, user: null });
        // The justification has to say what moved, or the ledger is unreadable.
        expect(events[0].justification).toContain('#5080');
        expect(events[0].justification).toContain('25 -> 36');
    });

    it('is IDEMPOTENT — a second pass finds nothing and writes nothing', async () => {
        const before = await prisma.riskScoreEvent.count({ where: { tenantId: tenantSix } });
        const out = await recomputeClampedRiskScores(db, { execute: true });
        const mine = [...out.byTenant.keys()].includes(tenantSix);
        expect({ appliedForUs: mine && out.applied > 0 }).toEqual({ appliedForUs: false });
        const after = await prisma.riskScoreEvent.count({ where: { tenantId: tenantSix } });
        expect(after).toBe(before);
    });

    it('leaves a correctly-scored risk ALONE', async () => {
        // The positive control: a pass that corrected everything would be
        // indistinguishable from one that recomputed blindly.
        const riskId = await makeRisk(tenantSix, { likelihood: 3, impact: 4, inherentScore: 12 });
        await recomputeClampedRiskScores(db, { execute: true });
        const row = await prisma.risk.findUniqueOrThrow({ where: { id: riskId } });
        expect(row.inherentScore).toBe(12);
        expect(await prisma.riskScoreEvent.count({ where: { riskId } })).toBe(0);
    });

    it('uses the DEFAULT grid for a tenant with no config row', async () => {
        // 5x5: a 9 for L3xI3 is already right, so nothing is touched.
        const ok = await makeRisk(tenantDefault, { likelihood: 3, impact: 3, inherentScore: 9 });
        // And an impossible 36 on a 5x5 grid IS corrected back to 25.
        const bad = await makeRisk(tenantDefault, { likelihood: 9, impact: 9, inherentScore: 36 });

        await recomputeClampedRiskScores(db, { execute: true });

        expect((await prisma.risk.findUniqueOrThrow({ where: { id: ok } })).inherentScore).toBe(9);
        expect((await prisma.risk.findUniqueOrThrow({ where: { id: bad } })).inherentScore).toBe(25);
    });

    it('corrects a RESIDUAL score and labels its event RESIDUAL', async () => {
        const riskId = await makeRisk(tenantSix, {
            likelihood: 2, impact: 2, inherentScore: 4,
            residualLikelihood: 6, residualImpact: 6, residualScore: 25,
        });

        await recomputeClampedRiskScores(db, { execute: true });

        const row = await prisma.risk.findUniqueOrThrow({ where: { id: riskId } });
        expect({ inherent: row.inherentScore, residual: row.residualScore })
            .toEqual({ inherent: 4, residual: 36 });
        const events = await prisma.riskScoreEvent.findMany({ where: { riskId } });
        expect(events.map((e) => e.kind)).toEqual(['RESIDUAL']);
    });
});
