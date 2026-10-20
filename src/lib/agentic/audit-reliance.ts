/**
 * Step 4d (#3681) — THE RELIANCE PACK'S RULES.
 *
 * An external auditor relies on the auditor agent's workpapers only on a basis:
 * internal audit's re-performance of a sample of them (3d). This module decides,
 * from rows the usecase has already read, what a reliance pack for one audit
 * cycle says — per control in scope, and once for the pack — and what it
 * refuses to say.
 *
 * Pure: no Prisma, no clock. `usecases/agent-audit-reliance.ts` reads the rows
 * and writes the pack; everything decided about them is decided here, where it
 * is unit-tested.
 *
 * Four rules, each one an edit away from being undone:
 *
 *   1. ZERO IS NEVER RELIANCE. A cycle with no workpaper in its period is
 *      refused at assembly (`NO_WORKPAPERS_IN_PERIOD`), and a control in scope
 *      with none is listed with that limit rather than left out. A pack that
 *      omitted the control would read as "nothing to say" about it.
 *   2. NOTHING IS DROPPED. A workpaper in scope whose control cannot be
 *      resolved refuses the whole pack (`WORKPAPER_CONTROL_UNRESOLVED`); one past
 *      the read cap refuses it too (`TOO_MANY_WORKPAPERS`).
 *   3. THE RATE IS THE 3D RULE. `workpaperReviewRate` is the only arithmetic: a
 *      drawn but unreviewed workpaper counts toward nothing, and no concluded
 *      review is no rate.
 *   4. LIMITS ARE A SET, NOT A VERDICT. The pack states facts and every limit
 *      that applies; whether to rely is the external auditor's conclusion.
 */
import {
    AUDIT_PROCEDURE_LIBRARY_V1,
    LIBRARY_V1_PROCEDURE_IDS,
    LIBRARY_V1_STATUS,
    LIBRARY_V1_STATUS_SENTENCE,
    isLibraryV1Procedure,
    type LibraryV1ProcedureId,
} from './audit-procedure-library';
import { PERIOD_LABEL, periodBounds } from './audit-workpaper';
import { METRIC_DEFINITIONS, type MetricDefinition } from './report-definitions';
import { workpaperReviewRate, type WorkpaperReviewRate } from './workpaper-review-sampling';

/** Bumped when a snapshot's shape changes, so a reader can tell two packs apart. */
export const RELIANCE_SNAPSHOT_VERSION = 1;
export const RELIANCE_CONTROL_SNAPSHOT_TYPE = 'AGENT_AUDIT_RELIANCE_CONTROL';
export const RELIANCE_SUMMARY_SNAPSHOT_TYPE = 'AGENT_AUDIT_RELIANCE_SUMMARY';

/** The most workpapers one pack holds. One more is read, so truncation is a fact, not a guess. */
export const RELIANCE_WORKPAPER_CAP = 2000;

/** `AuditPackItem.entityId` of the pack-level summary item (entity type FRAMEWORK_COVERAGE). */
export function relianceSummaryEntityId(auditCycleId: string): string {
    return `agent-audit-reliance:${auditCycleId}`;
}

/** The metric definitions the pack cites, carried into the summary verbatim. */
export const RELIANCE_METRIC_IDS = [
    'assurance.reliance_reperformance_agreement_rate',
    'assurance.reliance_reperformance_disagreement_rate',
] as const;

// ─── Refusals ───────────────────────────────────────────────────────────────

export const RELIANCE_REFUSALS = [
    /** The cycle names no period, so no workpaper can be said to fall inside it. */
    'CYCLE_PERIOD_REQUIRED',
    /** The cycle's period contains no whole month or quarter. */
    'NO_PERIOD_IN_CYCLE',
    /** No library v1 procedure is configured on a control, and none ran. */
    'NO_CONTROLS_IN_SCOPE',
    /** No workpaper of a library v1 procedure falls inside the period. */
    'NO_WORKPAPERS_IN_PERIOD',
    /** More workpapers than one pack holds. */
    'TOO_MANY_WORKPAPERS',
    /** A workpaper in scope whose control cannot be resolved. */
    'WORKPAPER_CONTROL_UNRESOLVED',
] as const;
export type RelianceRefusal = (typeof RELIANCE_REFUSALS)[number];

// ─── Limits ─────────────────────────────────────────────────────────────────

/** What a control's entry cannot support. Every one that applies is listed. */
export const RELIANCE_CONTROL_LIMITS = [
    'NO_WORKPAPERS_IN_PERIOD',
    'NO_CONCLUDED_REVIEW',
    'WORKPAPERS_NOT_DRAWN',
    'REVIEWS_AWAITING',
    'REVIEWS_UNASSIGNED',
    'REVIEWS_INDETERMINATE',
    'DISSENT_RECORDED',
    'CONCLUSION_FAIL',
    'CONCLUSION_INCONCLUSIVE',
    'ATTRIBUTED_BY_CURRENT_PLAN',
] as const;
export type RelianceControlLimit = (typeof RELIANCE_CONTROL_LIMITS)[number];

/** What the pack as a whole cannot support. */
export const RELIANCE_PACK_LIMITS = [
    'CATALOGUE_NOT_APPROVED_BY_INTERNAL_AUDIT',
    'CATALOGUE_NOT_AGREED_BY_PROVIDER',
    'PROCEDURE_WITHOUT_CONTROL',
    'NO_CONCLUDED_REVIEW',
] as const;
export type ReliancePackLimit = (typeof RELIANCE_PACK_LIMITS)[number];

// ─── Inputs ─────────────────────────────────────────────────────────────────

export interface RelianceCycle {
    readonly id: string;
    readonly name: string;
    readonly frameworkKey: string;
    readonly frameworkVersion: string;
    readonly periodStartAt: Date | null;
    readonly periodEndAt: Date | null;
}

export interface RelianceControl {
    readonly id: string;
    readonly code: string | null;
    readonly annexId: string | null;
    readonly name: string;
    readonly status: string;
    /** The framework requirement codes the control is mapped to. */
    readonly mappedRequirementCodes: readonly string[];
}

/** A live control-test plan carrying a library v1 procedure. */
export interface ReliancePlan {
    readonly procedureId: LibraryV1ProcedureId;
    readonly controlId: string;
}

export interface RelianceReview {
    readonly outcome: 'PENDING' | 'CONCURRED' | 'DISSENTED' | 'INDETERMINATE';
    readonly unassignedReason: string | null;
    readonly dissentCodes: readonly string[];
    readonly samplePercent: number;
    readonly samplingEpoch: string;
    readonly seedFingerprint: string;
    readonly sampledAt: Date;
    readonly reviewedAt: Date | null;
}

export interface RelianceWorkpaper {
    readonly id: string;
    readonly procedureId: string;
    readonly catalogueVersion: number;
    readonly periodLabel: string;
    readonly populationCount: number;
    readonly populationDigest: string;
    readonly sampleSize: number | null;
    readonly exceptionCount: number;
    readonly conclusion: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
    readonly conclusionBasis: string;
    readonly createdAt: Date;
    /** The control its test run was on, or null when the run is gone. */
    readonly runControlId: string | null;
    /** Internal audit's review of it, when it was drawn. */
    readonly review: RelianceReview | null;
}

export interface RelianceInput {
    readonly cycle: RelianceCycle;
    readonly plans: readonly ReliancePlan[];
    readonly controls: ReadonlyMap<string, RelianceControl>;
    /** Read with `take: RELIANCE_WORKPAPER_CAP + 1`. */
    readonly workpapers: readonly RelianceWorkpaper[];
}

// ─── Outputs ────────────────────────────────────────────────────────────────

export type WorkpaperSamplingState =
    | 'NOT_DRAWN'
    | 'UNASSIGNED'
    | 'AWAITING'
    | 'CONCURRED'
    | 'DISSENTED'
    | 'INDETERMINATE';

export interface RelianceWorkpaperEntry {
    readonly id: string;
    readonly procedureId: string;
    readonly periodLabel: string;
    readonly catalogueVersion: number;
    readonly populationCount: number;
    readonly populationDigest: string;
    readonly sampleSize: number | null;
    readonly exceptionCount: number;
    readonly conclusion: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
    readonly conclusionBasis: string;
    readonly attribution: 'RUN' | 'CURRENT_PLAN';
    readonly sampling: {
        readonly state: WorkpaperSamplingState;
        readonly unassignedReason: string | null;
        readonly dissentCodes: readonly string[];
        readonly samplePercent: number | null;
        readonly samplingEpoch: string | null;
        readonly seedFingerprint: string | null;
        readonly sampledAt: string | null;
        readonly reviewedAt: string | null;
    };
}

export interface RelianceControlSnapshot {
    readonly type: typeof RELIANCE_CONTROL_SNAPSHOT_TYPE;
    readonly schemaVersion: number;
    /** The fields every CONTROL snapshot carries, so the existing pack views read it. */
    readonly code: string | null;
    readonly name: string;
    readonly title: string;
    readonly status: string;
    readonly mappedRequirements: readonly { readonly code: string }[];
    readonly reliance: {
        readonly procedures: readonly {
            readonly id: string;
            readonly title: string;
            readonly controlIdentifiers: readonly string[];
        }[];
        readonly periodLabels: readonly string[];
        readonly workpapers: readonly RelianceWorkpaperEntry[];
        readonly sampling: WorkpaperReviewRate & { readonly workpapers: number; readonly notDrawn: number };
        readonly limits: readonly RelianceControlLimit[];
    };
}

export interface RelianceSummarySnapshot {
    readonly type: typeof RELIANCE_SUMMARY_SNAPSHOT_TYPE;
    readonly schemaVersion: number;
    readonly title: string;
    readonly framework: { readonly key: string; readonly version: string };
    readonly cycle: { readonly name: string };
    readonly period: { readonly start: string; readonly end: string; readonly labels: readonly string[] };
    readonly scope: readonly {
        readonly procedureId: string;
        readonly title: string;
        readonly controlIdentifiers: readonly string[];
        readonly controlIds: readonly string[];
    }[];
    readonly proceduresWithoutControl: readonly string[];
    readonly catalogue: {
        readonly versions: readonly number[];
        readonly status: typeof LIBRARY_V1_STATUS;
        readonly statement: string;
    };
    readonly agreement: WorkpaperReviewRate & { readonly workpapers: number; readonly notDrawn: number };
    readonly definitions: readonly MetricDefinition[];
    readonly limits: readonly ReliancePackLimit[];
}

export interface ReliancePlanItem {
    readonly entityType: 'CONTROL' | 'FRAMEWORK_COVERAGE';
    readonly entityId: string;
    readonly snapshot: RelianceControlSnapshot | RelianceSummarySnapshot;
}

export type ReliancePlanResult =
    | {
          readonly kind: 'PLAN';
          readonly items: readonly ReliancePlanItem[];
          readonly summary: RelianceSummarySnapshot;
      }
    | { readonly kind: 'REFUSED'; readonly reason: RelianceRefusal; readonly detail: readonly string[] };

// ─── Periods ────────────────────────────────────────────────────────────────

/** Midnight UTC of the day `d` falls on. */
function utcDay(d: Date): number {
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Every month and quarter label lying WHOLLY inside the cycle's period, both
 * ends taken as whole UTC days (an end of `2026-12-31` includes December). A
 * period partly outside the cycle is out: reliance for the cycle cannot rest
 * on work that also covers time the cycle does not.
 */
export function periodLabelsWithin(start: Date, end: Date): string[] {
    const first = utcDay(start);
    const lastExclusive = utcDay(end) + 86_400_000;
    if (lastExclusive <= first) return [];
    const labels: string[] = [];
    const fromYear = new Date(first).getUTCFullYear();
    const toYear = new Date(lastExclusive).getUTCFullYear();
    for (let y = fromYear; y <= toYear; y++) {
        for (let m = 1; m <= 12; m++) labels.push(`${y}-${String(m).padStart(2, '0')}`);
        for (let q = 1; q <= 4; q++) labels.push(`${y}-Q${q}`);
    }
    return labels.filter((label) => {
        const b = periodBounds(label);
        return b.start.getTime() >= first && b.end.getTime() <= lastExclusive;
    });
}

// ─── The plan ───────────────────────────────────────────────────────────────

function samplingState(review: RelianceReview | null): WorkpaperSamplingState {
    if (!review) return 'NOT_DRAWN';
    if (review.outcome === 'PENDING') return review.unassignedReason ? 'UNASSIGNED' : 'AWAITING';
    return review.outcome;
}

function rateOf(entries: readonly RelianceWorkpaperEntry[]) {
    const n = (s: WorkpaperSamplingState) => entries.filter((e) => e.sampling.state === s).length;
    const notDrawn = n('NOT_DRAWN');
    return {
        workpapers: entries.length,
        notDrawn,
        ...workpaperReviewRate({
            drawn: entries.length - notDrawn,
            unassigned: n('UNASSIGNED'),
            awaiting: n('AWAITING'),
            concurred: n('CONCURRED'),
            dissented: n('DISSENTED'),
            indeterminate: n('INDETERMINATE'),
        }),
    };
}

function controlLimits(entries: readonly RelianceWorkpaperEntry[]): RelianceControlLimit[] {
    if (entries.length === 0) return ['NO_WORKPAPERS_IN_PERIOD', 'NO_CONCLUDED_REVIEW'];
    const r = rateOf(entries);
    const limits: RelianceControlLimit[] = [];
    if (r.concluded === 0) limits.push('NO_CONCLUDED_REVIEW');
    if (r.notDrawn > 0) limits.push('WORKPAPERS_NOT_DRAWN');
    if (r.awaiting > 0) limits.push('REVIEWS_AWAITING');
    if (r.unassigned > 0) limits.push('REVIEWS_UNASSIGNED');
    if (r.indeterminate > 0) limits.push('REVIEWS_INDETERMINATE');
    if (r.dissented > 0) limits.push('DISSENT_RECORDED');
    if (entries.some((e) => e.conclusion === 'FAIL')) limits.push('CONCLUSION_FAIL');
    if (entries.some((e) => e.conclusion === 'INCONCLUSIVE')) limits.push('CONCLUSION_INCONCLUSIVE');
    if (entries.some((e) => e.attribution === 'CURRENT_PLAN')) limits.push('ATTRIBUTED_BY_CURRENT_PLAN');
    return limits;
}

function procedureView(id: LibraryV1ProcedureId) {
    const def = AUDIT_PROCEDURE_LIBRARY_V1[id];
    return { id, title: def.title, controlIdentifiers: [...def.controls] };
}

/**
 * Decide the pack. The caller has read the cycle, the live library v1 plans,
 * the workpapers of library v1 procedures whose period is inside the cycle
 * (one past the cap), each one's review, and every control either names.
 */
export function planReliancePack(input: RelianceInput): ReliancePlanResult {
    const { cycle } = input;
    if (!cycle.periodStartAt || !cycle.periodEndAt) {
        return { kind: 'REFUSED', reason: 'CYCLE_PERIOD_REQUIRED', detail: [] };
    }
    const labels = periodLabelsWithin(cycle.periodStartAt, cycle.periodEndAt);
    if (labels.length === 0) return { kind: 'REFUSED', reason: 'NO_PERIOD_IN_CYCLE', detail: [] };
    const inPeriod = new Set(labels);

    if (input.workpapers.length > RELIANCE_WORKPAPER_CAP) {
        return { kind: 'REFUSED', reason: 'TOO_MANY_WORKPAPERS', detail: [String(RELIANCE_WORKPAPER_CAP)] };
    }

    // Which control each procedure's live plan is on. A procedure on two plans
    // has two controls: both are in scope.
    const planControls = new Map<LibraryV1ProcedureId, Set<string>>();
    for (const p of input.plans) {
        if (!input.controls.has(p.controlId)) continue;
        const set = planControls.get(p.procedureId) ?? new Set<string>();
        set.add(p.controlId);
        planControls.set(p.procedureId, set);
    }

    // Attribute every workpaper to a control: its run's, else the one control
    // its procedure's live plan is on. Anything else refuses the pack.
    const papers = input.workpapers.filter(
        (w) => isLibraryV1Procedure(w.procedureId) && PERIOD_LABEL.test(w.periodLabel) && inPeriod.has(w.periodLabel),
    );
    const unresolved: string[] = [];
    const byControl = new Map<string, RelianceWorkpaperEntry[]>();
    const procByControl = new Map<string, Set<LibraryV1ProcedureId>>();
    for (const w of papers) {
        const procedureId = w.procedureId as LibraryV1ProcedureId;
        let controlId: string | null = null;
        let attribution: 'RUN' | 'CURRENT_PLAN' = 'RUN';
        if (w.runControlId && input.controls.has(w.runControlId)) {
            controlId = w.runControlId;
        } else {
            const planned = planControls.get(procedureId);
            if (planned && planned.size === 1) {
                controlId = [...planned][0];
                attribution = 'CURRENT_PLAN';
            }
        }
        if (!controlId) {
            unresolved.push(w.id);
            continue;
        }
        const entry: RelianceWorkpaperEntry = {
            id: w.id,
            procedureId: w.procedureId,
            periodLabel: w.periodLabel,
            catalogueVersion: w.catalogueVersion,
            populationCount: w.populationCount,
            populationDigest: w.populationDigest,
            sampleSize: w.sampleSize,
            exceptionCount: w.exceptionCount,
            conclusion: w.conclusion,
            conclusionBasis: w.conclusionBasis,
            attribution,
            sampling: {
                state: samplingState(w.review),
                unassignedReason: w.review?.unassignedReason ?? null,
                dissentCodes: [...(w.review?.dissentCodes ?? [])],
                samplePercent: w.review?.samplePercent ?? null,
                samplingEpoch: w.review?.samplingEpoch ?? null,
                seedFingerprint: w.review?.seedFingerprint ?? null,
                sampledAt: w.review?.sampledAt.toISOString() ?? null,
                reviewedAt: w.review?.reviewedAt?.toISOString() ?? null,
            },
        };
        const list = byControl.get(controlId) ?? [];
        list.push(entry);
        byControl.set(controlId, list);
        const procs = procByControl.get(controlId) ?? new Set<LibraryV1ProcedureId>();
        procs.add(procedureId);
        procByControl.set(controlId, procs);
    }
    if (unresolved.length > 0) {
        return { kind: 'REFUSED', reason: 'WORKPAPER_CONTROL_UNRESOLVED', detail: unresolved.sort() };
    }

    // Controls in scope: every control a live plan puts a procedure on, and
    // every control a workpaper in the period resolved to.
    for (const [procedureId, set] of planControls) {
        for (const controlId of set) {
            const procs = procByControl.get(controlId) ?? new Set<LibraryV1ProcedureId>();
            procs.add(procedureId);
            procByControl.set(controlId, procs);
        }
    }
    if (procByControl.size === 0) return { kind: 'REFUSED', reason: 'NO_CONTROLS_IN_SCOPE', detail: [] };
    if (papers.length === 0) return { kind: 'REFUSED', reason: 'NO_WORKPAPERS_IN_PERIOD', detail: [...labels] };

    const byWorkpaperOrder = (a: RelianceWorkpaperEntry, b: RelianceWorkpaperEntry) =>
        a.procedureId.localeCompare(b.procedureId) || a.periodLabel.localeCompare(b.periodLabel) || a.id.localeCompare(b.id);

    const controlIds = [...procByControl.keys()].sort((a, b) => {
        const ca = input.controls.get(a)!;
        const cb = input.controls.get(b)!;
        return (ca.code ?? ca.annexId ?? ca.name).localeCompare(cb.code ?? cb.annexId ?? cb.name) || a.localeCompare(b);
    });

    const items: ReliancePlanItem[] = controlIds.map((controlId) => {
        const control = input.controls.get(controlId)!;
        const entries = (byControl.get(controlId) ?? []).sort(byWorkpaperOrder);
        const procedures = [...(procByControl.get(controlId) ?? [])]
            .sort((a, b) => LIBRARY_V1_PROCEDURE_IDS.indexOf(a) - LIBRARY_V1_PROCEDURE_IDS.indexOf(b))
            .map(procedureView);
        const snapshot: RelianceControlSnapshot = {
            type: RELIANCE_CONTROL_SNAPSHOT_TYPE,
            schemaVersion: RELIANCE_SNAPSHOT_VERSION,
            code: control.code ?? control.annexId,
            name: control.name,
            title: control.name,
            status: control.status,
            mappedRequirements: [...control.mappedRequirementCodes].sort().map((code) => ({ code })),
            reliance: {
                procedures,
                periodLabels: [...new Set(entries.map((e) => e.periodLabel))].sort(),
                workpapers: entries,
                sampling: rateOf(entries),
                limits: controlLimits(entries),
            },
        };
        return { entityType: 'CONTROL', entityId: controlId, snapshot };
    });

    const allEntries = controlIds.flatMap((id) => byControl.get(id) ?? []);
    const agreement = rateOf(allEntries);
    const proceduresWithoutControl = LIBRARY_V1_PROCEDURE_IDS.filter(
        (p) => ![...procByControl.values()].some((procs) => procs.has(p)),
    );
    const packLimits: ReliancePackLimit[] = [];
    // Widened to string on purpose: the limit holds for every value but the
    // one that lifts it, so a status the catalogue adds later fails closed.
    const approval: string = LIBRARY_V1_STATUS.internalAuditApproval;
    const providerAgreement: string = LIBRARY_V1_STATUS.providerAgreement;
    if (approval !== 'APPROVED') packLimits.push('CATALOGUE_NOT_APPROVED_BY_INTERNAL_AUDIT');
    if (providerAgreement !== 'AGREED') packLimits.push('CATALOGUE_NOT_AGREED_BY_PROVIDER');
    if (proceduresWithoutControl.length > 0) packLimits.push('PROCEDURE_WITHOUT_CONTROL');
    if (agreement.concluded === 0) packLimits.push('NO_CONCLUDED_REVIEW');

    const summary: RelianceSummarySnapshot = {
        type: RELIANCE_SUMMARY_SNAPSHOT_TYPE,
        schemaVersion: RELIANCE_SNAPSHOT_VERSION,
        title: `Agent-audit reliance: ${cycle.name}`,
        framework: { key: cycle.frameworkKey, version: cycle.frameworkVersion },
        cycle: { name: cycle.name },
        period: {
            start: cycle.periodStartAt.toISOString(),
            end: cycle.periodEndAt.toISOString(),
            labels: [...labels],
        },
        scope: LIBRARY_V1_PROCEDURE_IDS.map((procedureId) => ({
            procedureId,
            title: AUDIT_PROCEDURE_LIBRARY_V1[procedureId].title,
            controlIdentifiers: [...AUDIT_PROCEDURE_LIBRARY_V1[procedureId].controls],
            controlIds: controlIds.filter((id) => procByControl.get(id)?.has(procedureId)),
        })),
        proceduresWithoutControl: [...proceduresWithoutControl],
        catalogue: {
            versions: [...new Set(allEntries.map((e) => e.catalogueVersion))].sort((a, b) => a - b),
            status: LIBRARY_V1_STATUS,
            statement: LIBRARY_V1_STATUS_SENTENCE,
        },
        agreement,
        definitions: RELIANCE_METRIC_IDS.map((id) => METRIC_DEFINITIONS[id]),
        limits: packLimits,
    };

    return {
        kind: 'PLAN',
        items: [...items, { entityType: 'FRAMEWORK_COVERAGE', entityId: relianceSummaryEntityId(cycle.id), snapshot: summary }],
        summary,
    };
}
