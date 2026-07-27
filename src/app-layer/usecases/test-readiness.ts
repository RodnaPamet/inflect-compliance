
/**
 * Test Readiness — Framework-aware test coverage scoring
 *
 * For each framework with mapped controls, computes:
 *   - testPlanCoverage: % of mapped controls with ≥1 ACTIVE test plan
 *   - testRunCoverage:  % of mapped controls with a completed run in last 90 days
 *   - passRate:         % of those completed runs that PASS
 */
import { RequestContext } from '../types';
import { assertCanReadTests } from '../policies/test.policies';
import { runInTenantContext } from '@/lib/db-context';

export interface FrameworkTestReadiness {
    frameworkKey: string;
    frameworkName: string;
    totalMappedControls: number;
    withTestPlan: number;
    testPlanCoverage: number;   // 0–100
    withRecentRun: number;
    testRunCoverage: number;    // 0–100
    passRate: number;           // 0–100
    recentRuns: number;
    recentPasses: number;
}

// Safety caps — realistically never hit (a tenant has dozens of frameworks
// and hundreds of mapped controls), but they bound the worst-case read so
// the aggregate can't degenerate into an unbounded table scan.
const MAX_FRAMEWORKS = 500;
const MAX_MAPPING_LINKS = 50_000;

export async function computeTestReadiness(ctx: RequestContext): Promise<FrameworkTestReadiness[]> {
    assertCanReadTests(ctx);

    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    // R4-P3 #1 — the whole rollup runs in ONE tenant transaction with four
    // batched queries, instead of the previous 1 + 3×N transactions (a real
    // `$transaction` per framework per read). Frameworks are GLOBAL reference
    // data (no tenantId column — keyed by unique `key`), so tenant scoping
    // comes from the ControlRequirementLink / ControlTestPlan / ControlTestRun
    // reads, all of which filter tenantId. Per-control plan/run rollups use
    // groupBy so we never materialise every run row in JS.
    return runInTenantContext(ctx, async (db) => {
        const frameworks = await db.framework.findMany({
            select: { id: true, key: true, name: true },
            take: MAX_FRAMEWORKS,
        });
        if (frameworks.length === 0) return [];
        const frameworkIds = frameworks.map((f) => f.id);

        // All framework↔control mappings across every framework, one query.
        const links = await db.controlRequirementLink.findMany({
            where: { tenantId: ctx.tenantId, requirement: { frameworkId: { in: frameworkIds } } },
            select: { controlId: true, requirement: { select: { frameworkId: true } } },
            take: MAX_MAPPING_LINKS,
        });

        const controlsByFramework = new Map<string, Set<string>>();
        const allControlIds = new Set<string>();
        for (const l of links) {
            const fid = l.requirement.frameworkId;
            let set = controlsByFramework.get(fid);
            if (!set) { set = new Set(); controlsByFramework.set(fid, set); }
            set.add(l.controlId);
            allControlIds.add(l.controlId);
        }
        const controlIdList = [...allControlIds];
        if (controlIdList.length === 0) return [];

        // Controls with an ACTIVE plan — distinct controlIds via groupBy
        // (bounded by the number of mapped controls, not the plan count).
        const planGroups = await db.controlTestPlan.groupBy({
            by: ['controlId'],
            where: { tenantId: ctx.tenantId, controlId: { in: controlIdList }, status: 'ACTIVE' },
        });
        const controlsWithPlan = new Set(planGroups.map((g) => g.controlId as string));

        // Recent completed runs per control+result — one groupBy, aggregated
        // to per-control totals/passes in memory.
        const runGroups = await db.controlTestRun.groupBy({
            by: ['controlId', 'result'],
            where: {
                tenantId: ctx.tenantId,
                controlId: { in: controlIdList },
                status: 'COMPLETED',
                executedAt: { gte: ninetyDaysAgo },
            },
            _count: { _all: true },
        });
        const runsByControl = new Map<string, { total: number; passes: number }>();
        for (const g of runGroups) {
            const cid = g.controlId as string;
            const acc = runsByControl.get(cid) ?? { total: 0, passes: 0 };
            acc.total += g._count._all;
            if (g.result === 'PASS') acc.passes += g._count._all;
            runsByControl.set(cid, acc);
        }

        const results: FrameworkTestReadiness[] = [];
        for (const fw of frameworks) {
            const controls = controlsByFramework.get(fw.id);
            const totalMapped = controls?.size ?? 0;
            if (totalMapped === 0) continue;

            let withPlan = 0;
            let withRun = 0;
            let recentRuns = 0;
            let recentPasses = 0;
            for (const cid of controls!) {
                if (controlsWithPlan.has(cid)) withPlan++;
                const r = runsByControl.get(cid);
                if (r) { withRun++; recentRuns += r.total; recentPasses += r.passes; }
            }

            results.push({
                frameworkKey: fw.key,
                frameworkName: fw.name,
                totalMappedControls: totalMapped,
                withTestPlan: withPlan,
                testPlanCoverage: Math.round((withPlan / totalMapped) * 100),
                withRecentRun: withRun,
                testRunCoverage: Math.round((withRun / totalMapped) * 100),
                passRate: recentRuns > 0 ? Math.round((recentPasses / recentRuns) * 100) : 0,
                recentRuns,
                recentPasses,
            });
        }

        return results;
    });
}
