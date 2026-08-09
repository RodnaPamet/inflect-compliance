/**
 * NIS2 readiness — scoring + gap derivation + gap→finding materialization.
 *
 * Turns a tenant's self-assessment answers (Prompt 1/2) into ACTIONABLE
 * output: a weighted readiness score, a prioritized gap list, and — on
 * explicit user action — Findings + remediation Tasks.
 *
 * COMPLEMENTS, does not replace, the cross-framework traceability gap
 * analysis (`gap-analysis.ts`): that measures control COVERAGE; this
 * measures self-reported MATURITY.
 *
 * ── The scoring model (OUR defensible choices, not from the source) ──
 *   - maturity:    YES = 1.0, PARTIALLY = 0.5, NO = 0.0, NA = excluded.
 *   - criticality weight: CRITICAL=4, HIGH=3, MEDIUM=2, LOW=1.
 *   - domain score = 100 × Σ(weight·maturity) / Σ(weight) over ANSWERED
 *     (non-NA) questions.
 *   - overall score = the same weighted ratio aggregated across ALL
 *     answered questions (equivalently: domains weighted by their
 *     answered-question weight — a domain of 20 CRITICAL questions counts
 *     for more than one trivial LOW question).
 *   - NA is excluded from BOTH numerator and denominator (a
 *     not-applicable question must not penalize the score).
 *   - gap = an answered question with answer NO or PARTIALLY.
 *   - gap priority (sort key, higher = do-it-sooner) = a composite of
 *     criticality + consequence + fineExposure + (inverse) timeToFix +
 *     answer severity. A CRITICAL + fineExposure + PERSONAL_LIABILITY +
 *     QUICK_WIN gap ranks at the top (high stakes, fast fix).
 *
 * NOT a legal compliance determination — a self-assessment maturity aid.
 */
import { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { assertCanWrite } from '../policies/common';
import { assertCanManageOnboarding } from '../policies/onboarding.policies';
import { assertCanViewPack } from '../policies/audit-readiness.policies';
import { Nis2GapAssessmentRepository } from '../repositories/Nis2GapAssessmentRepository';
import { FindingRepository } from '../repositories/FindingRepository';
import { createFinding, updateFinding } from './finding';
import { createTask } from './task';

export const NIS2_SOURCE_KIND = 'NIS2_SELF_ASSESSMENT';
/** Distinct from the 'NIS2' framework key so self-assessment snapshots
 *  never collide with audit-readiness snapshots for the NIS2 framework. */
export const NIS2_SNAPSHOT_FRAMEWORK_KEY = 'NIS2_SELF_ASSESSMENT';

const CRIT_WEIGHT: Record<string, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
const CRIT_RANK: Record<string, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
const MATURITY: Record<string, number | null> = { YES: 1, PARTIALLY: 0.5, NO: 0, NA: null };
const CONSEQUENCE_WEIGHT: Record<string, number> = {
    AUDIT_FINDING: 1,
    OPERATIONAL_RISK: 2,
    FINE: 3,
    PERSONAL_LIABILITY: 4,
};
const TIME_TO_FIX_BONUS: Record<string, number> = { QUICK_WIN: 4, DAYS: 3, WEEKS: 2, MONTHS: 1 };
const TIME_TO_FIX_DUE_DAYS: Record<string, number> = { QUICK_WIN: 7, DAYS: 14, WEEKS: 30, MONTHS: 90 };

export type Nis2Answer = 'NA' | 'NO' | 'PARTIALLY' | 'YES';

/** Bilingual text as stored in the question fixture. */
export type Bilingual = { en: string; de: string };

export interface ScoringQuestion {
    id: string;
    domainId: number;
    criticality: string;
    consequence: string;
    fineExposure: boolean;
    timeToFix: string;
    legalBasis: string;
    plainText: Bilingual;
}
export interface ScoringDomain {
    id: number;
    code: string;
    name: Bilingual;
}

export interface Nis2Gap {
    questionId: string;
    domainId: number;
    criticality: string;
    consequence: string;
    fineExposure: boolean;
    timeToFix: string;
    legalBasis: string;
    answer: 'NO' | 'PARTIALLY';
    priority: number;
    priorityTier: 'URGENT' | 'HIGH' | 'MEDIUM' | 'LOW';
    plainText: Bilingual;
}

export interface Nis2Readiness {
    score: {
        overall: number;
        byDomain: Array<{ domainId: number; code: string; name: Bilingual; score: number; answered: number; total: number }>;
    };
    gaps: Nis2Gap[];
    fineExposureGaps: number;
    answeredTotal: number;
    questionTotal: number;
}

function gapPriority(q: ScoringQuestion, answer: 'NO' | 'PARTIALLY'): number {
    return (
        (CRIT_WEIGHT[q.criticality] ?? 1) * 10 +
        (CONSEQUENCE_WEIGHT[q.consequence] ?? 1) * 3 +
        (q.fineExposure ? 8 : 0) +
        (TIME_TO_FIX_BONUS[q.timeToFix] ?? 1) +
        (answer === 'NO' ? 2 : 1)
    );
}

/**
 * Gap-priority cut-offs. NOT the readiness bands — this is an unbounded
 * weighted priority score (consequence + fine exposure + time-to-fix), not a
 * 0-100 percentage, and its 50 means something entirely different from the
 * readiness band's 50. Named so the two can never be confused by a reader or
 * conflated by a grep.
 */
const PRIORITY_TIER_MIN = { URGENT: 50, HIGH: 38, MEDIUM: 26 } as const;

function priorityTier(p: number): Nis2Gap['priorityTier'] {
    if (p >= PRIORITY_TIER_MIN.URGENT) return 'URGENT';
    if (p >= PRIORITY_TIER_MIN.HIGH) return 'HIGH';
    if (p >= PRIORITY_TIER_MIN.MEDIUM) return 'MEDIUM';
    return 'LOW';
}

/**
 * PURE scoring — no DB. Derives the readiness score + prioritized gaps
 * from question metadata + an answer map. Unit-tested directly.
 */
export function scoreNis2Assessment(
    questions: ScoringQuestion[],
    domains: ScoringDomain[],
    answers: Record<string, Nis2Answer>,
): Nis2Readiness {
    const byDomainAcc = new Map<number, { weighted: number; weight: number; answered: number; total: number }>();
    for (const d of domains) byDomainAcc.set(d.id, { weighted: 0, weight: 0, answered: 0, total: 0 });

    let overallWeighted = 0;
    let overallWeight = 0;
    let answeredTotal = 0;
    const gaps: Nis2Gap[] = [];

    for (const q of questions) {
        const acc = byDomainAcc.get(q.domainId) ?? { weighted: 0, weight: 0, answered: 0, total: 0 };
        acc.total += 1;
        byDomainAcc.set(q.domainId, acc);

        const ans = answers[q.id];
        if (!ans) continue; // unanswered — not scored, not a gap
        const maturity = MATURITY[ans];
        if (maturity === null || maturity === undefined) continue; // NA — excluded

        const w = CRIT_WEIGHT[q.criticality] ?? 1;
        acc.weighted += w * maturity;
        acc.weight += w;
        acc.answered += 1;
        overallWeighted += w * maturity;
        overallWeight += w;
        answeredTotal += 1;

        if (ans === 'NO' || ans === 'PARTIALLY') {
            const priority = gapPriority(q, ans);
            gaps.push({
                questionId: q.id,
                domainId: q.domainId,
                criticality: q.criticality,
                consequence: q.consequence,
                fineExposure: q.fineExposure,
                timeToFix: q.timeToFix,
                legalBasis: q.legalBasis,
                answer: ans,
                priority,
                priorityTier: priorityTier(priority),
                plainText: q.plainText,
            });
        }
    }

    gaps.sort((a, b) => b.priority - a.priority);

    const byDomain = domains.map((d) => {
        const acc = byDomainAcc.get(d.id)!;
        return {
            domainId: d.id,
            code: d.code,
            name: d.name,
            score: acc.weight > 0 ? Math.round((acc.weighted / acc.weight) * 100) : 0,
            answered: acc.answered,
            total: acc.total,
        };
    });

    return {
        score: {
            overall: overallWeight > 0 ? Math.round((overallWeighted / overallWeight) * 100) : 0,
            byDomain,
        },
        gaps,
        fineExposureGaps: gaps.filter((g) => g.fineExposure).length,
        answeredTotal,
        questionTotal: questions.length,
    };
}

/** Load + score a tenant's self-assessment. Pure derivation — no mutation.
 *  Scores the latest run by default, or a specific run when `assessmentId`
 *  is given (used by the lifecycle history view). */
export async function computeNis2Readiness(
    ctx: RequestContext,
    assessmentId?: string,
): Promise<Nis2Readiness> {
    // readiness-reconcile — this is a pure READ (a maturity SCORE), surfaced
    // as one axis of the readiness overview beside control-coverage and
    // test-readiness (both `assertCanViewPack`). Gate it on the SAME
    // view-permission so a pack-viewer sees all three axes instead of a
    // silent 2-axis view. The self-assessment WRITE paths (running/finalising
    // an assessment, snapshotting the trend) keep `assertCanManageOnboarding`.
    assertCanViewPack(ctx);
    return runInTenantContext(ctx, async (db) => {
        const [domains, questions] = await Promise.all([
            Nis2GapAssessmentRepository.listDomains(db),
            Nis2GapAssessmentRepository.listQuestions(db),
        ]);
        const answers: Record<string, Nis2Answer> = {};
        let targetId = assessmentId;
        if (!targetId) {
            const assessments = await Nis2GapAssessmentRepository.listAssessments(db, ctx, { take: 1 });
            targetId = assessments[0]?.id;
        }
        if (targetId) {
            const rows = await Nis2GapAssessmentRepository.listAnswers(db, ctx, targetId);
            for (const r of rows) answers[r.questionId] = r.answer as Nis2Answer;
        }
        const sq: ScoringQuestion[] = questions.map((q) => ({
            id: q.id,
            domainId: q.domainId,
            criticality: q.criticality,
            consequence: q.consequence,
            fineExposure: q.fineExposure,
            timeToFix: q.timeToFix,
            legalBasis: q.legalBasis,
            plainText: q.plainText as Bilingual,
        }));
        const sd: ScoringDomain[] = domains.map((d) => ({
            id: d.id,
            code: d.code,
            name: d.name as Bilingual,
        }));
        return scoreNis2Assessment(sq, sd, answers);
    });
}

export interface MaterializeOptions {
    /** Only materialize gaps at/above this criticality (default HIGH). */
    minCriticality?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    /** Also create a remediation task per finding (default true). */
    createTasks?: boolean;
    /** Compute the plan without mutating. */
    dryRun?: boolean;
}

export interface MaterializeResult {
    created: number;
    reopened: number;
    closed: number;
    tasksCreated: number;
    /** dry-run preview counts. */
    eligibleGaps: number;
}

/**
 * Create Findings (and optionally Tasks) for serious gaps, idempotently.
 * Re-runnable: an existing OPEN finding is left alone; a CLOSED finding
 * whose question is a gap again is reopened; a finding whose question is
 * no longer a gap (answer now YES/NA) is CLOSED (reconciliation).
 *
 * Explicit, opt-in — NEVER called automatically. Reuses the finding/task
 * usecases (sanitisation + audit + validation come for free).
 */
export async function materializeNis2Gaps(
    ctx: RequestContext,
    options: MaterializeOptions = {},
): Promise<MaterializeResult> {
    assertCanWrite(ctx);
    const minCriticality = options.minCriticality ?? 'HIGH';
    const createTasks = options.createTasks ?? true;
    const threshold = CRIT_RANK[minCriticality] ?? 3;

    const readiness = await computeNis2Readiness(ctx);
    const allGapIds = new Set(readiness.gaps.map((g) => g.questionId));
    const eligible = readiness.gaps.filter((g) => (CRIT_RANK[g.criticality] ?? 1) >= threshold);

    // Existing NIS2 findings, keyed by questionId (sourceRef).
    const existing = await runInTenantContext(ctx, (db) =>
        FindingRepository.listBySource(db, ctx, NIS2_SOURCE_KIND),
    );
    const bySourceRef = new Map<string, { id: string; status: string }>();
    for (const f of existing) {
        if (f.sourceRef) bySourceRef.set(f.sourceRef, { id: f.id, status: f.status });
    }

    if (options.dryRun) {
        let wouldCreate = 0;
        let wouldReopen = 0;
        for (const g of eligible) {
            const ex = bySourceRef.get(g.questionId);
            if (!ex) wouldCreate += 1;
            else if (ex.status === 'CLOSED') wouldReopen += 1;
        }
        const wouldClose = existing.filter(
            (f) => f.sourceRef && !allGapIds.has(f.sourceRef) && f.status !== 'CLOSED',
        ).length;
        return { created: wouldCreate, reopened: wouldReopen, closed: wouldClose, tasksCreated: 0, eligibleGaps: eligible.length };
    }

    let created = 0;
    let reopened = 0;
    let tasksCreated = 0;

    for (const g of eligible) {
        const ex = bySourceRef.get(g.questionId);
        const plain = (g.plainText?.en ?? g.plainText?.de ?? String(g.questionId)) as string;
        if (ex) {
            if (ex.status === 'CLOSED') {
                await updateFinding(ctx, ex.id, { status: 'OPEN' });
                reopened += 1;
            }
            continue; // OPEN already — idempotent, no dup
        }
        const finding = await createFinding(ctx, {
            severity: g.criticality, // FindingSeverity shares LOW/MEDIUM/HIGH/CRITICAL
            type: 'NONCONFORMITY',
            title: plain,
            description:
                `NIS2 self-assessment gap (answered ${g.answer}). ` +
                `Legal basis: ${g.legalBasis}. Consequence if unaddressed: ${g.consequence}` +
                (g.fineExposure ? ' (regulatory fine exposure).' : '.'),
            sourceKind: NIS2_SOURCE_KIND,
            sourceRef: g.questionId,
        });
        created += 1;

        if (createTasks) {
            const dueDays = TIME_TO_FIX_DUE_DAYS[g.timeToFix] ?? 30;
            const dueAt = new Date(Date.now() + dueDays * 24 * 60 * 60 * 1000).toISOString();
            await createTask(ctx, {
                title: `Remediate: ${plain}`,
                type: 'CONTROL_GAP',
                severity: g.criticality,
                source: 'AUDIT',
                dueAt,
                // TP-3 — first-class FK to the Finding. metadataJson
                // keeps the linkage too (UI/reader back-compat).
                findingId: finding.id,
                metadataJson: {
                    source: NIS2_SOURCE_KIND,
                    questionId: g.questionId,
                    findingId: finding.id,
                    suggestedRespondent: g.consequence, // hint surfaced in UI
                },
            });
            tasksCreated += 1;
        }
    }

    // Reconciliation — close findings whose question is no longer a gap.
    let closed = 0;
    for (const f of existing) {
        if (f.sourceRef && !allGapIds.has(f.sourceRef) && f.status !== 'CLOSED') {
            await updateFinding(ctx, f.id, { status: 'CLOSED' });
            closed += 1;
        }
    }

    return { created, reopened, closed, tasksCreated, eligibleGaps: eligible.length };
}

/**
 * Snapshot the overall readiness score for the trend line. Reuses the
 * ReadinessSnapshot model with a distinct frameworkKey. Called on
 * assessment completion.
 *
 * DEDUPE — this used to write unconditionally while the sibling engine
 * (`audit-readiness/scoring.ts`) skipped the write when the score was
 * unchanged. Two writers to one model disagreeing about what a snapshot means
 * makes the trend line mean two things: for ISO a point is a CHANGE, for NIS2
 * it was an EVENT. They now agree on "a snapshot records a change", which is
 * what a trend line reads as, and which stops a re-run of the assessment from
 * flattening the chart with duplicate points.
 */
export async function snapshotNis2Readiness(ctx: RequestContext): Promise<void> {
    // This WRITES a trend snapshot; it previously borrowed its authorization
    // from computeNis2Readiness's assertion. Now that the score read is
    // view-gated, keep this write on the stricter manage-onboarding gate
    // explicitly so a viewer can never persist a snapshot.
    assertCanManageOnboarding(ctx);
    const readiness = await computeNis2Readiness(ctx);
    await runInTenantContext(ctx, async (db) => {
        const latest = await db.readinessSnapshot.findFirst({
            where: { tenantId: ctx.tenantId, frameworkKey: NIS2_SNAPSHOT_FRAMEWORK_KEY },
            orderBy: { computedAt: 'desc' },
            select: { score: true },
        });
        if (latest && latest.score === readiness.score.overall) return;
        await db.readinessSnapshot.create({
            data: {
                tenantId: ctx.tenantId,
                frameworkKey: NIS2_SNAPSHOT_FRAMEWORK_KEY,
                score: readiness.score.overall,
                gapCount: readiness.gaps.length,
                computedByUserId: ctx.userId ?? null,
            },
        });
    });
}

/** Snapshots for the trend chart, oldest→newest. */
export async function listNis2ReadinessSnapshots(ctx: RequestContext) {
    // Trend read — same view-permission as the other readiness axes.
    assertCanViewPack(ctx);
    return runInTenantContext(ctx, (db) =>
        db.readinessSnapshot.findMany({
            where: { tenantId: ctx.tenantId, frameworkKey: NIS2_SNAPSHOT_FRAMEWORK_KEY },
            orderBy: { computedAt: 'asc' },
            select: { score: true, gapCount: true, computedAt: true },
            take: 200,
        }),
    );
}

/**
 * Lightweight control-baseline suggestion: the lowest-scoring domains are
 * where to focus the CONTROL_BASELINE_INSTALL step. A SUGGESTION surface
 * (domain-level focus areas), not an auto-install — a per-control map
 * from gap-domain → NIS2 requirement is intentionally out of scope.
 */
export async function suggestNis2FocusAreas(ctx: RequestContext): Promise<
    Array<{ domainId: number; code: string; name: Bilingual; score: number }>
> {
    const readiness = await computeNis2Readiness(ctx);
    return readiness.score.byDomain
        .filter((d) => d.answered > 0)
        .sort((a, b) => a.score - b.score)
        .slice(0, 3)
        .map((d) => ({ domainId: d.domainId, code: d.code, name: d.name, score: d.score }));
}
