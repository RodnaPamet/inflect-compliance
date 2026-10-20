/**
 * Step 4d (#3681) — the reliance pack's rules, pure.
 *
 * What a pack over one audit cycle says per control and once for the pack, and
 * what it refuses to say. The integration suite drives the same planner through
 * the database; these cases pin the rules the planner holds on its own.
 */
import {
    RELIANCE_WORKPAPER_CAP,
    periodLabelsWithin,
    planReliancePack,
    relianceSummaryEntityId,
    type RelianceControl,
    type RelianceControlSnapshot,
    type RelianceInput,
    type RelianceReview,
    type RelianceSummarySnapshot,
    type RelianceWorkpaper,
} from '@/lib/agentic/audit-reliance';
import { METRIC_DEFINITIONS } from '@/lib/agentic/report-definitions';

const HEX = 'a'.repeat(64);

function control(id: string, code: string): RelianceControl {
    return { id, code, annexId: null, name: `Control ${code}`, status: 'IMPLEMENTED', mappedRequirementCodes: ['A.9.4'] };
}

function review(outcome: RelianceReview['outcome'], extra: Partial<RelianceReview> = {}): RelianceReview {
    return {
        outcome,
        unassignedReason: null,
        dissentCodes: outcome === 'DISSENTED' ? ['SAMPLE_NOT_REPRODUCED'] : [],
        samplePercent: 100,
        samplingEpoch: 'audit-workpaper-review@2026-07',
        seedFingerprint: HEX,
        sampledAt: new Date('2026-08-03T09:40:00Z'),
        reviewedAt: outcome === 'PENDING' ? null : new Date('2026-08-05T10:00:00Z'),
        ...extra,
    };
}

let seq = 0;
function workpaper(extra: Partial<RelianceWorkpaper> = {}): RelianceWorkpaper {
    seq += 1;
    return {
        id: `wp_${String(seq).padStart(3, '0')}`,
        procedureId: 'iam.leaver_timeliness',
        catalogueVersion: 1,
        periodLabel: '2026-07',
        populationCount: 4,
        populationDigest: HEX,
        sampleSize: 2,
        exceptionCount: 0,
        conclusion: 'PASS',
        conclusionBasis: 'ALL_SAMPLED_UNITS_PASSED',
        createdAt: new Date('2026-08-02T06:17:00Z'),
        runControlId: 'c_leaver',
        review: review('CONCURRED'),
        ...extra,
    };
}

function input(extra: Partial<RelianceInput> = {}): RelianceInput {
    return {
        cycle: {
            id: 'cyc_1',
            name: 'ISO 42001 2026',
            frameworkKey: 'ISO42001',
            frameworkVersion: '2023',
            periodStartAt: new Date('2026-01-01T00:00:00Z'),
            periodEndAt: new Date('2026-12-31T00:00:00Z'),
        },
        plans: [
            { procedureId: 'iam.leaver_timeliness', controlId: 'c_leaver' },
            { procedureId: 'agent.authority_conformance', controlId: 'c_agent' },
        ],
        controls: new Map([
            ['c_leaver', control('c_leaver', 'A.5.16')],
            ['c_agent', control('c_agent', 'A.9.4')],
        ]),
        workpapers: [workpaper()],
        ...extra,
    };
}

function planOf(i: RelianceInput) {
    const result = planReliancePack(i);
    if (result.kind !== 'PLAN') throw new Error(`expected a plan, got ${result.reason}`);
    const byId = new Map(result.items.map((it) => [it.entityId, it] as const));
    const controlSnap = (id: string) => byId.get(id)!.snapshot as RelianceControlSnapshot;
    const summary = byId.get(relianceSummaryEntityId(i.cycle.id))!.snapshot as RelianceSummarySnapshot;
    return { result, controlSnap, summary };
}

describe('periods: only months and quarters wholly inside the cycle', () => {
    it('a calendar year holds twelve months and four quarters, the end day included', () => {
        const labels = periodLabelsWithin(new Date('2026-01-01T00:00:00Z'), new Date('2026-12-31T00:00:00Z'));
        expect(labels).toHaveLength(16);
        expect(labels).toContain('2026-12');
        expect(labels).toContain('2026-Q4');
    });

    it('a month or quarter partly outside the cycle is out', () => {
        const labels = periodLabelsWithin(new Date('2026-02-15T00:00:00Z'), new Date('2026-06-30T00:00:00Z'));
        expect(labels).not.toContain('2026-02');
        expect(labels).not.toContain('2026-Q1');
        expect(labels).toEqual(expect.arrayContaining(['2026-03', '2026-04', '2026-05', '2026-06', '2026-Q2']));
    });

    it('an end before the start holds nothing', () => {
        expect(periodLabelsWithin(new Date('2026-06-01T00:00:00Z'), new Date('2026-05-01T00:00:00Z'))).toEqual([]);
    });
});

describe('every control in scope has an entry with its workpapers, sampling records and the agreement rate', () => {
    it('lists each workpaper with its sampling record, and the rate over concluded reviews only', () => {
        const papers = [
            workpaper({ review: review('CONCURRED') }),
            workpaper({ review: review('DISSENTED') }),
            workpaper({ review: review('PENDING') }),
            workpaper({ review: review('PENDING', { unassignedReason: 'NO_THIRD_LINE_MEMBER' }) }),
            workpaper({ review: review('INDETERMINATE') }),
            workpaper({ review: null }),
        ];
        const { controlSnap, summary } = planOf(input({ workpapers: papers }));
        const snap = controlSnap('c_leaver');

        expect(snap.reliance.workpapers.map((w) => w.id)).toEqual(papers.map((p) => p.id));
        expect(snap.reliance.workpapers.map((w) => w.sampling.state)).toEqual([
            'CONCURRED',
            'DISSENTED',
            'AWAITING',
            'UNASSIGNED',
            'INDETERMINATE',
            'NOT_DRAWN',
        ]);
        expect(snap.reliance.workpapers[1].sampling.dissentCodes).toEqual(['SAMPLE_NOT_REPRODUCED']);
        expect(snap.reliance.workpapers[3].sampling.unassignedReason).toBe('NO_THIRD_LINE_MEMBER');

        // The 3d rule: CONCURRED / (CONCURRED + DISSENTED). Awaiting,
        // unassigned, indeterminate and not drawn are in neither side.
        expect(snap.reliance.sampling).toMatchObject({
            workpapers: 6,
            notDrawn: 1,
            drawn: 5,
            concluded: 2,
            concurred: 1,
            dissented: 1,
            agreementRate: 0.5,
            disagreementRate: 0.5,
        });
        expect(summary.agreement.agreementRate).toBe(0.5);
        expect(snap.reliance.limits).toEqual([
            'WORKPAPERS_NOT_DRAWN',
            'REVIEWS_AWAITING',
            'REVIEWS_UNASSIGNED',
            'REVIEWS_INDETERMINATE',
            'DISSENT_RECORDED',
        ]);
    });

    it('carries the control’s own fields, so the existing pack views read the entry', () => {
        const { controlSnap } = planOf(input());
        const snap = controlSnap('c_leaver');
        expect(snap).toMatchObject({ code: 'A.5.16', name: 'Control A.5.16', status: 'IMPLEMENTED' });
        expect(snap.mappedRequirements).toEqual([{ code: 'A.9.4' }]);
        expect(snap.reliance.procedures.map((p) => p.id)).toEqual(['iam.leaver_timeliness']);
    });

    it('a control in scope with no workpaper in the period is listed, never left out', () => {
        const { result, controlSnap } = planOf(input());
        expect(result.items.filter((i) => i.entityType === 'CONTROL').map((i) => i.entityId).sort()).toEqual([
            'c_agent',
            'c_leaver',
        ]);
        const agent = controlSnap('c_agent');
        expect(agent.reliance.workpapers).toEqual([]);
        expect(agent.reliance.limits).toEqual(['NO_WORKPAPERS_IN_PERIOD', 'NO_CONCLUDED_REVIEW']);
        expect(agent.reliance.sampling.agreementRate).toBeNull();
    });

    it('a workpaper outside the cycle’s period is not in the pack', () => {
        const outside = workpaper({ periodLabel: '2025-12' });
        const inside = workpaper();
        const { controlSnap } = planOf(input({ workpapers: [outside, inside] }));
        expect(controlSnap('c_leaver').reliance.workpapers.map((w) => w.id)).toEqual([inside.id]);
    });

    it('a failed or inconclusive procedure is stated as a limit, not hidden', () => {
        const { controlSnap } = planOf(
            input({
                workpapers: [
                    workpaper({ conclusion: 'FAIL', exceptionCount: 1, conclusionBasis: 'EXCEPTION_FOUND' }),
                    workpaper({ conclusion: 'INCONCLUSIVE', conclusionBasis: 'PARAMETER_UNSET', sampleSize: null }),
                ],
            }),
        );
        expect(controlSnap('c_leaver').reliance.limits).toEqual(
            expect.arrayContaining(['CONCLUSION_FAIL', 'CONCLUSION_INCONCLUSIVE']),
        );
    });
});

describe('no concluded review is no rate, never 100%', () => {
    it('a pack whose reviews are all awaiting has no rate and says so', () => {
        const { controlSnap, summary } = planOf(input({ workpapers: [workpaper({ review: review('PENDING') })] }));
        expect(controlSnap('c_leaver').reliance.sampling.agreementRate).toBeNull();
        expect(summary.agreement.agreementRate).toBeNull();
        expect(summary.agreement.disagreementRate).toBeNull();
        expect(summary.limits).toContain('NO_CONCLUDED_REVIEW');
    });
});

describe('the summary states the scope, the catalogue’s standing and the definition', () => {
    it('cites the reliance rate definitions verbatim, each stating what it excludes', () => {
        const { summary } = planOf(input());
        expect(summary.definitions).toEqual([
            METRIC_DEFINITIONS['assurance.reliance_reperformance_agreement_rate'],
            METRIC_DEFINITIONS['assurance.reliance_reperformance_disagreement_rate'],
        ]);
        expect(summary.definitions[0].excludes.join(' ')).toMatch(/not drawn/);
    });

    it('names every library v1 procedure, the controls it is on, and the procedures on none', () => {
        const { summary } = planOf(input());
        expect(summary.scope.map((s) => s.procedureId)).toEqual([
            'iam.leaver_timeliness',
            'iam.recertification_completeness',
            'iam.time_bounded_access_expiry',
            'iam.privileged_access',
            'agent.authority_conformance',
        ]);
        expect(summary.scope.find((s) => s.procedureId === 'agent.authority_conformance')!.controlIds).toEqual(['c_agent']);
        expect(summary.proceduresWithoutControl).toEqual([
            'iam.recertification_completeness',
            'iam.time_bounded_access_expiry',
            'iam.privileged_access',
        ]);
        expect(summary.limits).toContain('PROCEDURE_WITHOUT_CONTROL');
    });

    it('states that the catalogue is not yet approved by internal audit nor agreed by the provider', () => {
        const { summary } = planOf(input());
        expect(summary.catalogue.status.internalAuditApproval).toBe('OPEN');
        expect(summary.limits).toEqual(
            expect.arrayContaining(['CATALOGUE_NOT_APPROVED_BY_INTERNAL_AUDIT', 'CATALOGUE_NOT_AGREED_BY_PROVIDER']),
        );
        expect(summary.catalogue.versions).toEqual([1]);
        expect(summary.period.labels).toHaveLength(16);
    });
});

describe('refusals: zero is never reliance, and nothing is dropped', () => {
    const refusal = (i: RelianceInput) => {
        const r = planReliancePack(i);
        return r.kind === 'REFUSED' ? r : null;
    };

    it('refuses a cycle with no period', () => {
        const base = input();
        expect(refusal({ ...base, cycle: { ...base.cycle, periodStartAt: null } })?.reason).toBe('CYCLE_PERIOD_REQUIRED');
    });

    it('refuses a period holding no whole month or quarter', () => {
        const base = input();
        const cycle = {
            ...base.cycle,
            periodStartAt: new Date('2026-03-10T00:00:00Z'),
            periodEndAt: new Date('2026-03-20T00:00:00Z'),
        };
        expect(refusal({ ...base, cycle })?.reason).toBe('NO_PERIOD_IN_CYCLE');
    });

    it('refuses a period with no workpaper, even with every control in scope', () => {
        expect(refusal(input({ workpapers: [] }))?.reason).toBe('NO_WORKPAPERS_IN_PERIOD');
        expect(refusal(input({ workpapers: [workpaper({ periodLabel: '2025-11' })] }))?.reason).toBe(
            'NO_WORKPAPERS_IN_PERIOD',
        );
    });

    it('refuses when no procedure is on a control and none ran', () => {
        expect(refusal(input({ plans: [], workpapers: [] }))?.reason).toBe('NO_CONTROLS_IN_SCOPE');
    });

    it('refuses one past the cap rather than truncating', () => {
        const many = Array.from({ length: RELIANCE_WORKPAPER_CAP + 1 }, () => workpaper());
        expect(refusal(input({ workpapers: many }))?.reason).toBe('TOO_MANY_WORKPAPERS');
        const exactly = many.slice(0, RELIANCE_WORKPAPER_CAP);
        expect(planReliancePack(input({ workpapers: exactly })).kind).toBe('PLAN');
    });

    it('a workpaper whose run is gone is attributed to its procedure’s one live plan, and says so', () => {
        const orphan = workpaper({ runControlId: null });
        const { controlSnap } = planOf(input({ workpapers: [orphan] }));
        const snap = controlSnap('c_leaver');
        expect(snap.reliance.workpapers[0].attribution).toBe('CURRENT_PLAN');
        expect(snap.reliance.limits).toContain('ATTRIBUTED_BY_CURRENT_PLAN');
    });

    it('refuses the pack when a workpaper cannot be attributed, naming it', () => {
        const orphan = workpaper({ runControlId: null, procedureId: 'iam.privileged_access' });
        const r = refusal(input({ workpapers: [workpaper(), orphan] }));
        expect(r?.reason).toBe('WORKPAPER_CONTROL_UNRESOLVED');
        expect(r?.detail).toEqual([orphan.id]);
    });

    it('a procedure on two live plans does not guess between them', () => {
        const base = input();
        const orphan = workpaper({ runControlId: null });
        const plans = [...base.plans, { procedureId: 'iam.leaver_timeliness' as const, controlId: 'c_agent' }];
        expect(refusal({ ...base, plans, workpapers: [orphan] })?.reason).toBe('WORKPAPER_CONTROL_UNRESOLVED');
    });
});
