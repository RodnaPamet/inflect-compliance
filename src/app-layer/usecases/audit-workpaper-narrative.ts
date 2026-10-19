/**
 * THE AUDIT NARRATIVE RUN'S ANSWER, STORED (#3749).
 *
 * An `audit-narrative` run on the Flue engine is taught `iam-audit-procedures`
 * and answers with one JSON block: a narrative per workpaper of the period it
 * was asked about. This is the seam where that answer becomes trusted rows:
 *
 *   run COMPLETED ─ executeFrom ─▶ captureAuditNarrativeAfterRun
 *     └ captureAuditNarrative(ctx, runId)                 (the ONE writer)
 *         run row: this workflow, COMPLETED, FLUE, the skill pinned
 *         run input: the sealed context, opened under verification → periodLabel
 *         the answer: the run's last Art 12 row (`AiDecisionLog.outputSummary`)
 *         readNarrativeFromAnswer → the schema, or a named refusal
 *         the workpapers it names, read from THIS tenant for THAT period
 *         checkNarrativesAgainstRecord → each narrative held to its record
 *         ▼
 *       AuditWorkpaperNarrative per workpaper not yet narrated (write-once)
 *
 * ── THE RECORD DECIDES, NOT THE ANSWER ──────────────────────────────────────
 *
 * Which period the run was about comes from its sealed input; which workpapers
 * exist, their conclusions and their codes come from the database. The answer
 * is a claim about all three and is checked against them, and one narrative
 * that states something its workpaper does not record refuses the whole
 * answer. The insert trigger re-checks the codes for any writer that skips
 * this.
 *
 * ── WHO MAY WRITE ───────────────────────────────────────────────────────────
 *
 * Nobody by request: there is no route. The capture runs where every run
 * settles, on the run's own context, and its authority is the run row it
 * re-reads under RLS. It writes narratives about workpapers of the run's own
 * period and nothing else; a workpaper, a finding or a proposal is not in
 * reach.
 *
 * ── FAIL CLOSED, NEVER SILENTLY ─────────────────────────────────────────────
 *
 * Every path that records nothing returns a named outcome, counted by
 * `recordAuditNarrativeCapture` and logged with the outcome alone — never the
 * answer, which is the model's text. The after-run wrapper never throws: a
 * narrative is not worth failing a run that has already completed.
 */
import { Prisma } from '@prisma/client';

import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import type { PrismaTx } from '@/lib/db-context';
import { logEvent } from '../events/audit';
import { logger } from '@/lib/observability/logger';
import { recordAuditNarrativeCapture } from '@/lib/observability/integration-metrics';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { ContextIntegrityError, openSealedContext } from '@/lib/agentic/context-integrity';
import { PERIOD_LABEL } from '@/lib/agentic/audit-workpaper';
import { recordedCodes } from '@/lib/agentic/audit-workpaper-view';
import {
    NARRATIVE_CONCLUSIONS,
    NARRATIVE_SKILL,
    checkNarrativesAgainstRecord,
    readNarrativeFromAnswer,
    type NarrativeAnswerRefusal,
    type NarrativeConclusion,
    type NarrativeRecordRefusal,
    type WorkpaperRecordFacts,
} from '@/lib/agentic/audit-narrative';
import { auditNarrativeWorkflow } from '@/lib/agentic/workflows/audit-narrative';

/** The workflow whose answers are captured — by its definition, not a second literal. */
export const NARRATIVE_WORKFLOW_KEY = auditNarrativeWorkflow.key;

/** The Art 12 feature a Flue run of the workflow records under (`agentic-run:<key>`). */
export const NARRATIVE_DECISION_FEATURE = `agentic-run:${NARRATIVE_WORKFLOW_KEY}`;

export type NarrativeCaptureOutcome =
    /** At least one narrative stored. */
    | 'RECORDED'
    /** Every narrative in the answer is already stored. */
    | 'ALREADY_RECORDED'
    /** No run of this workflow with that id in this tenant. */
    | 'NOT_A_NARRATIVE_RUN'
    | 'RUN_NOT_COMPLETED'
    /** The static engine: no model, no answer. */
    | 'NOT_A_MODEL_RUN'
    /** The run was not taught the skill, so its answer is not one. */
    | 'SKILL_NOT_MOUNTED'
    /** The sealed context would not open, or names no period. */
    | 'INPUT_UNREADABLE'
    /** No Art 12 row with the run's settled text. */
    | 'NO_ANSWER'
    | NarrativeAnswerRefusal
    | NarrativeRecordRefusal;

export interface NarrativeCaptureResult {
    readonly outcome: NarrativeCaptureOutcome;
    /** The period the run was asked about, when it could be read. */
    readonly periodLabel: string | null;
    /** Narratives stored by this capture. */
    readonly recorded: number;
    /** Narratives in the answer whose workpaper already had one. */
    readonly alreadyNarrated: number;
}

function mountedNames(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((p) =>
        typeof p === 'object' && p !== null && typeof (p as { name?: unknown }).name === 'string'
            ? [(p as { name: string }).name]
            : [],
    );
}

const done = (
    outcome: NarrativeCaptureOutcome,
    periodLabel: string | null = null,
    recorded = 0,
    alreadyNarrated = 0,
): NarrativeCaptureResult => ({ outcome, periodLabel, recorded, alreadyNarrated });

const isConclusion = (v: string): v is NarrativeConclusion => (NARRATIVE_CONCLUSIONS as readonly string[]).includes(v);

/**
 * Store the narratives a completed audit narrative run answered with — THE one
 * writer of `AuditWorkpaperNarrative`. Returns what happened; records nothing
 * on every outcome but `RECORDED`.
 */
export async function captureAuditNarrative(ctx: RequestContext, runId: string): Promise<NarrativeCaptureResult> {
    const result = await runInTenantContext(ctx, (db) => capture(db, ctx, runId));
    recordAuditNarrativeCapture({ outcome: result.outcome });
    if (result.outcome !== 'RECORDED') {
        logger.info('audit-workpaper-narrative: no narrative recorded', {
            component: 'agentic',
            tenantId: ctx.tenantId,
            runId,
            // The outcome only. The answer quotes the model.
            outcome: result.outcome,
        });
    }
    return result;
}

async function capture(db: PrismaTx, ctx: RequestContext, runId: string): Promise<NarrativeCaptureResult> {
    const run = await db.workflowRun.findFirst({
        where: { id: runId, tenantId: ctx.tenantId, workflowKey: NARRATIVE_WORKFLOW_KEY },
        select: { id: true, status: true, driver: true, mountedSkills: true, contextJson: true, contextHash: true },
    });
    if (!run) return done('NOT_A_NARRATIVE_RUN');
    if (run.status !== 'COMPLETED') return done('RUN_NOT_COMPLETED');
    if (run.driver !== 'FLUE') return done('NOT_A_MODEL_RUN');
    if (!mountedNames(run.mountedSkills).includes(NARRATIVE_SKILL)) return done('SKILL_NOT_MOUNTED');

    // WHICH PERIOD — from the sealed context, opened under verification. The
    // answer naming a period is a claim, checked against this.
    let periodLabel: string;
    try {
        const { context } = openSealedContext({
            tenantId: ctx.tenantId,
            runId: run.id,
            storedJson: run.contextJson,
            storedHash: run.contextHash,
        });
        const value = context.input.periodLabel;
        if (typeof value !== 'string' || !PERIOD_LABEL.test(value)) return done('INPUT_UNREADABLE');
        periodLabel = value;
    } catch (err) {
        if (err instanceof ContextIntegrityError) return done('INPUT_UNREADABLE');
        throw err;
    }

    // THE ANSWER: the run's last settled text.
    const decision = await db.aiDecisionLog.findFirst({
        where: {
            tenantId: ctx.tenantId,
            sessionRef: run.id,
            feature: NARRATIVE_DECISION_FEATURE,
            outputSummary: { not: null },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { outputSummary: true },
    });
    if (!decision?.outputSummary) return done('NO_ANSWER', periodLabel);

    const reading = readNarrativeFromAnswer(decision.outputSummary);
    if (!reading.ok) return done(reading.reason, periodLabel);

    // THE RECORD: only the workpapers the answer names, of this tenant and this
    // period. One the answer names that is not here is UNKNOWN_WORKPAPER.
    const ids = [...new Set(reading.answer.narratives.map((n) => n.workpaperId))];
    const rows = await db.auditWorkpaper.findMany({
        where: { tenantId: ctx.tenantId, periodLabel, id: { in: ids } },
        select: {
            id: true,
            periodLabel: true,
            conclusion: true,
            conclusionBasis: true,
            exceptionsJson: true,
            itemOutcomesJson: true,
        },
        take: ids.length,
    });
    const records: WorkpaperRecordFacts[] = rows.flatMap((r) =>
        isConclusion(r.conclusion)
            ? [{ id: r.id, periodLabel: r.periodLabel, conclusion: r.conclusion, conclusionBasis: r.conclusionBasis, ...recordedCodes(r) }]
            : [],
    );
    const check = checkNarrativesAgainstRecord(reading.answer, periodLabel, records);
    if (!check.ok) return done(check.reason, periodLabel);

    const existing = await db.auditWorkpaperNarrative.findMany({
        where: { tenantId: ctx.tenantId, workpaperId: { in: ids } },
        select: { workpaperId: true },
        take: ids.length,
    });
    const narrated = new Set(existing.map((e) => e.workpaperId));

    let recorded = 0;
    let alreadyNarrated = 0;
    for (const n of check.narratives) {
        if (narrated.has(n.workpaperId)) {
            alreadyNarrated += 1;
            continue;
        }
        try {
            await db.auditWorkpaperNarrative.create({
                data: {
                    tenantId: ctx.tenantId,
                    workpaperId: n.workpaperId,
                    runId: run.id,
                    exceptionCodes: [...n.exceptionCodes],
                    // Model output, so sanitised on the way in (C.5) as well as
                    // bounded and checked by the contract; encrypted at rest.
                    text: sanitizePlainText(n.text),
                },
            });
        } catch (err) {
            // Another capture narrated this workpaper first. Write-once: the
            // stored narrative stands, and this one is counted, not stored.
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
                alreadyNarrated += 1;
                continue;
            }
            throw err;
        }
        recorded += 1;
        // Audit, per workpaper. The codes and the run — never the text, which
        // is model output bound for the tenant's SIEM.
        await logEvent(db, ctx, {
            action: 'AUDIT_WORKPAPER_NARRATIVE_RECORDED',
            entityType: 'AuditWorkpaper',
            entityId: n.workpaperId,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'AuditWorkpaperNarrative',
                operation: 'created',
                summary:
                    `Stored the auditor agent's narrative of workpaper ${n.workpaperId} (period ${periodLabel}, ` +
                    `${n.conclusion}) from run ${run.id}, after holding it to the workpaper's record.`,
                after: {
                    runId: run.id,
                    periodLabel,
                    conclusion: n.conclusion,
                    exceptionCodes: [...n.exceptionCodes],
                },
            },
        });
    }
    if (recorded === 0) return done('ALREADY_RECORDED', periodLabel, 0, alreadyNarrated);
    return done('RECORDED', periodLabel, recorded, alreadyNarrated);
}

/**
 * The hook `executeFrom` calls when a run settles. Acts only on a COMPLETED run
 * of the audit narrative workflow, and NEVER THROWS.
 */
export async function captureAuditNarrativeAfterRun(
    ctx: RequestContext,
    runId: string,
    workflowKey: string,
    status: string,
): Promise<NarrativeCaptureResult | null> {
    if (workflowKey !== NARRATIVE_WORKFLOW_KEY || status !== 'COMPLETED') return null;
    try {
        return await captureAuditNarrative(ctx, runId);
    } catch (err) {
        recordAuditNarrativeCapture({ outcome: 'error' });
        logger.warn('audit-workpaper-narrative: capture failed; the run stands', {
            component: 'agentic',
            tenantId: ctx.tenantId,
            runId,
            error: err instanceof Error ? err.name : 'unknown',
        });
        return null;
    }
}

/** The stored narrative of one workpaper, for the review sheet. */
export async function narrativeOfWorkpaper(
    db: PrismaTx,
    ctx: RequestContext,
    workpaperId: string,
): Promise<{ text: string; exceptionCodes: string[]; runId: string; createdAt: Date } | null> {
    return db.auditWorkpaperNarrative.findFirst({
        where: { tenantId: ctx.tenantId, workpaperId },
        select: { text: true, exceptionCodes: true, runId: true, createdAt: true },
    });
}
