/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks and
 * fixtures mirror runtime Prisma contracts; per-line typing has poor
 * cost/benefit in test files (file-level disable is the codebase norm). */
/**
 * Branch-coverage companion for
 * src/app-layer/usecases/audit-readiness/scoring.ts
 *
 * The existing suite (tests/unit/usecases/audit-readiness-scoring.test.ts)
 * covers the weight invariants, the gate, framework dispatch, the
 * archived-evidence filter, and the CSV-export emit. It exercises the
 * "all-empty DB" path, so the SCORING arithmetic + the threshold /
 * recommendation / gap-cap / severity branches sit largely uncovered.
 *
 * This file drives NON-EMPTY input distributions through all three
 * scoring profiles (ISO27001 / NIS2 / GENERIC) plus the per-tenant
 * weight-override seam (valid + every rejection branch) and
 * getReadinessHistory's clamp branches. The assertions check the
 * actual computed scores/breakdowns so the scoring branches are hit
 * for real, not just touched.
 *
 * Mock shape: a single mutable `db` holder (mock-prefixed so the
 * jest.mock factory may close over it). `runInTenantContext` invokes
 * its callback with that db. Every scoring query dispatches off the
 * model+method on the holder, so call ORDER is irrelevant — far less
 * brittle than the sequential `mockImplementationOnce` chain.
 */

const mockDbHolder: { db: any } = { db: null };

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDbHolder.db)),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/app-layer/policies/audit-readiness.policies', () => ({
    assertCanViewPack: jest.fn(),
}));

// `addReadinessToPack` lazily imports `addAuditPackItems`. That import used
// to reach the barrel; now that scoring.ts lives inside the module it is a
// direct sibling, so the mock follows it to `./packs`.
jest.mock('@/app-layer/usecases/audit-readiness/packs', () => ({
    addAuditPackItems: jest.fn().mockResolvedValue({ ok: true }),
}));

import {
    computeReadiness,
    getReadinessHistory,
    addReadinessToPack,
} from '@/app-layer/usecases/audit-readiness/scoring';
import { assertCanViewPack } from '@/app-layer/policies/audit-readiness.policies';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN');

/**
 * Build a fully-configurable tenant-scoped db double. Each option
 * controls one query the scoring code makes; defaults are the
 * "empty" path so a test only overrides what it cares about.
 */
function buildDb(opts: {
    cycle?: any;
    readinessWeightsJson?: any;          // Tenant.readinessWeightsJson
    framework?: any;                      // framework.findFirst
    requirements?: any[];                 // frameworkRequirement.findMany
    mappedLinks?: any[];                  // controlRequirementLink.findMany (requirementId/controlId)
    controlsApplicable?: any[];           // ISO control.findMany (impl count) — has status
    controlsWithEvidence?: any[];         // control.findMany with evidence sub-select
    allControls?: any[];                  // NIS2 fallback control.findMany {id}
    genericControls?: any[];              // GENERIC control.findMany {id}
    genericEvidence?: any[];              // GENERIC evidence.findMany {controlId}
    policies?: any[];                     // policy.findMany
    overdueTasks?: any[];                 // ISO overdue task.findMany
    openTasks?: any[];                    // ISO/NIS2 open-issue task.findMany
    taskCount?: number;                   // GENERIC task.count
    openFindingCount?: number;            // feat/audit-cycle-unify — finding.count on cycle audits
    snapshotThrows?: boolean;             // readinessSnapshot.create rejects
}) {
    // control.findMany is called for several distinct shapes. We
    // disambiguate by inspecting the `where` / `select` the code passes.
    const controlFindMany = jest.fn(async (args: any) => {
        const where = args?.where ?? {};
        const select = args?.select ?? {};
        // GENERIC: applicability APPLIES + deletedAt null + requirementLinks some
        if (where.requirementLinks) return opts.genericControls ?? [];
        // ISO impl-count: applicability APPLICABLE, select has status, no join
        if (where.applicability === 'APPLICABLE' && select.status && !select.evidenceControlLinks) {
            return opts.controlsApplicable ?? [];
        }
        // ISO/NIS2 evidence sub-select: select.evidenceControlLinks present
        // (EP-3 — evidence-for-controls is read through the many-to-many join).
        if (select.evidenceControlLinks) return opts.controlsWithEvidence ?? [];
        // NIS2 controlIds==[] fallback: where.tenantId only, select {id}
        return opts.allControls ?? [];
    });

    return {
        auditCycle: { findFirst: jest.fn().mockResolvedValue(opts.cycle ?? null) },
        tenant: {
            findUnique: jest.fn().mockResolvedValue(
                opts.readinessWeightsJson === undefined
                    ? null
                    : { readinessWeightsJson: opts.readinessWeightsJson },
            ),
        },
        framework: { findFirst: jest.fn().mockResolvedValue(opts.framework ?? null) },
        frameworkRequirement: { findMany: jest.fn().mockResolvedValue(opts.requirements ?? []) },
        controlRequirementLink: { findMany: jest.fn().mockResolvedValue(opts.mappedLinks ?? []) },
        control: { findMany: controlFindMany },
        evidence: { findMany: jest.fn().mockResolvedValue(opts.genericEvidence ?? []) },
        // EP-3 — GENERIC evidence completeness reads the Evidence↔Control join
        // directly: evidenceControlLink.findMany({ where: { controlId: { in } } })
        // returning `{ controlId }` rows deduped into a withEvidence set.
        evidenceControlLink: { findMany: jest.fn().mockResolvedValue(opts.genericEvidence ?? []) },
        // feat/audit-cycle-unify — open findings raised on the cycle's
        // audits fold into the issue count. Defaults to 0 so the
        // no-findings scores every test asserts stay unchanged.
        finding: { count: jest.fn().mockResolvedValue(opts.openFindingCount ?? 0) },
        policy: { findMany: jest.fn().mockResolvedValue(opts.policies ?? []) },
        task: {
            findMany: jest.fn(async (args: any) => {
                // ISO overdue path filters on dueAt; NIS2/ISO issue path on type.
                if (args?.where?.dueAt) return opts.overdueTasks ?? [];
                return opts.openTasks ?? [];
            }),
            count: jest.fn().mockResolvedValue(opts.taskCount ?? 0),
        },
        readinessSnapshot: {
            // Dedup reads the latest snapshot before writing; null = no prior
            // snapshot → treated as movement → the create path runs.
            findFirst: jest.fn().mockResolvedValue(null),
            create: opts.snapshotThrows
                ? jest.fn().mockRejectedValue(new Error('snapshot boom'))
                : jest.fn().mockResolvedValue({}),
            findMany: jest.fn().mockResolvedValue([]),
        },
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDbHolder.db = null;
});

// ─────────────────────────────────────────────────────────────────
// ISO27001 scoring — non-empty distributions hit the arithmetic +
// recommendation thresholds + gap caps + severity branches.
// ─────────────────────────────────────────────────────────────────
describe('computeISO27001Readiness — scoring arithmetic & thresholds', () => {
    it('perfect distribution → 100 + "strong" recommendation (all thresholds pass)', async () => {
        // coverage 100 (2/2 mapped), impl 100 (2/2), evidence 100 (2/2),
        // tasks 100 (0 overdue), issues 100 (0 open).
        mockDbHolder.db = buildDb({
            cycle: { id: 'c1', frameworkKey: 'ISO27001' },
            framework: { id: 'fw' },
            requirements: [{ id: 'r1', code: 'A.5', title: 'x' }, { id: 'r2', code: 'A.6', title: 'y' }],
            mappedLinks: [{ requirementId: 'r1' }, { requirementId: 'r2' }],
            controlsApplicable: [
                { id: 'k1', code: 'C1', name: 'n', status: 'IMPLEMENTED' },
                { id: 'k2', code: 'C2', name: 'n', status: 'IMPLEMENTED' },
            ],
            controlsWithEvidence: [
                { id: 'k1', code: 'C1', name: 'n', evidenceControlLinks: [{ evidenceId: 'e1' }] },
                { id: 'k2', code: 'C2', name: 'n', evidenceControlLinks: [{ evidenceId: 'e2' }] },
            ],
        });

        const r = await computeReadiness(ctx, 'c1');
        expect(r.score).toBe(100);
        expect(r.breakdown.coverage.score).toBe(100);
        expect(r.breakdown.implementation!.score).toBe(100);
        expect(r.breakdown.evidence.score).toBe(100);
        expect(r.gaps).toHaveLength(0);
        // recs.length === 0 → "strong" fallback recommendation.
        expect(r.recommendations.some((s) => /strong/i.test(s))).toBe(true);
    });

    it('low distribution → low score, all recommendation thresholds fire, gaps capped', async () => {
        // 12 requirements, only 1 mapped → coverage ≈ 8 (< 50).
        // 11 unmapped → UNMAPPED_REQUIREMENT gaps capped at 10.
        const requirements = Array.from({ length: 12 }, (_, i) => ({
            id: `r${i}`, code: `A.${i}`, title: `req ${i}`,
        }));
        // 4 applicable controls, 1 IMPLEMENTED → impl 25 (< 60).
        const controlsApplicable = Array.from({ length: 4 }, (_, i) => ({
            id: `k${i}`, code: `C${i}`, name: `c${i}`, status: i === 0 ? 'IMPLEMENTED' : 'DRAFT',
        }));
        // 4 controls, none with evidence → evidence 0 (< 50). 4 missing
        // → MISSING_EVIDENCE gaps (cap 10, only 4 here).
        const controlsWithEvidence = Array.from({ length: 4 }, (_, i) => ({
            id: `k${i}`, code: `C${i}`, name: `c${i}`, evidenceControlLinks: [],
        }));
        // 7 overdue tasks → taskScore = max(0,100-70)=30; overdue>5 rec.
        // First 5 produce OVERDUE_TASK gaps. dueAt undefined → 'unknown'.
        const overdueTasks = Array.from({ length: 7 }, (_, i) => ({
            id: `t${i}`, title: `task ${i}`, dueAt: i === 0 ? new Date('2020-01-02T00:00:00Z') : null,
        }));
        // 5 open issues → issueScore = max(0,100-75)=25; issues>3 rec.
        // First 5 → OPEN_ISSUE gaps; mix CRITICAL (HIGH) vs other (MEDIUM).
        const openTasks = Array.from({ length: 5 }, (_, i) => ({
            id: `i${i}`, title: `issue ${i}`, severity: i === 0 ? 'CRITICAL' : 'LOW',
        }));

        mockDbHolder.db = buildDb({
            cycle: { id: 'c1', frameworkKey: 'ISO27001' },
            framework: { id: 'fw' },
            requirements,
            mappedLinks: [{ requirementId: 'r0' }],
            controlsApplicable,
            controlsWithEvidence,
            overdueTasks,
            openTasks,
        });

        const r = await computeReadiness(ctx, 'c1');

        expect(r.breakdown.coverage.score).toBe(8);        // round(1/12*100)
        expect(r.breakdown.implementation!.score).toBe(25);
        expect(r.breakdown.evidence.score).toBe(0);
        expect(r.breakdown.tasks!.score).toBe(30);
        expect(r.breakdown.issues.score).toBe(25);
        expect(r.breakdown.tasks!.overdue).toBe(7);
        expect(r.breakdown.issues.open).toBe(5);

        // Gap caps: 10 unmapped + 4 missing-evidence + 5 overdue + 5 issue = 24.
        const byType = (t: string) => r.gaps.filter((g) => g.type === t);
        expect(byType('UNMAPPED_REQUIREMENT')).toHaveLength(10);   // capped from 11
        expect(byType('MISSING_EVIDENCE')).toHaveLength(4);
        expect(byType('OVERDUE_TASK')).toHaveLength(5);
        expect(byType('OPEN_ISSUE')).toHaveLength(5);

        // Severity branch on open issues: CRITICAL → HIGH, else MEDIUM.
        const issueGaps = byType('OPEN_ISSUE');
        expect(issueGaps.some((g) => g.severity === 'HIGH')).toBe(true);
        expect(issueGaps.some((g) => g.severity === 'MEDIUM')).toBe(true);

        // Overdue-task gap details: dated → ISO date; null → 'unknown'.
        const overdueGaps = byType('OVERDUE_TASK');
        expect(overdueGaps.some((g) => g.details.includes('2020-01-02'))).toBe(true);
        expect(overdueGaps.some((g) => g.details.includes('unknown'))).toBe(true);

        // Every ISO recommendation threshold below its bar:
        const recs = r.recommendations.join(' | ');
        expect(recs).toMatch(/below 50%/);                  // coverage < 50
        expect(recs).toMatch(/not yet IMPLEMENTED/);        // impl < 60
        expect(recs).toMatch(/auditors will expect/);       // evidence < 50
        expect(recs).toMatch(/7 overdue tasks/);            // overdue > 5
        expect(recs).toMatch(/5 open audit findings/);      // issues > 3
    });

    it('mid distribution → "continue/strengthen" + "remaining task(s)" branches', async () => {
        // coverage 60 (3/5 → 60, in [50,80)); evidence 60 (in [50,80));
        // impl 80 (>=60, no rec); overdue 2 (in (0,5] → "remaining");
        // issues 0.
        const requirements = Array.from({ length: 5 }, (_, i) => ({
            id: `r${i}`, code: `A.${i}`, title: `r${i}`,
        }));
        const controlsApplicable = Array.from({ length: 5 }, (_, i) => ({
            id: `k${i}`, code: `C${i}`, name: 'n', status: i < 4 ? 'IMPLEMENTED' : 'DRAFT',
        }));
        const controlsWithEvidence = Array.from({ length: 5 }, (_, i) => ({
            id: `k${i}`, code: `C${i}`, name: 'n', evidenceControlLinks: i < 3 ? [{ evidenceId: 'e' }] : [],
        }));
        mockDbHolder.db = buildDb({
            cycle: { id: 'c1', frameworkKey: 'ISO27001' },
            framework: { id: 'fw' },
            requirements,
            mappedLinks: [{ requirementId: 'r0' }, { requirementId: 'r1' }, { requirementId: 'r2' }],
            controlsApplicable,
            controlsWithEvidence,
            overdueTasks: [{ id: 't0', title: 't', dueAt: null }, { id: 't1', title: 't', dueAt: null }],
            openTasks: [],
        });

        const r = await computeReadiness(ctx, 'c1');
        expect(r.breakdown.coverage.score).toBe(60);
        expect(r.breakdown.evidence.score).toBe(60);
        expect(r.breakdown.implementation!.score).toBe(80);
        const recs = r.recommendations.join(' | ');
        expect(recs).toMatch(/aim for 80\+% coverage|aim for 80%\+ coverage/);
        expect(recs).toMatch(/Strengthen evidence/);
        expect(recs).toMatch(/Close remaining 2 overdue/);
    });

    it('no framework row → coverage 0 + division-guard branches (totals=0)', async () => {
        // framework null → totalReqs/totalControls stay 0, all the
        // `> 0 ? … : 0` ternaries take the else branch.
        mockDbHolder.db = buildDb({
            cycle: { id: 'c1', frameworkKey: 'ISO27001' },
            framework: null,
            controlsApplicable: [],
            controlsWithEvidence: [],
        });
        const r = await computeReadiness(ctx, 'c1');
        expect(r.breakdown.coverage.score).toBe(0);
        expect(r.breakdown.coverage.total).toBe(0);
        expect(r.breakdown.implementation!.score).toBe(0);
        expect(r.breakdown.evidence.score).toBe(0);
        // tasks/issues default to 100; weighted score still in range.
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(100);
    });
});

// ─────────────────────────────────────────────────────────────────
// NIS2 scoring.
// ─────────────────────────────────────────────────────────────────
describe('computeNIS2Readiness — policies, evidence fallback, issues', () => {
    it('every in-scope control has a linked policy + evidence → high score, no policy gaps', async () => {
        // Linkage-based: the single in-scope control carries a
        // PolicyControlLink (_count.policyLinks > 0) → policyScore = 100.
        mockDbHolder.db = buildDb({
            cycle: { id: 'c1', frameworkKey: 'NIS2' },
            framework: { id: 'fw-nis2' },
            requirements: [{ id: 'r1', code: 'Art.21', title: 'm' }],
            mappedLinks: [{ requirementId: 'r1', controlId: 'k1' }],
            controlsWithEvidence: [{ id: 'k1', code: 'C1', name: 'n', evidenceControlLinks: [{ evidenceId: 'e1' }], _count: { policyLinks: 1 } }],
            openTasks: [],
        });

        const r = await computeReadiness(ctx, 'c1');
        expect(r.frameworkKey).toBe('NIS2');
        expect(r.breakdown.coverage.score).toBe(100);
        expect(r.breakdown.evidence.score).toBe(100);
        expect(r.breakdown.policies!.score).toBe(100);
        expect(r.breakdown.policies!.withPolicy).toBe(r.breakdown.policies!.total);
        expect(r.gaps.filter((g) => g.type === 'MISSING_POLICY')).toHaveLength(0);
        expect(r.recommendations.some((s) => /readiness is strong/i.test(s))).toBe(true);
    });

    it('no policies + unmapped reqs + open issues → policy gaps, missing-evidence gaps, low recs', async () => {
        // No mapped links → controlIds==[] → NIS2 falls back to ALL
        // controls (the allControls branch). None have evidence.
        const allControls = [{ id: 'k1' }, { id: 'k2' }];
        const controlsWithEvidence = [
            { id: 'k1', code: 'C1', name: 'n', evidenceControlLinks: [], _count: { policyLinks: 0 } },
            { id: 'k2', code: 'C2', name: 'n', evidenceControlLinks: [], _count: { policyLinks: 0 } },
        ];
        // 1 requirement, unmapped → coverage 0, 1 UNMAPPED gap.
        const openTasks = Array.from({ length: 4 }, (_, i) => ({
            id: `i${i}`, title: `iss${i}`, severity: i === 0 ? 'CRITICAL' : 'LOW', type: 'CONTROL_GAP',
        }));
        mockDbHolder.db = buildDb({
            cycle: { id: 'c1', frameworkKey: 'NIS2' },
            framework: { id: 'fw-nis2' },
            requirements: [{ id: 'r1', code: 'Art.21', title: 'm' }],
            mappedLinks: [],            // → controlIds empty → fallback
            allControls,
            controlsWithEvidence,       // neither control has a linked policy
            openTasks,
        });

        const r = await computeReadiness(ctx, 'c1');
        expect(r.breakdown.coverage.score).toBe(0);
        expect(r.breakdown.evidence.score).toBe(0);
        expect(r.breakdown.policies!.score).toBe(0);
        // Linkage-based: one MISSING_POLICY gap per in-scope control that
        // has no linked policy (2 controls → 2 gaps, capped at 10).
        expect(r.gaps.filter((g) => g.type === 'MISSING_POLICY')).toHaveLength(2);
        expect(r.gaps.filter((g) => g.type === 'UNMAPPED_REQUIREMENT')).toHaveLength(1);
        expect(r.gaps.filter((g) => g.type === 'MISSING_EVIDENCE')).toHaveLength(2);
        // issueScore = max(0,100-40)=60; issues>3 rec fires.
        expect(r.breakdown.issues.score).toBe(60);
        expect(r.breakdown.issues.open).toBe(4);
        // Severity branch: CRITICAL→HIGH else MEDIUM.
        const issueGaps = r.gaps.filter((g) => g.type === 'OPEN_ISSUE');
        expect(issueGaps.some((g) => g.severity === 'HIGH')).toBe(true);
        expect(issueGaps.some((g) => g.severity === 'MEDIUM')).toBe(true);
        const recs = r.recommendations.join(' | ');
        expect(recs).toMatch(/coverage below 50%/);
        expect(recs).toMatch(/NIS2 requires demonstrable/);
        expect(recs).toMatch(/Link governing policies to your NIS2 controls/);
        expect(recs).toMatch(/4 open issues/);
    });

    it('partial policy linkage (in [50,100)) → "attach policies to remaining controls" branch', async () => {
        // 2 of 3 in-scope controls have a linked policy → round(2/3*100)=67.
        mockDbHolder.db = buildDb({
            cycle: { id: 'c1', frameworkKey: 'NIS2' },
            framework: { id: 'fw-nis2' },
            requirements: [],
            mappedLinks: [{ requirementId: 'r1', controlId: 'k1' }],
            controlsWithEvidence: [
                { id: 'k1', code: 'C1', name: 'n', evidenceControlLinks: [{ evidenceId: 'e' }], _count: { policyLinks: 1 } },
                { id: 'k2', code: 'C2', name: 'n', evidenceControlLinks: [{ evidenceId: 'e' }], _count: { policyLinks: 2 } },
                { id: 'k3', code: 'C3', name: 'n', evidenceControlLinks: [{ evidenceId: 'e' }], _count: { policyLinks: 0 } },
            ],
            openTasks: [],
        });
        const r = await computeReadiness(ctx, 'c1');
        expect(r.breakdown.policies!.score).toBe(67);
        expect(r.recommendations.some((s) => /Attach policies to the remaining unlinked NIS2 controls/.test(s))).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────
// GENERIC fallback scoring (custom framework keys).
// ─────────────────────────────────────────────────────────────────
describe('computeGenericReadiness — custom framework path', () => {
    it('non-empty coverage/evidence/issues → computed score + recommendation', async () => {
        // coverage: 2 reqs, 1 mapped → 50. evidence: 2 mapped controls,
        // 1 with active evidence → 50. issues: taskCount 3 → 100-15=85.
        mockDbHolder.db = buildDb({
            cycle: { id: 'c1', frameworkKey: 'SOC2-CUSTOM' },
            framework: { id: 'fw-gen' },
            requirements: [{ id: 'r1', code: 'X', title: 't' }, { id: 'r2', code: 'Y', title: 't' }],
            mappedLinks: [{ requirementId: 'r1' }],
            genericControls: [{ id: 'k1' }, { id: 'k2' }],
            genericEvidence: [{ controlId: 'k1' }],
            taskCount: 3,
        });
        const r = await computeReadiness(ctx, 'c1');
        expect(r.frameworkKey).toBe('SOC2-CUSTOM');
        expect(r.breakdown.coverage.score).toBe(50);
        expect(r.breakdown.evidence.score).toBe(50);
        expect(r.breakdown.issues.score).toBe(85);
        expect(r.breakdown.issues.open).toBe(3);
        // round(50*.5 + 50*.35 + 85*.15) = round(25+17.5+12.75)=55
        expect(r.score).toBe(55);
        expect(r.recommendations[0]).toMatch(/generic 3-dimension scoring/);
    });

    it('no framework + no controls → all division guards take else; issues clamp at 0', async () => {
        // framework null → totalReqs 0, mappedControls empty → both
        // scores 0. taskCount 25 → 100-125 → clamped to 0.
        mockDbHolder.db = buildDb({
            cycle: { id: 'c1', frameworkKey: 'CUSTOM-EMPTY' },
            framework: null,
            genericControls: [],
            taskCount: 25,
        });
        const r = await computeReadiness(ctx, 'c1');
        expect(r.breakdown.coverage.score).toBe(0);
        expect(r.breakdown.coverage.total).toBe(0);
        expect(r.breakdown.evidence.score).toBe(0);
        expect(r.breakdown.evidence.total).toBe(0);
        expect(r.breakdown.issues.score).toBe(0);     // Math.max(0, …)
        expect(r.score).toBe(0);
    });

    it('evidence dedupes by controlId across join rows', async () => {
        // 2 mapped controls. The join returns two rows both for k1 →
        // withEvidence Set size = 1 → evidence 50. (EP-3: the join FK is
        // non-nullable, so a null-controlId row can't occur here — the
        // dedup is now the only branch this exercises.)
        mockDbHolder.db = buildDb({
            cycle: { id: 'c1', frameworkKey: 'CUSTOM-DEDUPE' },
            framework: { id: 'fw' },
            requirements: [{ id: 'r1', code: 'X', title: 't' }],
            mappedLinks: [{ requirementId: 'r1' }],
            genericControls: [{ id: 'k1' }, { id: 'k2' }],
            genericEvidence: [{ controlId: 'k1' }, { controlId: 'k1' }],
            taskCount: 0,
        });
        const r = await computeReadiness(ctx, 'c1');
        expect(r.breakdown.evidence.withEvidence).toBe(1);
        expect(r.breakdown.evidence.score).toBe(50);
    });
});

// ─────────────────────────────────────────────────────────────────
// loadEffectiveWeights — every accept / reject branch.
// ─────────────────────────────────────────────────────────────────
describe('loadEffectiveWeights override seam (via GENERIC)', () => {
    const baseGenericDb = () => ({
        cycle: { id: 'c1', frameworkKey: 'CUSTOM' },
        framework: null,
        genericControls: [],
        taskCount: 0,   // → all sub-scores: coverage 0, evidence 0, issues 100
    });

    it('valid override (sums to 1.0) is applied to the weighted score', async () => {
        // GENERIC defaults {coverage .5, evidence .35, issues .15}.
        // Override issues→1.0, others→0 still sums to 1.0. With
        // issuesScore=100 → final = 100.
        mockDbHolder.db = buildDb({
            ...baseGenericDb(),
            readinessWeightsJson: { GENERIC: { coverage: 0, evidence: 0, issues: 1 } },
        });
        const r = await computeReadiness(ctx, 'c1');
        expect(r.breakdown.issues.weight).toBe(1);
        expect(r.score).toBe(100);
    });

    it('override sum off-by-more-than-tolerance → defaults used', async () => {
        mockDbHolder.db = buildDb({
            ...baseGenericDb(),
            readinessWeightsJson: { GENERIC: { coverage: 0.1, evidence: 0.1, issues: 0.1 } },
        });
        const r = await computeReadiness(ctx, 'c1');
        expect(r.breakdown.issues.weight).toBe(0.15);    // default
    });

    it('override value out of [0,1] → defaults used', async () => {
        mockDbHolder.db = buildDb({
            ...baseGenericDb(),
            readinessWeightsJson: { GENERIC: { coverage: -0.5, evidence: 0.5, issues: 1.0 } },
        });
        const r = await computeReadiness(ctx, 'c1');
        expect(r.breakdown.coverage.weight).toBe(0.5);   // default
    });

    it('override value non-numeric → defaults used', async () => {
        mockDbHolder.db = buildDb({
            ...baseGenericDb(),
            readinessWeightsJson: { GENERIC: { coverage: 'lots', evidence: 0.5, issues: 0.5 } },
        });
        const r = await computeReadiness(ctx, 'c1');
        expect(r.breakdown.coverage.weight).toBe(0.5);   // default
    });

    it('override present but framework key candidate not an object → defaults', async () => {
        mockDbHolder.db = buildDb({
            ...baseGenericDb(),
            readinessWeightsJson: { GENERIC: 'not-an-object' },
        });
        const r = await computeReadiness(ctx, 'c1');
        expect(r.breakdown.coverage.weight).toBe(0.5);
    });

    it('override present but no candidate for this framework key → defaults', async () => {
        mockDbHolder.db = buildDb({
            ...baseGenericDb(),
            readinessWeightsJson: { ISO27001: { coverage: 1 } },   // wrong key
        });
        const r = await computeReadiness(ctx, 'c1');
        expect(r.breakdown.coverage.weight).toBe(0.5);
    });

    it('readinessWeightsJson is not an object → defaults', async () => {
        mockDbHolder.db = buildDb({
            ...baseGenericDb(),
            readinessWeightsJson: 'garbage',
        });
        const r = await computeReadiness(ctx, 'c1');
        expect(r.breakdown.coverage.weight).toBe(0.5);
    });

    it('tenant row missing readinessWeightsJson (null json) → defaults', async () => {
        mockDbHolder.db = buildDb({
            ...baseGenericDb(),
            readinessWeightsJson: null,
        });
        const r = await computeReadiness(ctx, 'c1');
        expect(r.breakdown.coverage.weight).toBe(0.5);
    });
});

// ─────────────────────────────────────────────────────────────────
// Snapshot persistence is best-effort — failure must not surface.
// ─────────────────────────────────────────────────────────────────
describe('readinessSnapshot create — best-effort branch', () => {
    it('swallows a snapshot write failure and still returns the result', async () => {
        mockDbHolder.db = buildDb({
            cycle: { id: 'c1', frameworkKey: 'ISO27001' },
            framework: null,
            controlsApplicable: [],
            controlsWithEvidence: [],
            snapshotThrows: true,
        });
        const r = await computeReadiness(ctx, 'c1');
        expect(r.frameworkKey).toBe('ISO27001');
        expect(r.score).toBeGreaterThanOrEqual(0);
    });
});

// ─────────────────────────────────────────────────────────────────
// computeReadiness gate + notFound.
// ─────────────────────────────────────────────────────────────────
describe('computeReadiness — gate + notFound', () => {
    it('throws notFound when the cycle does not exist', async () => {
        mockDbHolder.db = buildDb({ cycle: null });
        await expect(computeReadiness(ctx, 'missing')).rejects.toThrow(/not found/i);
    });

    it('calls assertCanViewPack before any DB work', async () => {
        mockDbHolder.db = buildDb({ cycle: null });
        await expect(computeReadiness(ctx, 'x')).rejects.toThrow();
        expect(assertCanViewPack as jest.Mock).toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────────────────────────
// getReadinessHistory — take clamp branches + cycleId spread branch.
// ─────────────────────────────────────────────────────────────────
describe('getReadinessHistory — clamp + filter branches', () => {
    function historyDb() {
        const findMany = jest.fn().mockResolvedValue([{ id: 's1', score: 50, gapCount: 1, computedAt: new Date(), auditCycleId: 'c1' }]);
        return { db: { readinessSnapshot: { findMany } }, findMany };
    }

    it('default take=30 when opts.take omitted; no cycleId filter', async () => {
        const { db, findMany } = historyDb();
        mockDbHolder.db = db;
        await getReadinessHistory(ctx, 'ISO27001');
        const args = findMany.mock.calls[0][0];
        expect(args.take).toBe(30);
        expect(args.where).not.toHaveProperty('auditCycleId');
    });

    it('take clamps to floor 1 for values below 1', async () => {
        const { db, findMany } = historyDb();
        mockDbHolder.db = db;
        await getReadinessHistory(ctx, 'ISO27001', { take: 0 });
        expect(findMany.mock.calls[0][0].take).toBe(1);
    });

    it('take clamps to ceiling 200 for values above 200', async () => {
        const { db, findMany } = historyDb();
        mockDbHolder.db = db;
        await getReadinessHistory(ctx, 'ISO27001', { take: 9999 });
        expect(findMany.mock.calls[0][0].take).toBe(200);
    });

    it('cycleId option adds the auditCycleId filter branch', async () => {
        const { db, findMany } = historyDb();
        mockDbHolder.db = db;
        await getReadinessHistory(ctx, 'NIS2', { take: 10, cycleId: 'c9' });
        const args = findMany.mock.calls[0][0];
        expect(args.take).toBe(10);
        expect(args.where.auditCycleId).toBe('c9');
    });
});

// ─────────────────────────────────────────────────────────────────
// addReadinessToPack — dynamic import + delegation.
// ─────────────────────────────────────────────────────────────────
describe('addReadinessToPack', () => {
    it('computes readiness and forwards a READINESS_REPORT pack item', async () => {
        mockDbHolder.db = buildDb({
            cycle: { id: 'c1', frameworkKey: 'ISO27001' },
            framework: null,
            controlsApplicable: [],
            controlsWithEvidence: [],
        });
        const { addAuditPackItems } = await import('@/app-layer/usecases/audit-readiness/packs');
        const res = await addReadinessToPack(ctx, 'pack1', 'c1');
        expect(res).toEqual({ ok: true });
        expect(addAuditPackItems as jest.Mock).toHaveBeenCalledWith(
            ctx,
            'pack1',
            expect.arrayContaining([
                expect.objectContaining({ entityType: 'READINESS_REPORT', entityId: 'c1', sortOrder: 999 }),
            ]),
        );
    });
});
