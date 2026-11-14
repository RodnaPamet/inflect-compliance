/**
 * NIS2 gap-assessment LIFECYCLE — the ongoing layer the onboarding wizard's
 * one-time baseline run can't provide: run history, and a propose-not-commit
 * remediation engine that turns prioritised gaps into SUGGESTED Risks, Controls
 * and Tasks a human approves before anything is written.
 *
 * Built ENTIRELY on the existing single source of truth — the DB-backed NISD2
 * question bank (`Nis2GapAssessmentRepository`, seeded from the one fixture
 * `prisma/fixtures/nis2-gap-assessment.json`, © NISD2 / CC BY 4.0) and the
 * `Nis2SelfAssessment` run store. It adds NO second question bank and NO second
 * assessment model — the run's provenance is the `source` column
 * (WIZARD_BASELINE | STANDALONE), history is the append-only set of runs.
 *
 * Propose-not-commit (management-liability lens): this module NEVER calls a
 * create-usecase during scoring/proposal. `proposeNis2Remediations` is a pure
 * read that ranks gaps and classifies each into a suggestion; only
 * `applyNis2Remediations`, on explicit per-item approval, runs
 * `risk.createRisk` / `control.createControl` / `task.createTask` inside
 * `runInTenantContext` with full audit.
 *
 * Link-not-duplicate: gap QUESTIONS are a distinct axis from NIS2 framework
 * REQUIREMENTS (no per-question requirement map exists), so a "missing control"
 * gap prefers REUSING an existing NIS2 control — a remediation task bound to
 * that control — over minting a duplicate. Only when the tenant has no NIS2
 * controls at all does the suggestion become "create a control".
 */
import { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { logEvent } from '../events/audit';
import { Nis2GapAssessmentRepository } from '../repositories/Nis2GapAssessmentRepository';
import {
    computeNis2Readiness,
    type Nis2Gap,
    type Bilingual,
} from './nis2-readiness';
import { createRisk } from './risk';
import { createControl } from './control/mutations';
import { createTask } from './task';

/** Category sentinel so re-applied suggestions dedupe (mirrors self-assessment). */
export const NIS2_GAP_CATEGORY = 'NIS2_GAP';
const NIS2_FRAMEWORK_KEY = 'NIS2';
const TIME_TO_FIX_DUE_DAYS: Record<string, number> = { QUICK_WIN: 7, DAYS: 14, WEEKS: 30, MONTHS: 90 };
const CRIT_RANK: Record<string, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

function plain(text: Bilingual | undefined, q: string): string {
    return (text?.en ?? text?.de ?? q) as string;
}

// ─── Install detection (gates the Audits-page entry button) ─────────

/**
 * Does this tenant "have" NIS2? True when it has run the NIS2 gap
 * self-assessment at least once (a `Nis2SelfAssessment` row exists — the wizard
 * creates the baseline when NIS2 is selected) OR has controls mapped to the
 * NIS2 framework. Read-only; used server-side to conditionally render the
 * Audits-page "NIS2 Gap Assessment" button (absent, not disabled, otherwise).
 */
export async function tenantHasNis2(ctx: RequestContext): Promise<boolean> {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const [runs, link] = await Promise.all([
            Nis2GapAssessmentRepository.listAssessments(db, ctx, { take: 1 }),
            db.controlRequirementLink.findFirst({
                where: { tenantId: ctx.tenantId, requirement: { framework: { key: NIS2_FRAMEWORK_KEY } } },
                select: { id: true },
            }),
        ]);
        return runs.length > 0 || link != null;
    });
}

// ─── Run history ────────────────────────────────────────────────────

export interface Nis2RunSummary {
    id: string;
    source: string;
    status: string;
    completedAt: string | null;
    createdAt: string;
    overall: number;
    gapCount: number;
    answered: number;
    total: number;
}

/**
 * Every assessment run (baseline + standalones), newest first, each scored.
 * The lifecycle history / trend surface reads this.
 */
export async function listNis2GapAssessmentHistory(ctx: RequestContext): Promise<Nis2RunSummary[]> {
    assertCanRead(ctx);
    const runs = await runInTenantContext(ctx, (db) =>
        Nis2GapAssessmentRepository.listAssessments(db, ctx, { take: 50 }),
    );
    const summaries: Nis2RunSummary[] = [];
    for (const run of runs) {
        const readiness = await computeNis2Readiness(ctx, run.id);
        summaries.push({
            id: run.id,
            source: run.source ?? 'STANDALONE',
            status: run.status,
            completedAt: run.completedAt ? run.completedAt.toISOString() : null,
            createdAt: run.createdAt.toISOString(),
            overall: readiness.score.overall,
            gapCount: readiness.gaps.length,
            answered: readiness.answeredTotal,
            total: readiness.questionTotal,
        });
    }
    return summaries;
}

// ─── Propose-not-commit remediation ─────────────────────────────────

export type RemediationKind = 'RISK' | 'CONTROL_LINK' | 'CONTROL_CREATE' | 'TASK';

export interface RemediationSuggestion {
    questionId: string;
    title: string;
    legalBasis: string;
    priorityTier: Nis2Gap['priorityTier'];
    criticality: string;
    consequence: string;
    fineExposure: boolean;
    kind: RemediationKind;
    reason: string;
    /** For CONTROL_LINK — existing NIS2 controls to reuse instead of duplicating. */
    existingControls?: Array<{ id: string; name: string }>;
}

/** Classify a single gap into exactly one suggested remediation. Pure +
 *  exported for unit coverage of the management-liability routing. */
export function classify(gap: Nis2Gap, hasNis2Controls: boolean): RemediationKind {
    // Management-liability lens first — a fineable / personal-liability gap is a
    // RISK the board must own, not just a task.
    if (gap.fineExposure || gap.consequence === 'PERSONAL_LIABILITY') return 'RISK';
    if (gap.timeToFix === 'QUICK_WIN') return 'TASK';
    // Otherwise it's a control gap: reuse an existing NIS2 control when the
    // tenant already owns one (link-not-duplicate), else propose creating one.
    return hasNis2Controls ? 'CONTROL_LINK' : 'CONTROL_CREATE';
}

/**
 * PURE read: rank the current run's gaps (>= minCriticality) and classify each
 * into a suggested Risk / Control / Task. Never writes. The UI renders these as
 * a "Create these?" review list.
 */
export async function proposeNis2Remediations(
    ctx: RequestContext,
    options: { minCriticality?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' } = {},
): Promise<{ suggestions: RemediationSuggestion[]; existingControls: Array<{ id: string; name: string }> }> {
    assertCanRead(ctx);
    const threshold = CRIT_RANK[options.minCriticality ?? 'HIGH'] ?? 3;
    const readiness = await computeNis2Readiness(ctx);

    // Existing NIS2 controls (link-not-duplicate candidates) — controls the
    // tenant already has mapped to the NIS2 framework's requirements.
    const existingControls = await runInTenantContext(ctx, async (db) => {
        const links = await db.controlRequirementLink.findMany({
            where: { tenantId: ctx.tenantId, requirement: { framework: { key: NIS2_FRAMEWORK_KEY } } },
            select: { control: { select: { id: true, name: true } } },
            take: 200,
        });
        const seen = new Map<string, { id: string; name: string }>();
        for (const l of links) if (l.control) seen.set(l.control.id, l.control);
        return [...seen.values()];
    });
    const hasNis2Controls = existingControls.length > 0;

    const suggestions: RemediationSuggestion[] = readiness.gaps
        .filter((g) => (CRIT_RANK[g.criticality] ?? 1) >= threshold)
        .map((g) => {
            const kind = classify(g, hasNis2Controls);
            const title = plain(g.plainText, g.questionId);
            const reason =
                kind === 'RISK'
                    ? `Fine/personal-liability exposure (${g.consequence}). Owner-level risk.`
                    : kind === 'TASK'
                        ? `Quick win — remediate directly.`
                        : kind === 'CONTROL_LINK'
                            ? `Existing NIS2 control scores ${g.answer} — link + remediate, don't duplicate.`
                            : `No NIS2 control covers this yet — create one.`;
            return {
                questionId: g.questionId,
                title,
                legalBasis: g.legalBasis,
                priorityTier: g.priorityTier,
                criticality: g.criticality,
                consequence: g.consequence,
                fineExposure: g.fineExposure,
                kind,
                reason,
                ...(kind === 'CONTROL_LINK' ? { existingControls } : {}),
            };
        });

    return { suggestions, existingControls };
}

export interface RemediationApproval {
    questionId: string;
    kind: RemediationKind;
    /** For CONTROL_LINK — the existing control to bind the remediation task to. */
    linkControlId?: string;
}

export interface ApplyResult {
    risksCreated: number;
    controlsCreated: number;
    tasksCreated: number;
    skipped: number;
}

/**
 * COMMIT step — runs the real create-usecases ONLY for approved suggestions.
 * Idempotent: a risk/control whose title already exists under the NIS2_GAP
 * category is skipped; a task carrying the same questionId marker is skipped.
 */
export async function applyNis2Remediations(
    ctx: RequestContext,
    approvals: RemediationApproval[],
): Promise<ApplyResult> {
    assertCanWrite(ctx);
    if (!approvals.length) return { risksCreated: 0, controlsCreated: 0, tasksCreated: 0, skipped: 0 };

    // Re-derive the current suggestions so approvals can't inject arbitrary
    // titles/kinds — we only act on gaps that are genuinely proposed.
    const { suggestions } = await proposeNis2Remediations(ctx, { minCriticality: 'LOW' });
    const byQ = new Map(suggestions.map((s) => [s.questionId, s]));

    // Idempotency sets — existing NIS2-gap risks/controls + tasks.
    const { risks, controls, taskMarkers } = await runInTenantContext(ctx, async (db) => {
        const [riskRows, controlRows, taskRows] = await Promise.all([
            db.risk.findMany({ where: { tenantId: ctx.tenantId, category: NIS2_GAP_CATEGORY }, select: { title: true } }),
            db.control.findMany({ where: { tenantId: ctx.tenantId, category: NIS2_GAP_CATEGORY }, select: { name: true } }),
            db.task.findMany({ where: { tenantId: ctx.tenantId, source: 'AUDIT' }, select: { metadataJson: true } }),
        ]);
        const markers = new Set<string>();
        for (const t of taskRows) {
            const m = t.metadataJson as { questionId?: string; source?: string } | null;
            if (m?.source === NIS2_GAP_CATEGORY && m.questionId) markers.add(m.questionId);
        }
        return {
            risks: new Set(riskRows.map((r) => r.title)),
            controls: new Set(controlRows.map((c) => c.name)),
            taskMarkers: markers,
        };
    });

    let risksCreated = 0, controlsCreated = 0, tasksCreated = 0, skipped = 0;

    for (const approval of approvals) {
        const s = byQ.get(approval.questionId);
        if (!s) { skipped++; continue; } // not a current suggestion — ignore
        // The kind is the engine's, not the request's (#5318): an approval that
        // names a different kind would create a Risk or Control the engine
        // never proposed. Likewise a CONTROL_LINK may bind only a control the
        // suggestion offered.
        if (approval.kind !== s.kind) { skipped++; continue; }
        if (
            approval.kind === 'CONTROL_LINK'
            && approval.linkControlId !== undefined
            && !(s.existingControls ?? []).some((c) => c.id === approval.linkControlId)
        ) { skipped++; continue; }

        if (approval.kind === 'RISK') {
            if (risks.has(s.title)) { skipped++; continue; }
            await createRisk(ctx, {
                title: s.title,
                category: NIS2_GAP_CATEGORY,
                description: `NIS2 gap (${s.consequence}). Legal basis: ${s.legalBasis}.` + (s.fineExposure ? ' Regulatory fine exposure.' : ''),
            });
            risks.add(s.title);
            risksCreated++;
        } else if (approval.kind === 'CONTROL_CREATE') {
            if (controls.has(s.title)) { skipped++; continue; }
            await createControl(ctx, {
                name: s.title,
                category: NIS2_GAP_CATEGORY,
                objective: `Control to close NIS2 gap. Legal basis: ${s.legalBasis}.`,
                isCustom: true,
            });
            controls.add(s.title);
            controlsCreated++;
        } else {
            // TASK or CONTROL_LINK → a remediation task (CONTROL_LINK binds it to
            // the chosen existing control instead of duplicating a control).
            if (taskMarkers.has(s.questionId)) { skipped++; continue; }
            const dueDays = TIME_TO_FIX_DUE_DAYS[s.priorityTier === 'URGENT' ? 'QUICK_WIN' : 'WEEKS'] ?? 30;
            await createTask(ctx, {
                title: `Remediate: ${s.title}`,
                type: 'CONTROL_GAP',
                severity: s.criticality,
                source: 'AUDIT',
                dueAt: new Date(Date.now() + dueDays * 24 * 60 * 60 * 1000).toISOString(),
                controlId: approval.kind === 'CONTROL_LINK' ? approval.linkControlId ?? null : null,
                metadataJson: { source: NIS2_GAP_CATEGORY, questionId: s.questionId, legalBasis: s.legalBasis },
            });
            taskMarkers.add(s.questionId);
            tasksCreated++;
        }
    }

    await runInTenantContext(ctx, (db) =>
        logEvent(db, ctx, {
            action: 'NIS2_REMEDIATIONS_APPLIED',
            entityType: 'Nis2SelfAssessment',
            entityId: ctx.tenantId,
            detailsJson: {
                category: 'custom',
                event: 'nis2_remediations_applied',
                risksCreated, controlsCreated, tasksCreated, skipped,
            },
        }),
    );

    return { risksCreated, controlsCreated, tasksCreated, skipped };
}
