/**
 * Epic G-3 — Vendor-facing response usecases.
 *
 * Two entry points underpin the public response flow:
 *
 *   • loadResponseByToken — verify the share-link token and return
 *     the assessment + template tree + the respondent's existing
 *     answers (and ONLY their own — no cross-tenant data leaks).
 *
 *   • submitResponse — final validation + transactional persistence.
 *     Validates required-field presence and per-answer-type shape,
 *     upserts answer rows, transitions status SENT/IN_PROGRESS →
 *     SUBMITTED, computes the provisional score sum.
 *
 * Both usecases live OUTSIDE the authenticated app layer — they
 * never touch the user-bound `RequestContext`. The public route
 * handlers call them directly with the raw token.
 *
 * @module usecases/vendor-assessment-response
 */
import { prisma } from '@/lib/prisma';
import { runInTenantContext } from '@/lib/db-context';
import { sanitizePlainText } from '@/lib/security/sanitize';
import {
    verifyAccessToken,
    type AccessVerificationFailure,
} from '@/lib/security/external-assessment-access';
import { logEvent } from '../events/audit';
import { runWithAuditContext } from '@/lib/audit-context';
import type { RequestContext } from '../types';
import { enqueueEmail } from '../notifications/enqueue';
import { logger } from '@/lib/observability/logger';

/**
 * Minimal `RequestContext` for the anonymous respondent.
 *
 * `logEvent` reads exactly three fields off ctx — tenantId, userId,
 * requestId (events/audit.ts) — and `runInTenantContext` reads the same
 * three to bind RLS + audit correlation. Nothing on this path reads `role`
 * or `permissions`.
 *
 * They are therefore zeroed rather than forged. The previous shape claimed
 * `role: 'EDITOR'` with `canWrite: true`, which put a live
 * elevated-privilege object inside the write transaction — a loaded gun for
 * any future code that reaches for `ctx.permissions` to decide something.
 * An external respondent holds no authority in this tenant; the context now
 * says so. Authority on this path comes from the verified token alone.
 */
function makeExternalAuditCtx(
    tenantId: string,
    assessmentId: string,
): RequestContext {
    return {
        tenantId,
        userId: 'external-respondent',
        requestId: `vendor-assessment-submit:${assessmentId}`,
        role: 'READER' as const,
        permissions: {
            canRead: false,
            canWrite: false,
            canAdmin: false,
            canAudit: false,
            canExport: false,
        },
        appPermissions: {} as never,
    };
}

// ─── Types ─────────────────────────────────────────────────────────

export interface ResponseQuestion {
    id: string;
    sortOrder: number;
    prompt: string;
    answerType:
        | 'YES_NO'
        | 'SINGLE_SELECT'
        | 'MULTI_SELECT'
        | 'TEXT'
        | 'NUMBER'
        | 'SCALE'
        | 'FILE_UPLOAD';
    required: boolean;
    weight: number;
    optionsJson: unknown;
    scaleConfigJson: unknown;
}

export interface ResponseSection {
    id: string;
    sortOrder: number;
    title: string;
    description: string | null;
    questions: ResponseQuestion[];
}

export interface ResponseAnswer {
    questionId: string;
    answerJson: unknown;
}

export interface LoadResponseResult {
    assessmentId: string;
    status: string;
    expiresAtIso: string | null;
    vendor: { name: string };
    template: {
        name: string;
        description: string | null;
        sections: ResponseSection[];
    };
    answers: ResponseAnswer[];
}

export interface SubmitAnswerInput {
    questionId: string;
    answerJson: unknown;
    /** Required for FILE_UPLOAD answers. */
    evidenceId?: string | null;
}

export interface SubmitResponseResult {
    submittedAt: Date;
    status: 'SUBMITTED';
    /** Sum of computedPoints across all submitted answers. */
    provisionalScore: number;
}

export class ExternalAccessDenied extends Error {
    constructor(public readonly reason: AccessVerificationFailure) {
        super(`External access denied: ${reason}`);
    }
}

export class ResponseValidationError extends Error {
    constructor(
        public readonly fieldErrors: Array<{
            questionId: string | null;
            message: string;
        }>,
    ) {
        super(
            `Response validation failed: ${fieldErrors.length} field(s) invalid`,
        );
    }
}

// ─── 1. loadResponseByToken ────────────────────────────────────────

export async function loadResponseByToken(
    rawToken: string | null | undefined,
    assessmentId: string,
): Promise<LoadResponseResult> {
    const verified = await verifyAccessToken(rawToken, assessmentId);
    if (!verified.ok) throw new ExternalAccessDenied(verified.reason);
    const assessment = verified.assessment;

    if (!assessment.templateVersionId) {
        // The G-3 send flow always pins a templateVersionId. A null
        // here would mean the assessment was created via a legacy
        // path and got a token re-attached — refuse rather than
        // surface a half-rendered form.
        throw new ExternalAccessDenied('unknown_assessment');
    }

    // Everything past token verification runs under the assessment's own
    // tenant context. `verifyAccessToken` necessarily reads with the bare
    // client (the public flow has no tenant at request time), but from here
    // the module header's promise holds: `SET LOCAL ROLE app_user` +
    // `set_config('app.tenant_id')` engage RLS, so a mistake in any
    // predicate below cannot reach another tenant's rows.
    const templateVersionId = assessment.templateVersionId;
    const externalCtx = makeExternalAuditCtx(assessment.tenantId, assessment.id);
    const loaded = await runInTenantContext(externalCtx, async (tdb) => {
        const [vendor, template] = await Promise.all([
            tdb.vendor.findUnique({
                where: { id: assessment.vendorId },
                select: { name: true },
            }),
            tdb.vendorAssessmentTemplate.findUnique({
                where: { id: templateVersionId },
                select: {
                    name: true,
                    description: true,
                    sections: {
                        orderBy: { sortOrder: 'asc' },
                        select: {
                            id: true,
                            sortOrder: true,
                            title: true,
                            description: true,
                            questions: {
                                orderBy: { sortOrder: 'asc' },
                                select: {
                                    id: true,
                                    sortOrder: true,
                                    prompt: true,
                                    answerType: true,
                                    required: true,
                                    weight: true,
                                    optionsJson: true,
                                    scaleConfigJson: true,
                                },
                            },
                        },
                    },
                },
            }),
        ]);

        // Existing answers for THIS assessment only — defence in depth
        // against any cross-tenant scan.
        const existingAnswers = await tdb.vendorAssessmentAnswer.findMany({
            where: {
                assessmentId: assessment.id,
                tenantId: assessment.tenantId,
            },
            select: { questionId: true, answerJson: true },
        });

        return { vendor, template, existingAnswers };
    });

    const { vendor, template, existingAnswers } = loaded;
    if (!vendor || !template) {
        throw new ExternalAccessDenied('unknown_assessment');
    }

    return {
        assessmentId: assessment.id,
        status: assessment.status,
        expiresAtIso:
            assessment.externalAccessTokenExpiresAt?.toISOString() ?? null,
        vendor: { name: vendor.name },
        template: {
            name: template.name,
            description: template.description,
            sections: template.sections.map((s) => ({
                id: s.id,
                sortOrder: s.sortOrder,
                title: s.title,
                description: s.description,
                questions: s.questions.map((q) => ({
                    id: q.id,
                    sortOrder: q.sortOrder,
                    prompt: q.prompt,
                    answerType: q.answerType,
                    required: q.required,
                    weight: q.weight,
                    optionsJson: q.optionsJson,
                    scaleConfigJson: q.scaleConfigJson,
                })),
            })),
        },
        answers: existingAnswers.map((a) => ({
            questionId: a.questionId,
            answerJson: a.answerJson,
        })),
    };
}

// ─── 2. submitResponse ─────────────────────────────────────────────

interface QuestionRow {
    id: string;
    answerType: ResponseQuestion['answerType'];
    required: boolean;
    weight: number;
    optionsJson: unknown;
    scaleConfigJson: unknown;
    riskPointsJson: unknown;
}

export async function submitResponse(
    rawToken: string | null | undefined,
    assessmentId: string,
    answers: SubmitAnswerInput[],
): Promise<SubmitResponseResult> {
    const verified = await verifyAccessToken(rawToken, assessmentId);
    if (!verified.ok) throw new ExternalAccessDenied(verified.reason);
    const assessment = verified.assessment;

    if (!assessment.templateVersionId) {
        throw new ExternalAccessDenied('unknown_assessment');
    }

    // Load the canonical question set for the pinned template
    // version. Validation runs against THIS, not whatever the
    // client claims to have answered.
    const templateVersionId = assessment.templateVersionId;
    const externalCtx = makeExternalAuditCtx(assessment.tenantId, assessment.id);
    const questions = (await runInTenantContext(externalCtx, (tdb) =>
        tdb.vendorAssessmentTemplateQuestion.findMany({
            where: {
                templateId: templateVersionId,
                tenantId: assessment.tenantId,
            },
            select: {
                id: true,
                answerType: true,
                required: true,
                weight: true,
                optionsJson: true,
                scaleConfigJson: true,
                riskPointsJson: true,
            },
        }),
    )) as QuestionRow[];

    const questionMap = new Map(questions.map((q) => [q.id, q]));
    const errors: Array<{ questionId: string | null; message: string }> = [];

    // ── Per-answer shape validation ──
    const cleanedAnswers: Array<{
        questionId: string;
        answerJson: unknown;
        computedPoints: number;
        evidenceId: string | null;
    }> = [];
    const seenQuestionIds = new Set<string>();

    for (const incoming of answers) {
        const q = questionMap.get(incoming.questionId);
        if (!q) {
            errors.push({
                questionId: incoming.questionId,
                message: 'Unknown question id',
            });
            continue;
        }
        if (seenQuestionIds.has(incoming.questionId)) {
            errors.push({
                questionId: incoming.questionId,
                message: 'Duplicate answer for question',
            });
            continue;
        }
        seenQuestionIds.add(incoming.questionId);

        const validationError = validateAnswerShape(q, incoming);
        if (validationError) {
            errors.push({
                questionId: q.id,
                message: validationError,
            });
            continue;
        }

        cleanedAnswers.push({
            questionId: q.id,
            // Sanitised at PERSIST, not at render. The reviewer surface
            // reads this row back verbatim, and so would a PDF export or an
            // SDK consumer — sanitising only in the UI would leave the row
            // itself dangerous. Same posture as sharing.ts, which sanitises
            // the equivalent untrusted external input before it lands.
            answerJson: sanitizeAnswerJson(q, incoming.answerJson),
            computedPoints: computeProvisionalPoints(q, incoming),
            evidenceId: incoming.evidenceId ?? null,
        });
    }

    // ── Required-field check ──
    const answeredIds = new Set(cleanedAnswers.map((a) => a.questionId));
    for (const q of questions) {
        if (q.required && !answeredIds.has(q.id)) {
            errors.push({
                questionId: q.id,
                message: 'This question is required',
            });
        }
    }

    // ── evidenceId ownership ──
    // The FK on this column guarantees the Evidence row EXISTS; it says
    // nothing about whose it is. Without this check a respondent could
    // attach any Evidence id they could guess — including one belonging to
    // another tenant — and it would be echoed straight into this tenant's
    // reviewer surface. Same shape as sharing.ts verifying auditPackItemId
    // belongs to the share's pack before writing.
    const claimedEvidenceIds = [
        ...new Set(
            cleanedAnswers
                .map((a) => a.evidenceId)
                .filter((id): id is string => typeof id === 'string'),
        ),
    ];
    if (claimedEvidenceIds.length > 0) {
        const owned = await runInTenantContext(externalCtx, (tdb) =>
            tdb.evidence.findMany({
                where: {
                    id: { in: claimedEvidenceIds },
                    tenantId: assessment.tenantId,
                },
                select: { id: true },
            }),
        );
        const ownedIds = new Set(owned.map((e) => e.id));
        for (const a of cleanedAnswers) {
            if (a.evidenceId && !ownedIds.has(a.evidenceId)) {
                errors.push({
                    questionId: a.questionId,
                    message: 'Unknown evidence reference',
                });
            }
        }
    }

    if (errors.length > 0) {
        throw new ResponseValidationError(errors);
    }

    // ── Persist + transition ──
    // The public flow has no `RequestContext`, so we drive the
    // transaction through the audit-context helper directly. The
    // actor for the audit log is the assessment id itself
    // (external respondent), tenantId is the assessment's.
    const submittedAt = new Date();
    const provisionalScore = cleanedAnswers.reduce(
        (sum, a) => sum + a.computedPoints,
        0,
    );

    return runWithAuditContext(
        {
            tenantId: assessment.tenantId,
            actorUserId: 'external-respondent',
            requestId: `vendor-assessment-submit:${assessment.id}`,
        },
        async () => {
            // runInTenantContext, not a bare prisma.$transaction, so the
            // write path runs as `app_user` with `app.tenant_id` bound —
            // RLS covers the answer upsert, the status transition and the
            // audit insert alike. It re-binds the same audit context, so
            // actor/requestId correlation is preserved.
            await runInTenantContext(externalCtx, async (tx) => {
                // Upsert each answer row; the existing
                // (assessmentId, questionId) unique constraint makes
                // this idempotent for re-submits.
                for (const a of cleanedAnswers) {
                    await tx.vendorAssessmentAnswer.upsert({
                        // Extended where — the compound unique PLUS an
                        // explicit tenantId. RLS already fences this; the
                        // predicate makes the tenant scope legible at the
                        // call site rather than implied by transaction setup.
                        where: {
                            assessmentId_questionId: {
                                assessmentId: assessment.id,
                                questionId: a.questionId,
                            },
                            tenantId: assessment.tenantId,
                        },
                        update: {
                            answerJson: a.answerJson as never,
                            computedPoints: a.computedPoints,
                            evidenceId: a.evidenceId,
                        },
                        create: {
                            tenantId: assessment.tenantId,
                            assessmentId: assessment.id,
                            questionId: a.questionId,
                            templateQuestionId: a.questionId,
                            answerJson: a.answerJson as never,
                            computedPoints: a.computedPoints,
                            evidenceId: a.evidenceId,
                        },
                    });
                }

                await tx.vendorAssessment.update({
                    where: { id: assessment.id, tenantId: assessment.tenantId },
                    data: {
                        status: 'SUBMITTED',
                        submittedAt,
                        score: provisionalScore,
                    },
                });

                // Minimal RequestContext for logEvent — only needs
                // tenantId + userId + requestId. Synthesised here
                // because the public flow has no real auth ctx.
                const auditCtx = makeExternalAuditCtx(
                    assessment.tenantId,
                    assessment.id,
                );
                await logEvent(tx, auditCtx, {
                    action: 'VENDOR_ASSESSMENT_SUBMITTED',
                    entityType: 'VendorAssessment',
                    entityId: assessment.id,
                    details: `External respondent submitted assessment (answers=${cleanedAnswers.length}, score=${provisionalScore})`,
                    detailsJson: {
                        category: 'entity_lifecycle',
                        entityName: 'VendorAssessment',
                        operation: 'submitted',
                        after: {
                            status: 'SUBMITTED',
                            submittedAt: submittedAt.toISOString(),
                            provisionalScore,
                            answerCount: cleanedAnswers.length,
                        },
                        summary: `Vendor assessment submitted by external respondent`,
                    },
                });
            });

            // ── SUBMITTED notification — fired AFTER the
            // transaction commits so a stalled email never holds
            // the assessment row's lock. The assessment.requestedByUserId
            // gets the email; we re-load just the email/name pair we
            // need rather than dragging the full ctx through.
            await notifyAssessmentSubmitted(assessment, provisionalScore);

            return {
                submittedAt,
                status: 'SUBMITTED' as const,
                provisionalScore,
            };
        },
    );
}

/**
 * Best-effort SUBMITTED notification for the internal requester.
 * Failures are logged + swallowed: the assessment is already
 * committed; missing the email is a known-ack flow we'd rather
 * tolerate than reverse the submit.
 */
async function notifyAssessmentSubmitted(
    assessment: { id: string; tenantId: string; requestedByUserId: string },
    provisionalScore: number,
): Promise<void> {
    try {
        const { prisma } = await import('@/lib/prisma');
        const requester = await prisma.user.findUnique({
            where: { id: assessment.requestedByUserId },
            select: { email: true, name: true },
        });
        if (!requester?.email) return;
        const ctx = await loadVendorAssessmentContext(assessment);
        if (!ctx) return;

        await prisma.$transaction(async (tx) => {
            await enqueueEmail(tx, {
                tenantId: assessment.tenantId,
                type: 'VENDOR_ASSESSMENT_SUBMITTED',
                toEmail: requester.email!,
                entityId: assessment.id,
                payload: {
                    requesterName: requester.name ?? 'there',
                    vendorName: ctx.vendorName,
                    templateName: ctx.templateName,
                    submittedAtIso: new Date().toISOString(),
                    reviewUrl: ctx.reviewUrl,
                    submittedScore: provisionalScore,
                },
            });
        });
    } catch (err) {
        logger.warn('vendor-assessment-response: submitted-notify failed', {
            component: 'vendor-assessment-response',
            assessmentId: assessment.id,
            err: err instanceof Error ? err : new Error(String(err)),
        });
    }
}

/**
 * Look up vendor + template + tenant slug for assessment-related
 * email payloads. Returns null when any link is missing.
 */
async function loadVendorAssessmentContext(assessment: {
    id: string;
    tenantId: string;
}): Promise<{
    vendorName: string;
    templateName: string;
    reviewUrl: string;
} | null> {
    const { prisma } = await import('@/lib/prisma');
    const a = await prisma.vendorAssessment.findUnique({
        where: { id: assessment.id },
        select: {
            vendor: { select: { name: true } },
            templateVersion: { select: { name: true } },
            tenant: { select: { slug: true } },
        },
    });
    if (!a?.vendor || !a.templateVersion || !a.tenant) return null;
    // env.APP_URL is the validated source of truth (src/env.ts).

    const { env } = require('@/env') as { env: { APP_URL?: string } };
    const origin = (env.APP_URL ?? '').replace(/\/$/, '');
    const reviewUrl = `${origin}/t/${a.tenant.slug}/admin/vendor-assessment-reviews/${assessment.id}`;
    return {
        vendorName: a.vendor.name,
        templateName: a.templateVersion.name,
        reviewUrl,
    };
}

// ─── Validation helpers ────────────────────────────────────────────

function validateAnswerShape(
    q: QuestionRow,
    incoming: SubmitAnswerInput,
): string | null {
    const v = incoming.answerJson as
        | { value?: unknown }
        | string
        | number
        | boolean
        | unknown[]
        | null
        | undefined;

    switch (q.answerType) {
        case 'YES_NO': {
            const value = extractValue(v);
            if (value !== 'yes' && value !== 'no') {
                return 'YES_NO answers must be "yes" or "no".';
            }
            return null;
        }
        case 'SINGLE_SELECT': {
            const value = extractValue(v);
            const options = parseOptions(q.optionsJson);
            if (typeof value !== 'string') {
                return 'SINGLE_SELECT requires a string value.';
            }
            if (!options.has(value)) {
                return `SINGLE_SELECT value "${value}" is not in the question's options.`;
            }
            return null;
        }
        case 'MULTI_SELECT': {
            const value = extractValue(v);
            const options = parseOptions(q.optionsJson);
            if (!Array.isArray(value)) {
                return 'MULTI_SELECT requires an array value.';
            }
            for (const item of value) {
                if (typeof item !== 'string') {
                    return 'MULTI_SELECT array items must be strings.';
                }
                if (!options.has(item)) {
                    return `MULTI_SELECT item "${item}" is not in the question's options.`;
                }
            }
            return null;
        }
        case 'TEXT': {
            const value = extractValue(v);
            if (typeof value !== 'string') return 'TEXT requires a string value.';
            if (value.length > 10000) return 'TEXT answers must be ≤10000 characters.';
            return null;
        }
        case 'NUMBER': {
            const value = extractValue(v);
            if (typeof value !== 'number' || !Number.isFinite(value)) {
                return 'NUMBER requires a finite numeric value.';
            }
            return null;
        }
        case 'SCALE': {
            const value = extractValue(v);
            const cfg = q.scaleConfigJson as
                | { min?: unknown; max?: unknown }
                | null
                | undefined;
            if (typeof value !== 'number' || !Number.isFinite(value)) {
                return 'SCALE requires a finite numeric value.';
            }
            if (
                !cfg ||
                typeof cfg.min !== 'number' ||
                typeof cfg.max !== 'number'
            ) {
                return 'SCALE question is missing a valid scaleConfigJson.';
            }
            if (value < cfg.min || value > cfg.max) {
                return `SCALE value ${value} is outside [${cfg.min}, ${cfg.max}].`;
            }
            return null;
        }
        case 'FILE_UPLOAD': {
            if (
                incoming.evidenceId !== null &&
                incoming.evidenceId !== undefined &&
                typeof incoming.evidenceId !== 'string'
            ) {
                return 'FILE_UPLOAD evidenceId must be a string.';
            }
            // A required FILE_UPLOAD must carry SOMETHING. The
            // required-field sweep below only asks whether the questionId
            // appears in the payload at all, so `{ questionId, answerJson:
            // null }` satisfied a required upload — the question counted as
            // answered while nothing was attached. Emptiness has to be
            // caught here, where the answer type is known.
            //
            // "Something" is an evidenceId OR a non-empty note, not an
            // evidenceId alone: the respondent surface deliberately ships a
            // note field rather than an uploader at this stage ("File-upload
            // responses are coordinated through your contact… describe the
            // file you intend to share" — external.vendorAssessment
            // .fileUploadHint). Demanding an evidenceId would make every
            // required upload question unsubmittable. Wiring a real
            // anonymous-upload path is its own piece of work: it needs a
            // storage key, an AV gate and a quota before an unauthenticated
            // party can put bytes in the tenant's bucket.
            if (q.required) {
                const note = extractValue(v);
                const hasNote =
                    typeof note === 'string' && note.trim().length > 0;
                if (!incoming.evidenceId && !hasNote) {
                    return 'This question requires an attachment or a note.';
                }
            }
            return null;
        }
    }
}

/**
 * Sanitise respondent-supplied free text before it is persisted.
 *
 * Only TEXT carries arbitrary strings. SINGLE_SELECT / MULTI_SELECT values
 * are validated against the question's own options allowlist, NUMBER and
 * SCALE are numeric, and FILE_UPLOAD carries no text — those are already
 * constrained and pass through untouched.
 *
 * The `{ value: … }` envelope is preserved when present, because
 * `extractValue` and the reviewer surface both accept either shape.
 */
function sanitizeAnswerJson(q: QuestionRow, answerJson: unknown): unknown {
    if (q.answerType !== 'TEXT') return answerJson;

    if (typeof answerJson === 'string') return sanitizePlainText(answerJson);

    if (
        answerJson !== null &&
        typeof answerJson === 'object' &&
        !Array.isArray(answerJson) &&
        'value' in (answerJson as object)
    ) {
        const envelope = answerJson as { value: unknown };
        if (typeof envelope.value === 'string') {
            return { ...envelope, value: sanitizePlainText(envelope.value) };
        }
    }

    return answerJson;
}

function extractValue(v: unknown): unknown {
    if (
        v !== null &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        'value' in (v as object)
    ) {
        return (v as { value: unknown }).value;
    }
    return v;
}

function parseOptions(optionsJson: unknown): Set<string> {
    if (!Array.isArray(optionsJson)) return new Set();
    const out = new Set<string>();
    for (const item of optionsJson) {
        if (
            item &&
            typeof item === 'object' &&
            'value' in (item as object)
        ) {
            const value = (item as { value: unknown }).value;
            if (typeof value === 'string') out.add(value);
        }
    }
    return out;
}

/**
 * Provisional point computation. Mirrors the existing scoring
 * service for the legacy flow (`computeAnswerPoints`) but inlined
 * here so the public path doesn't depend on the legacy module.
 *
 * Final scoring + reviewer overrides happen in a later G-3 prompt.
 */
function computeProvisionalPoints(
    q: QuestionRow,
    incoming: SubmitAnswerInput,
): number {
    const value = extractValue(incoming.answerJson);
    const weight = q.weight ?? 1;

    // SINGLE_SELECT / MULTI_SELECT — sum points from matching options.
    if (q.answerType === 'SINGLE_SELECT' || q.answerType === 'MULTI_SELECT') {
        const points = optionPoints(q.optionsJson, value);
        return points * weight;
    }
    // SCALE — value is the points; weight applied.
    if (q.answerType === 'SCALE' && typeof value === 'number') {
        return value * weight;
    }
    // YES_NO — try the riskPointsJson legacy map.
    if (q.answerType === 'YES_NO') {
        const map = q.riskPointsJson as Record<string, number> | null;
        if (map && typeof value === 'string' && typeof map[value] === 'number') {
            return map[value] * weight;
        }
    }
    return 0;
}

function optionPoints(optionsJson: unknown, value: unknown): number {
    if (!Array.isArray(optionsJson)) return 0;
    const wanted = new Set<string>();
    if (typeof value === 'string') wanted.add(value);
    else if (Array.isArray(value)) {
        for (const v of value) if (typeof v === 'string') wanted.add(v);
    } else return 0;

    let points = 0;
    for (const item of optionsJson) {
        if (item && typeof item === 'object' && 'value' in (item as object)) {
            const v = (item as { value: unknown }).value;
            const p = (item as { points?: unknown }).points;
            if (typeof v === 'string' && wanted.has(v) && typeof p === 'number') {
                points += p;
            }
        }
    }
    return points;
}
