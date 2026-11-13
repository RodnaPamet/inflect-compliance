/**
 * Vendor-document → assessment pre-fill (propose-not-commit).
 *
 * Flow: parse the document to text → SANITIZE (privacy boundary) → AI
 * extract into a Zod-validated structure → map extracted controls to the
 * assessment's questions → PROPOSE cited answers a human reviews. Approving
 * a proposal is the ONLY path that writes a real VendorAssessmentAnswer —
 * an AI mis-reading a SOC 2 into a scored compliance record is a real risk,
 * so nothing is committed silently. Every proposal cites its source control
 * + result + period so a reviewer can verify the AI didn't hallucinate.
 *
 * Mirrors the RiskSuggestionSession/Item propose pattern.
 */
import { z } from 'zod';
import { RequestContext } from '../types';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, conflict, notFound } from '@/lib/errors/types';
import { logEvent } from '../events/audit';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { createFinding } from './finding';
import { sanitizeDocText, extractDocument, type DocExtraction } from '@/app-layer/ai/vendor-doc';
import { guardUntrustedInput, guardEgress, assertGuardAllowed } from '@/app-layer/ai/guard';
import { getFileRecordText } from '@/app-layer/services/vendor-doc-text';
import { controlEvidencesQuestion } from '@/app-layer/services/soc2-question-map';
import type { FindingSeverity } from '@prisma/client';
import { answerPointsFor } from './vendor-assessment-response';

/** Finding provenance tag for materialised SOC 2 exceptions. */
export const VENDOR_DOC_EXCEPTION_KIND = 'VENDOR_DOC_EXCEPTION';

export const ExtractVendorDocSchema = z.object({
    documentId: z.string().min(1),
    /** Optional target assessment to pre-fill. */
    assessmentId: z.string().optional(),
    /** Pre-extracted text override (skips the PDF fetch — used by tests/callers). */
    text: z.string().max(500_000).optional(),
    /** Opt-in: SOC 2 exceptions propose vendor findings. */
    materializeExceptions: z.boolean().default(false),
});
export type ExtractVendorDocInput = z.input<typeof ExtractVendorDocSchema>;

function fmtPeriod(e: DocExtraction): string {
    if (!e.auditPeriodStart && !e.auditPeriodEnd) return 'period n/a';
    return `period ${e.auditPeriodStart ?? '?'}..${e.auditPeriodEnd ?? '?'}`;
}

export interface ExtractResult {
    extractionId: string;
    status: string;
    reportType: string | null;
    proposalsCreated: number;
    findingsProposed: number;
}

export async function extractVendorDocument(
    ctx: RequestContext,
    rawInput: ExtractVendorDocInput,
): Promise<ExtractResult> {
    assertCanWrite(ctx);
    const input = ExtractVendorDocSchema.parse(rawInput);

    // ── Resolve text (OUTSIDE the tenant tx), sanitize, extract. ──
    const { document, rawText } = await runInTenantContext(ctx, async (db) => {
        const doc = await db.vendorDocument.findFirst({
            where: { id: input.documentId, tenantId: ctx.tenantId },
            select: { id: true, vendorId: true, fileId: true },
        });
        if (!doc) throw notFound('Vendor document not found');
        let text = input.text ?? null;
        if (!text && doc.fileId) {
            text = await getFileRecordText(db, ctx.tenantId, doc.fileId);
        }
        return { document: doc, rawText: text ?? '' };
    });

    const sanitized = sanitizeDocText(rawText);

    // AI Guard. The vendor document body is untrusted tenant content and has
    // the weakest prompt fence of the AI paths (raw text is concatenated into
    // the prompt with no injection neutralizer). Scan it for prompt-injection
    // BEFORE extraction, and egress-scan the outbound (already PII-sanitized)
    // text for secret material. Composes WITH the existing PII sanitizer
    // (sanitize → guard), never replaces it.
    const inputGuard = await guardUntrustedInput(ctx, sanitized, {
        source: 'vendor-doc',
    });
    const outboundGuard = await guardEgress(ctx, sanitized, {
        source: 'vendor-doc:outbound',
    });
    // Invariant: a strict-mode malicious input verdict OR a secret-leak egress
    // hit aborts before extraction — nothing is proposed from a poisoned doc.
    assertGuardAllowed(inputGuard);
    assertGuardAllowed(outboundGuard);

    const extraction = await extractDocument(sanitized);
    const e = extraction.data;

    // AI Guard — egress scan on the extracted structure before ANY proposal is
    // written. A secret pulled out of the document is blocked (never proposed).
    assertGuardAllowed(
        await guardEgress(ctx, e, { source: 'vendor-doc:extraction' }),
    );

    // ── Persist the extraction session. ──
    const extractionRow = await runInTenantContext(ctx, async (db) => {
        return db.vendorDocExtraction.create({
            data: {
                tenantId: ctx.tenantId,
                vendorId: document.vendorId,
                documentId: document.id,
                assessmentId: input.assessmentId ?? null,
                status: extraction.ok ? 'EXTRACTED' : 'FAILED',
                provider: extraction.provider,
                modelName: extraction.model,
                reportType: e.reportType,
                auditPeriodStart: e.auditPeriodStart ? new Date(e.auditPeriodStart) : null,
                auditPeriodEnd: e.auditPeriodEnd ? new Date(e.auditPeriodEnd) : null,
                scope: e.scope ? sanitizePlainText(e.scope) : null,
                auditor: e.auditor ? sanitizePlainText(e.auditor) : null,
                extractionJson: e as object,
                errorMessage: extraction.error ?? null,
                createdByUserId: ctx.userId,
            },
        });
    });

    // ── Map controls → questions → PROPOSE cited answers. ──
    let proposalsCreated = 0;
    if (input.assessmentId && e.controls.length > 0) {
        proposalsCreated = await runInTenantContext(ctx, async (db) => {
            const assessment = await db.vendorAssessment.findFirst({
                where: { id: input.assessmentId!, tenantId: ctx.tenantId },
                select: { id: true, templateId: true, templateVersionId: true },
            });
            if (!assessment) return 0;

            // Resolve the question set to map against. Two assessment shapes:
            //  • G-3 (templateVersionId set): questions live in
            //    VendorAssessmentTemplateQuestion. A materialised answer is
            //    keyed by BOTH questionId AND templateQuestionId = the
            //    template-question id (see
            //    vendor-assessment-response.ts::submitResponse), and
            //    approveProposal upserts on (assessmentId, questionId) using
            //    proposal.questionId — so a G-3 proposal MUST carry the
            //    template-question id in both fields for approve to write the
            //    correct row.
            //  • Legacy World-A (templateId set): questions live in the legacy
            //    QuestionnaireQuestion table; answers key on questionId only.
            let questionList: Array<{ id: string; prompt: string }>;
            let isG3: boolean;
            if (assessment.templateVersionId) {
                isG3 = true;
                questionList = await db.vendorAssessmentTemplateQuestion.findMany({
                    where: { templateId: assessment.templateVersionId },
                    select: { id: true, prompt: true },
                    take: 500,
                });
            } else if (assessment.templateId) {
                isG3 = false;
                questionList = await db.questionnaireQuestion.findMany({
                    where: { templateId: assessment.templateId },
                    select: { id: true, prompt: true },
                    take: 500,
                });
            } else {
                return 0;
            }

            let created = 0;
            for (const q of questionList) {
                const matched = e.controls.filter((c) => controlEvidencesQuestion(c.ref, q.prompt));
                if (matched.length === 0) continue;
                const hasException = matched.some((c) => c.result === 'EXCEPTION');
                const refs = matched.map((c) => c.ref).join(', ');
                const citation = `SOC 2 ${refs} — ${hasException ? 'exception noted' : 'no exceptions'}, ${fmtPeriod(e)}`;
                await db.vendorAnswerProposal.create({
                    data: {
                        tenantId: ctx.tenantId,
                        extractionId: extractionRow.id,
                        assessmentId: assessment.id,
                        questionId: q.id,
                        // G-3 answers key on both fields (= template-question id).
                        templateQuestionId: isG3 ? q.id : undefined,
                        proposedAnswerJson: { value: hasException ? 'PARTIAL' : 'YES', controls: matched.map((c) => c.ref), source: citation },
                        confidence: hasException ? 'medium' : 'high',
                        sourceCitation: citation,
                        status: 'PENDING',
                    },
                });
                created++;
            }
            return created;
        });
    }

    // ── Exceptions → PROPOSED vendor findings (opt-in, idempotent). ──
    let findingsProposed = 0;
    if (input.materializeExceptions && e.exceptions.length > 0) {
        // Keyed on the DOCUMENT and the control, so a re-run over the same
        // report finds the findings it already raised (#5157). The key used to
        // embed this run's brand-new extraction id, which no earlier finding
        // could carry, so every run duplicated every exception. Findings raised
        // under that old key (`<extractionId>:<control>`) for an earlier
        // extraction of this document still count as seen.
        const { existing, priorExtractionIds } = await runInTenantContext(ctx, async (db) => {
            const prior = await db.vendorDocExtraction.findMany({
                where: { tenantId: ctx.tenantId, documentId: document.id },
                select: { id: true },
                take: 500,
            });
            const prefixes = [document.id, ...prior.map((x) => x.id)];
            const rows = await db.finding.findMany({
                where: {
                    tenantId: ctx.tenantId,
                    sourceKind: VENDOR_DOC_EXCEPTION_KIND,
                    deletedAt: null,
                    OR: prefixes.map((p) => ({ sourceRef: { startsWith: `${p}:` } })),
                },
                select: { sourceRef: true },
                take: 2000,
            });
            return { existing: rows, priorExtractionIds: prior.map((x) => x.id) };
        });
        const controlOf = (ref: string): string | null => {
            for (const prefix of [document.id, ...priorExtractionIds]) {
                if (ref.startsWith(`${prefix}:`)) return ref.slice(prefix.length + 1);
            }
            return null;
        };
        const seenControls = new Set(
            existing.map((f) => (f.sourceRef ? controlOf(f.sourceRef) : null)).filter((c): c is string => c !== null),
        );
        for (const exc of e.exceptions.slice(0, 100)) {
            if (seenControls.has(exc.control)) continue;
            // Two exceptions on one control in one report are one finding.
            seenControls.add(exc.control);
            const sourceRef = `${document.id}:${exc.control}`;
            await createFinding(ctx, {
                severity: 'MEDIUM' as FindingSeverity,
                type: 'OBSERVATION',
                title: `Vendor SOC 2 exception — ${exc.control}`.slice(0, 250),
                description: exc.description,
                sourceKind: VENDOR_DOC_EXCEPTION_KIND,
                sourceRef,
            });
            findingsProposed++;
        }
    }

    await runInTenantContext(ctx, async (db) => {
        await logEvent(db, ctx, {
            action: 'VENDOR_DOC_EXTRACTED',
            entityType: 'VendorDocExtraction',
            entityId: extractionRow.id,
            details: `Extracted ${e.reportType} for vendor ${document.vendorId} — ${proposalsCreated} proposed answers, ${findingsProposed} proposed findings`,
            detailsJson: { category: 'custom', event: 'vendor_doc_extracted' },
            metadata: { vendorId: document.vendorId, reportType: e.reportType, proposalsCreated, findingsProposed },
        });
    });

    return {
        extractionId: extractionRow.id,
        status: extraction.ok ? 'EXTRACTED' : 'FAILED',
        reportType: e.reportType,
        proposalsCreated,
        findingsProposed,
    };
}

/**
 * Approve a proposal → MATERIALISE a real VendorAssessmentAnswer (the only
 * path that commits an AI-proposed answer). Optionally accept an edited
 * answer payload from the reviewer.
 */
export async function approveProposal(
    ctx: RequestContext,
    proposalId: string,
    editedAnswerJson?: unknown,
) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const proposal = await db.vendorAnswerProposal.findFirst({
            where: { id: proposalId, tenantId: ctx.tenantId },
        });
        if (!proposal) throw notFound('Proposal not found');
        if (!proposal.assessmentId || !proposal.questionId) {
            throw badRequest('UNMAPPED_PROPOSAL', 'Proposal is not mapped to an assessment question');
        }
        // A reviewed or closed assessment's answers are what its review
        // scored. Writing one now would change a recorded result under the
        // reviewer's rating (#4936).
        const assessment = await db.vendorAssessment.findFirst({
            where: { id: proposal.assessmentId, tenantId: ctx.tenantId },
            select: { status: true },
        });
        if (!assessment) throw notFound('Assessment not found');
        if (ANSWERS_FROZEN_STATUSES.has(assessment.status)) {
            throw conflict(
                'This assessment has already been reviewed, so its answers can no longer change. Proposed answers cannot be approved onto it.',
            );
        }
        // Claimed while still PENDING, in this transaction (#5156). A rejected
        // or already-accepted proposal could be approved again by anyone
        // holding its id; a refused approval now rolls the claim back.
        const claimed = await db.vendorAnswerProposal.updateMany({
            where: { id: proposalId, tenantId: ctx.tenantId, status: 'PENDING' },
            data: { status: 'ACCEPTED' },
        });
        if (claimed.count === 0) {
            throw conflict('This proposal has already been accepted or rejected.');
        }

        // The question the answer is for, so the answer is written in its
        // vocabulary and scored by its own rule, as a vendor's submission is.
        const question = proposal.templateQuestionId
            ? await db.vendorAssessmentTemplateQuestion.findFirst({
                  where: { id: proposal.templateQuestionId, tenantId: ctx.tenantId },
                  select: { answerType: true, weight: true, optionsJson: true, riskPointsJson: true },
              })
            : await db.questionnaireQuestion.findFirst({
                  where: { id: proposal.questionId },
                  select: { answerType: true, weight: true, optionsJson: true, riskPointsJson: true },
              });
        if (!question) throw notFound('The question this proposal answers no longer exists');
        const answerJson = answerInQuestionVocabulary(
            question,
            (editedAnswerJson ?? proposal.proposedAnswerJson) as unknown,
        );
        const computedPoints = answerPointsFor(question, answerJson);

        const answer = await db.vendorAssessmentAnswer.upsert({
            where: { assessmentId_questionId: { assessmentId: proposal.assessmentId, questionId: proposal.questionId } },
            create: {
                tenantId: ctx.tenantId,
                assessmentId: proposal.assessmentId,
                questionId: proposal.questionId,
                templateQuestionId: proposal.templateQuestionId ?? undefined,
                answerJson: answerJson as object,
                computedPoints,
                reviewerNotes: `Pre-filled from ${proposal.sourceCitation}`,
            },
            update: {
                answerJson: answerJson as object,
                computedPoints,
                reviewerNotes: `Pre-filled from ${proposal.sourceCitation}`,
            },
        });
        await db.vendorAnswerProposal.update({
            where: { id: proposalId },
            data: { createdAnswerId: answer.id },
        });
        await logEvent(db, ctx, {
            action: 'VENDOR_PROPOSAL_APPROVED',
            entityType: 'VendorAnswerProposal',
            entityId: proposalId,
            details: `Approved proposed answer (${proposal.sourceCitation}) → answer ${answer.id}`,
            detailsJson: { category: 'custom', event: 'vendor_proposal_approved' },
        });
        return { answerId: answer.id };
    });
}

/**
 * The proposed answer, in the question's own vocabulary (#5156).
 *
 * Proposals say `YES` or `PARTIAL`; a G-3 yes/no answer is `yes` or `no`, and
 * `PARTIAL` is in no vocabulary. A yes/no value is folded to lowercase; any
 * other value a yes/no or select question does not offer is refused, so the
 * reviewer edits it rather than storing an answer that scores nothing.
 */
function answerInQuestionVocabulary(
    question: { answerType: string; optionsJson: unknown },
    answerJson: unknown,
): unknown {
    const obj = answerJson && typeof answerJson === 'object' && !Array.isArray(answerJson)
        ? (answerJson as Record<string, unknown>)
        : { value: answerJson };
    const value = obj.value;
    if (question.answerType === 'YES_NO') {
        const folded = typeof value === 'string' ? value.trim().toLowerCase() : value === true ? 'yes' : value === false ? 'no' : null;
        if (folded !== 'yes' && folded !== 'no') {
            throw badRequest(
                'PROPOSAL_VALUE_NOT_IN_VOCABULARY',
                'This question takes yes or no. Edit the proposed answer before approving it.',
            );
        }
        return { ...obj, value: folded };
    }
    if (question.answerType === 'SINGLE_SELECT') {
        const offered = Array.isArray(question.optionsJson)
            ? question.optionsJson
                  .map((o) => (o && typeof o === 'object' ? (o as { value?: unknown }).value : undefined))
                  .filter((v): v is string => typeof v === 'string')
            : [];
        if (typeof value !== 'string' || !offered.includes(value)) {
            throw badRequest(
                'PROPOSAL_VALUE_NOT_IN_VOCABULARY',
                'This question takes one of its listed options. Edit the proposed answer before approving it.',
            );
        }
    }
    return obj;
}

/** Statuses after which an assessment's answers are the reviewed record. */
const ANSWERS_FROZEN_STATUSES: ReadonlySet<string> = new Set(['REVIEWED', 'CLOSED']);

/** Reject a proposal — no answer is written. */
export async function rejectProposal(ctx: RequestContext, proposalId: string) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const proposal = await db.vendorAnswerProposal.findFirst({
            where: { id: proposalId, tenantId: ctx.tenantId },
            select: { id: true },
        });
        if (!proposal) throw notFound('Proposal not found');
        await db.vendorAnswerProposal.update({ where: { id: proposalId }, data: { status: 'REJECTED' } });
        return { id: proposalId };
    });
}

/** Recent extractions for a vendor. */
export async function listVendorDocExtractions(ctx: RequestContext, vendorId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        return db.vendorDocExtraction.findMany({
            where: { tenantId: ctx.tenantId, vendorId },
            orderBy: { createdAt: 'desc' },
            take: 50,
        });
    });
}

/** An extraction + its pending proposals (the review surface data). */
export async function getVendorDocExtraction(ctx: RequestContext, extractionId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const extraction = await db.vendorDocExtraction.findFirst({
            where: { id: extractionId, tenantId: ctx.tenantId },
        });
        if (!extraction) throw notFound('Extraction not found');
        const proposals = await db.vendorAnswerProposal.findMany({
            where: { tenantId: ctx.tenantId, extractionId },
            orderBy: { createdAt: 'asc' },
            take: 500,
        });
        return { ...extraction, proposals };
    });
}
