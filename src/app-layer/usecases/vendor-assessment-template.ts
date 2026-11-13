/**
 * Epic G-3 — Vendor Assessment Template Authoring usecases.
 *
 * Four entry points sit beneath the future template-builder UI:
 *
 *   • createTemplate   — new draft template (version=1, unpublished).
 *   • addSection       — append a section to an unpublished template.
 *   • addQuestion      — append a question to a section, with
 *                        per-answerType cross-field validation.
 *   • cloneTemplate    — full deep copy under a new id graph.
 *                        SAME_KEY_NEW_VERSION for safe-edit; NEW_KEY
 *                        for a separate template family.
 *
 * ═══════════════════════════════════════════════════════════════════
 * EDIT SAFETY
 * ═══════════════════════════════════════════════════════════════════
 *
 * Once a template is published, it is read-only. Live assessments
 * pin to a specific version via `VendorAssessment.templateVersionId`,
 * so a caller wanting to change a published template must clone it
 * first — `addSection`/`addQuestion` reject writes to a published
 * template with a clear "clone first" error. The publish guard +
 * version pinning together guarantee no in-flight assessment can
 * be silently mutated by an admin's edit.
 *
 * ═══════════════════════════════════════════════════════════════════
 * CLONE SEMANTICS
 * ═══════════════════════════════════════════════════════════════════
 *
 *   SAME_KEY_NEW_VERSION:
 *     • New row with key=source.key, version=source.version+1
 *     • New template's isLatestVersion=true
 *     • Source row's isLatestVersion flips to false
 *     • Sections + questions deep-copied with fresh ids
 *
 *   NEW_KEY:
 *     • New row with caller-supplied key, version=1
 *     • Source row untouched (still latest of its own family)
 *     • Sections + questions deep-copied with fresh ids
 *
 * Both modes produce templates with isPublished=false so the
 * authoring flow always starts in draft.
 *
 * ═══════════════════════════════════════════════════════════════════
 * ORDERING
 * ═══════════════════════════════════════════════════════════════════
 *
 * `sortOrder` is the canonical position field. When a caller doesn't
 * supply one, the usecase assigns `max(siblings)+1` so new entries
 * always land at the bottom. Future drag-and-drop reorder will
 * rewrite sortOrder in batch via a separate `reorder*` usecase
 * (out of scope for this prompt).
 *
 * @module usecases/vendor-assessment-template
 */
import type { RequestContext } from '../types';
import { Prisma, type AnswerType } from '@prisma/client';
import { runInTenantContext } from '@/lib/db-context';
import { notFound, badRequest } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { logEvent } from '../events/audit';
import { assertCanManageVendorAssessmentTemplates } from '../policies/vendor.policies';

// ─── Public input shapes ───────────────────────────────────────────

export interface CreateTemplateInput {
    key: string;
    name: string;
    description?: string | null;
    isGlobal?: boolean;
}

export interface AddSectionInput {
    title: string;
    description?: string | null;
    weight?: number | null;
    /** Optional explicit position. Defaults to max(siblings)+1. */
    sortOrder?: number;
}

export interface AddQuestionInput {
    prompt: string;
    answerType: AnswerType;
    required?: boolean;
    weight?: number;
    optionsJson?: unknown;
    scaleConfigJson?: unknown;
    riskPointsJson?: unknown;
    /** Optional explicit position. Defaults to max(siblings)+1. */
    sortOrder?: number;
}

export interface CloneTemplateInput {
    mode: 'SAME_KEY_NEW_VERSION' | 'NEW_KEY';
    /** Required for NEW_KEY mode. Ignored for SAME_KEY_NEW_VERSION. */
    key?: string;
    /** Optional name override. Defaults to source name. */
    name?: string;
    /** Optional description override. Pass null to clear. */
    description?: string | null;
}

// ─── Helpers ───────────────────────────────────────────────────────

/**
 * Canonicalise a user-supplied key into kebab-case ASCII so the
 * unique-by-(tenant,key,version) index isn't undermined by
 * "Security Q" vs "security-q" variations.
 */
function canonicaliseKey(raw: string): string {
    return raw
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 120);
}

const CHOICE_TYPES: ReadonlySet<AnswerType> = new Set<AnswerType>([
    'SINGLE_SELECT',
    'MULTI_SELECT',
]);

/**
 * Per-answerType cross-field validation. Throws badRequest with a
 * sentence the builder can show as it is (#4934) — the schema layer just
 * shape-checks. Runs over the question as it will be STORED, so an edit
 * that changes only the type is judged with the options it keeps.
 */
function validateQuestionConfig(input: {
    answerType: AnswerType;
    optionsJson?: unknown;
    scaleConfigJson?: unknown;
}): void {
    if (CHOICE_TYPES.has(input.answerType)) {
        const options = Array.isArray(input.optionsJson) ? input.optionsJson : [];
        if (options.length === 0) {
            throw badRequest(
                'A single-choice or multiple-choice question needs at least one option.',
            );
        }
        const values = new Set<string>();
        for (const o of options as Array<{ value?: unknown }>) {
            const v = typeof o?.value === 'string' ? o.value : '';
            if (values.has(v)) {
                throw badRequest('Two options of this question are the same. Give each option its own wording.');
            }
            values.add(v);
        }
    }
    if (input.answerType === 'SCALE') {
        const cfg = input.scaleConfigJson as
            | { min?: unknown; max?: unknown }
            | null
            | undefined;
        if (
            !cfg ||
            typeof cfg.min !== 'number' ||
            typeof cfg.max !== 'number'
        ) {
            throw badRequest(
                'A scale question needs a lowest and a highest value.',
            );
        }
        if ((cfg.min as number) >= (cfg.max as number)) {
            throw badRequest(
                'The lowest value of a scale must be below its highest value.',
            );
        }
    }
}

/**
 * The options and scale a question of this type STORES (#4934): a choice
 * question keeps its options and no scale, a scale question its scale and
 * no options, and any other type neither — so changing a question from a
 * choice to "Yes or no" does not leave options behind that nothing shows.
 * Option labels and scale end labels are vendor-facing text, sanitised as
 * the prompt is. `undefined` leaves the column untouched on an update.
 */
function storedConfigFor(
    answerType: AnswerType,
    optionsJson: unknown,
    scaleConfigJson: unknown,
): { optionsJson: unknown; scaleConfigJson: unknown } {
    const options = CHOICE_TYPES.has(answerType) && Array.isArray(optionsJson)
        ? (optionsJson as Array<{ label: string; value: string; points?: number }>).map((o) => ({
              label: sanitizePlainText(o.label),
              value: o.value,
              ...(typeof o.points === 'number' ? { points: o.points } : {}),
          }))
        : null;
    const cfg = scaleConfigJson as { min: number; max: number; labels?: string[] } | null | undefined;
    const scale = answerType === 'SCALE' && cfg
        ? {
              min: cfg.min,
              max: cfg.max,
              ...(cfg.labels ? { labels: cfg.labels.map((l) => sanitizePlainText(l)) } : {}),
          }
        : null;
    return { optionsJson: options, scaleConfigJson: scale };
}

// ─── 1. createTemplate ─────────────────────────────────────────────

export async function createTemplate(
    ctx: RequestContext,
    input: CreateTemplateInput,
) {
    assertCanManageVendorAssessmentTemplates(ctx);
    const key = canonicaliseKey(input.key);
    if (key.length === 0) {
        throw badRequest(
            'Template key must contain at least one alphanumeric character.',
        );
    }

    return runInTenantContext(ctx, async (db) => {
        const template = await db.vendorAssessmentTemplate.create({
            data: {
                tenantId: ctx.tenantId,
                key,
                version: 1,
                isLatestVersion: true,
                isPublished: false,
                isGlobal: input.isGlobal ?? false,
                name: sanitizePlainText(input.name),
                description: input.description
                    ? sanitizePlainText(input.description)
                    : null,
                createdByUserId: ctx.userId,
            },
        });

        await logEvent(db, ctx, {
            action: 'VENDOR_ASSESSMENT_TEMPLATE_CREATED',
            entityType: 'VendorAssessmentTemplate',
            entityId: template.id,
            details: `Created template "${template.name}" (key=${key}, v1)`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'VendorAssessmentTemplate',
                operation: 'created',
                after: {
                    key,
                    version: 1,
                    name: template.name,
                    isGlobal: template.isGlobal,
                },
                summary: `Vendor questionnaire template created`,
            },
        });

        return template;
    });
}

// ─── 2. addSection ─────────────────────────────────────────────────

export async function addSection(
    ctx: RequestContext,
    templateId: string,
    input: AddSectionInput,
) {
    assertCanManageVendorAssessmentTemplates(ctx);

    return runInTenantContext(ctx, async (db) => {
        const template = await db.vendorAssessmentTemplate.findFirst({
            where: { id: templateId, tenantId: ctx.tenantId },
            select: { id: true, isPublished: true, name: true },
        });
        if (!template) throw notFound('Template not found');
        assertEditable(template);

        const sortOrder =
            input.sortOrder !== undefined
                ? input.sortOrder
                : await nextSectionSortOrder(db, templateId, ctx.tenantId);

        const section = await db.vendorAssessmentTemplateSection.create({
            data: {
                tenantId: ctx.tenantId,
                templateId,
                sortOrder,
                title: sanitizePlainText(input.title),
                description: input.description
                    ? sanitizePlainText(input.description)
                    : null,
                weight: input.weight ?? null,
            },
        });

        await logEvent(db, ctx, {
            action: 'VENDOR_ASSESSMENT_TEMPLATE_SECTION_ADDED',
            entityType: 'VendorAssessmentTemplateSection',
            entityId: section.id,
            details: `Added section "${section.title}" to template ${templateId}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'VendorAssessmentTemplateSection',
                operation: 'created',
                after: {
                    templateId,
                    sortOrder,
                    title: section.title,
                },
                summary: `Section added to vendor questionnaire template`,
            },
        });

        return section;
    });
}

// ─── 3. addQuestion ────────────────────────────────────────────────

export async function addQuestion(
    ctx: RequestContext,
    sectionId: string,
    input: AddQuestionInput,
) {
    assertCanManageVendorAssessmentTemplates(ctx);
    validateQuestionConfig(input);

    return runInTenantContext(ctx, async (db) => {
        const section = await db.vendorAssessmentTemplateSection.findFirst({
            where: { id: sectionId, tenantId: ctx.tenantId },
            select: {
                id: true,
                templateId: true,
                template: { select: { isPublished: true, name: true } },
            },
        });
        if (!section) throw notFound('Section not found');
        if (!section.template) throw notFound('Template not found');
        assertEditable(section.template);

        const sortOrder =
            input.sortOrder !== undefined
                ? input.sortOrder
                : await nextQuestionSortOrder(db, sectionId, ctx.tenantId);

        const stored = storedConfigFor(
            input.answerType,
            input.optionsJson,
            input.scaleConfigJson,
        );
        const question = await db.vendorAssessmentTemplateQuestion.create({
            data: {
                tenantId: ctx.tenantId,
                templateId: section.templateId,
                sectionId,
                sortOrder,
                prompt: sanitizePlainText(input.prompt),
                answerType: input.answerType,
                required: input.required ?? true,
                weight: input.weight ?? 1,
                optionsJson: (stored.optionsJson ?? Prisma.DbNull) as never,
                scaleConfigJson: (stored.scaleConfigJson ?? Prisma.DbNull) as never,
                riskPointsJson:
                    input.riskPointsJson === undefined
                        ? undefined
                        : (input.riskPointsJson as never),
            },
        });

        await logEvent(db, ctx, {
            action: 'VENDOR_ASSESSMENT_TEMPLATE_QUESTION_ADDED',
            entityType: 'VendorAssessmentTemplateQuestion',
            entityId: question.id,
            details: `Added ${input.answerType} question to section ${sectionId}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'VendorAssessmentTemplateQuestion',
                operation: 'created',
                after: {
                    templateId: section.templateId,
                    sectionId,
                    sortOrder,
                    answerType: input.answerType,
                },
                summary: `Question added to vendor questionnaire template`,
            },
        });

        return question;
    });
}

// ─── 3a. Edit and remove in a draft (#4934) ───────────────────────
//
// A draft's sections and questions can be changed and removed; a published
// template's cannot (assertEditable, the same clone-first contract as every
// other edit). Each verb reads its row by (id, tenant, template) together,
// so a section or question id from another template in the URL is a 404
// rather than an edit of that template. A draft has never been sent — the
// send refuses an unpublished template — so no assessment answers point at
// what is removed.

export interface UpdateSectionInput {
    title?: string;
    description?: string | null;
    weight?: number | null;
}

export async function updateSection(
    ctx: RequestContext,
    templateId: string,
    sectionId: string,
    input: UpdateSectionInput,
) {
    assertCanManageVendorAssessmentTemplates(ctx);

    return runInTenantContext(ctx, async (db) => {
        const section = await db.vendorAssessmentTemplateSection.findFirst({
            where: { id: sectionId, templateId, tenantId: ctx.tenantId },
            select: {
                id: true,
                title: true,
                template: { select: { isPublished: true, name: true } },
            },
        });
        if (!section) throw notFound('Section not found');
        assertEditable(section.template);

        const data: { title?: string; description?: string | null; weight?: number | null } = {};
        if (input.title !== undefined) data.title = sanitizePlainText(input.title);
        if (input.description !== undefined) {
            data.description = input.description ? sanitizePlainText(input.description) : null;
        }
        if (input.weight !== undefined) data.weight = input.weight;

        const updated = await db.vendorAssessmentTemplateSection.update({
            where: { id: section.id },
            data,
        });

        await logEvent(db, ctx, {
            action: 'VENDOR_ASSESSMENT_TEMPLATE_SECTION_UPDATED',
            entityType: 'VendorAssessmentTemplateSection',
            entityId: section.id,
            details: `Updated section "${updated.title}" of template ${templateId}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'VendorAssessmentTemplateSection',
                operation: 'updated',
                after: { templateId, fields: Object.keys(data) },
                summary: `Section of vendor questionnaire template updated`,
            },
        });

        return updated;
    });
}

export async function deleteSection(
    ctx: RequestContext,
    templateId: string,
    sectionId: string,
) {
    assertCanManageVendorAssessmentTemplates(ctx);

    return runInTenantContext(ctx, async (db) => {
        const section = await db.vendorAssessmentTemplateSection.findFirst({
            where: { id: sectionId, templateId, tenantId: ctx.tenantId },
            select: {
                id: true,
                title: true,
                template: { select: { isPublished: true, name: true } },
                _count: { select: { questions: true } },
            },
        });
        if (!section) throw notFound('Section not found');
        assertEditable(section.template);

        // The section's questions go with it (ON DELETE CASCADE).
        await db.vendorAssessmentTemplateSection.delete({ where: { id: section.id } });

        await logEvent(db, ctx, {
            action: 'VENDOR_ASSESSMENT_TEMPLATE_SECTION_DELETED',
            entityType: 'VendorAssessmentTemplateSection',
            entityId: section.id,
            details: `Removed section "${section.title}" and its ${section._count.questions} question(s) from template ${templateId}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'VendorAssessmentTemplateSection',
                operation: 'deleted',
                before: {
                    templateId,
                    title: section.title,
                    questionCount: section._count.questions,
                },
                summary: `Section removed from vendor questionnaire template`,
            },
        });

        return { id: section.id, questionsRemoved: section._count.questions };
    });
}

export interface UpdateQuestionInput {
    prompt?: string;
    answerType?: AnswerType;
    required?: boolean;
    weight?: number;
    optionsJson?: unknown;
    scaleConfigJson?: unknown;
}

export async function updateQuestion(
    ctx: RequestContext,
    templateId: string,
    questionId: string,
    input: UpdateQuestionInput,
) {
    assertCanManageVendorAssessmentTemplates(ctx);

    return runInTenantContext(ctx, async (db) => {
        const question = await db.vendorAssessmentTemplateQuestion.findFirst({
            where: { id: questionId, templateId, tenantId: ctx.tenantId },
            select: {
                id: true,
                answerType: true,
                optionsJson: true,
                scaleConfigJson: true,
                template: { select: { isPublished: true, name: true } },
            },
        });
        if (!question) throw notFound('Question not found');
        assertEditable(question.template);

        // Judge the question as it will be stored: an absent field keeps
        // its stored value.
        const answerType = input.answerType ?? question.answerType;
        const optionsJson = input.optionsJson !== undefined ? input.optionsJson : question.optionsJson;
        const scaleConfigJson =
            input.scaleConfigJson !== undefined ? input.scaleConfigJson : question.scaleConfigJson;
        validateQuestionConfig({ answerType, optionsJson, scaleConfigJson });
        const stored = storedConfigFor(answerType, optionsJson, scaleConfigJson);

        const data: Prisma.VendorAssessmentTemplateQuestionUpdateInput = {
            answerType,
            optionsJson: (stored.optionsJson ?? Prisma.DbNull) as never,
            scaleConfigJson: (stored.scaleConfigJson ?? Prisma.DbNull) as never,
        };
        if (input.prompt !== undefined) data.prompt = sanitizePlainText(input.prompt);
        if (input.required !== undefined) data.required = input.required;
        if (input.weight !== undefined) data.weight = input.weight;

        const updated = await db.vendorAssessmentTemplateQuestion.update({
            where: { id: question.id },
            data,
        });

        await logEvent(db, ctx, {
            action: 'VENDOR_ASSESSMENT_TEMPLATE_QUESTION_UPDATED',
            entityType: 'VendorAssessmentTemplateQuestion',
            entityId: question.id,
            details: `Updated ${answerType} question of template ${templateId}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'VendorAssessmentTemplateQuestion',
                operation: 'updated',
                before: { answerType: question.answerType },
                after: {
                    templateId,
                    answerType,
                    fields: Object.keys(input).filter(
                        (k) => (input as Record<string, unknown>)[k] !== undefined,
                    ),
                },
                summary: `Question of vendor questionnaire template updated`,
            },
        });

        return updated;
    });
}

export async function deleteQuestion(
    ctx: RequestContext,
    templateId: string,
    questionId: string,
) {
    assertCanManageVendorAssessmentTemplates(ctx);

    return runInTenantContext(ctx, async (db) => {
        const question = await db.vendorAssessmentTemplateQuestion.findFirst({
            where: { id: questionId, templateId, tenantId: ctx.tenantId },
            select: {
                id: true,
                sectionId: true,
                answerType: true,
                template: { select: { isPublished: true, name: true } },
            },
        });
        if (!question) throw notFound('Question not found');
        assertEditable(question.template);

        await db.vendorAssessmentTemplateQuestion.delete({ where: { id: question.id } });

        await logEvent(db, ctx, {
            action: 'VENDOR_ASSESSMENT_TEMPLATE_QUESTION_DELETED',
            entityType: 'VendorAssessmentTemplateQuestion',
            entityId: question.id,
            details: `Removed ${question.answerType} question from template ${templateId}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'VendorAssessmentTemplateQuestion',
                operation: 'deleted',
                before: {
                    templateId,
                    sectionId: question.sectionId,
                    answerType: question.answerType,
                },
                summary: `Question removed from vendor questionnaire template`,
            },
        });

        return { id: question.id };
    });
}

// ─── 4. cloneTemplate ──────────────────────────────────────────────

export async function cloneTemplate(
    ctx: RequestContext,
    sourceTemplateId: string,
    input: CloneTemplateInput,
) {
    assertCanManageVendorAssessmentTemplates(ctx);
    if (input.mode === 'NEW_KEY') {
        if (!input.key || canonicaliseKey(input.key).length === 0) {
            throw badRequest(
                'NEW_KEY clone requires a non-empty `key` on the input.',
            );
        }
    }

    return runInTenantContext(ctx, async (db) => {
        const source = await db.vendorAssessmentTemplate.findFirst({
            where: { id: sourceTemplateId, tenantId: ctx.tenantId },
            include: {
                sections: { orderBy: { sortOrder: 'asc' } },
                questions: { orderBy: { sortOrder: 'asc' } },
            },
        });
        if (!source) throw notFound('Source template not found');

        const targetKey =
            input.mode === 'NEW_KEY'
                ? canonicaliseKey(input.key!)
                : source.key;
        const targetVersion =
            input.mode === 'NEW_KEY' ? 1 : source.version + 1;

        // For SAME_KEY_NEW_VERSION we flip the previous latest's
        // flag to false so the (tenantId, isLatestVersion=true)
        // dashboard query returns exactly one row per key.
        if (input.mode === 'SAME_KEY_NEW_VERSION') {
            await db.vendorAssessmentTemplate.updateMany({
                where: {
                    tenantId: ctx.tenantId,
                    key: source.key,
                    isLatestVersion: true,
                },
                data: { isLatestVersion: false },
            });
        }

        const newName = input.name
            ? sanitizePlainText(input.name)
            : source.name;
        const newDescription =
            input.description === undefined
                ? source.description
                : input.description === null
                    ? null
                    : sanitizePlainText(input.description);

        const cloned = await db.vendorAssessmentTemplate.create({
            data: {
                tenantId: ctx.tenantId,
                key: targetKey,
                version: targetVersion,
                isLatestVersion: true,
                // Always start clones unpublished — that's the
                // safe-edit invariant: a clone is meant for editing,
                // and editing requires unpublished state.
                isPublished: false,
                isGlobal: source.isGlobal,
                name: newName,
                description: newDescription,
                createdByUserId: ctx.userId,
            },
        });

        // Section + question deep-copy. Build a sourceSectionId →
        // newSectionId map so questions can re-attach to their new
        // section parent.
        const sectionIdMap = new Map<string, string>();
        for (const section of source.sections) {
            const newSection = await db.vendorAssessmentTemplateSection.create({
                data: {
                    tenantId: ctx.tenantId,
                    templateId: cloned.id,
                    sortOrder: section.sortOrder,
                    title: section.title,
                    description: section.description,
                    weight: section.weight,
                },
            });
            sectionIdMap.set(section.id, newSection.id);
        }
        for (const question of source.questions) {
            const newSectionId = sectionIdMap.get(question.sectionId);
            if (!newSectionId) {
                // Should be impossible given the FK from Question →
                // Section, but guard against orphan rows defensively.
                continue;
            }
            await db.vendorAssessmentTemplateQuestion.create({
                data: {
                    tenantId: ctx.tenantId,
                    templateId: cloned.id,
                    sectionId: newSectionId,
                    sortOrder: question.sortOrder,
                    prompt: question.prompt,
                    answerType: question.answerType,
                    required: question.required,
                    weight: question.weight,
                    optionsJson:
                        question.optionsJson === null
                            ? undefined
                            : (question.optionsJson as never),
                    scaleConfigJson:
                        question.scaleConfigJson === null
                            ? undefined
                            : (question.scaleConfigJson as never),
                    riskPointsJson:
                        question.riskPointsJson === null
                            ? undefined
                            : (question.riskPointsJson as never),
                },
            });
        }

        await logEvent(db, ctx, {
            action: 'VENDOR_ASSESSMENT_TEMPLATE_CLONED',
            entityType: 'VendorAssessmentTemplate',
            entityId: cloned.id,
            details:
                `Cloned template ${sourceTemplateId} → ${cloned.id} ` +
                `(mode=${input.mode}, key=${targetKey}, v${targetVersion})`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'VendorAssessmentTemplate',
                operation: 'cloned',
                after: {
                    sourceId: sourceTemplateId,
                    mode: input.mode,
                    key: targetKey,
                    version: targetVersion,
                    sectionCount: source.sections.length,
                    questionCount: source.questions.length,
                },
                summary: `Vendor questionnaire template cloned`,
            },
        });

        return cloned;
    });
}

// ─── Local helpers ─────────────────────────────────────────────────

function assertEditable(template: { isPublished: boolean; name: string }) {
    if (template.isPublished) {
        throw badRequest(
            `"${template.name}" is published and can no longer be changed. ` +
                `Make a new draft from it to edit it.`,
        );
    }
}

async function nextSectionSortOrder(
    db: Parameters<Parameters<typeof runInTenantContext>[1]>[0],
    templateId: string,
    tenantId: string,
): Promise<number> {
    const max = await db.vendorAssessmentTemplateSection.aggregate({
        _max: { sortOrder: true },
        where: { templateId, tenantId },
    });
    return (max._max.sortOrder ?? -1) + 1;
}

async function nextQuestionSortOrder(
    db: Parameters<Parameters<typeof runInTenantContext>[1]>[0],
    sectionId: string,
    tenantId: string,
): Promise<number> {
    const max = await db.vendorAssessmentTemplateQuestion.aggregate({
        _max: { sortOrder: true },
        where: { sectionId, tenantId },
    });
    return (max._max.sortOrder ?? -1) + 1;
}

// ─── 5. reorderTemplate ────────────────────────────────────────────

export interface ReorderInput {
    /// New section order. Each entry's sortOrder is the new position.
    /// Questions inside a section may also rebalance their sortOrder
    /// AND optionally migrate to a different section.
    sections: Array<{
        id: string;
        sortOrder: number;
        questions?: Array<{
            id: string;
            sectionId: string;
            sortOrder: number;
        }>;
    }>;
}

/**
 * Apply a batched reorder produced by the drag-and-drop builder.
 * Every section + question gets its `sortOrder` rewritten, and
 * questions can migrate across sections via the `sectionId` field.
 *
 * Publish-guard: rejects if the template is published. Reorder is
 * an edit; the same clone-first contract applies.
 */
export async function reorderTemplate(
    ctx: RequestContext,
    templateId: string,
    input: ReorderInput,
) {
    assertCanManageVendorAssessmentTemplates(ctx);

    return runInTenantContext(ctx, async (db) => {
        const template = await db.vendorAssessmentTemplate.findFirst({
            where: { id: templateId, tenantId: ctx.tenantId },
            select: { id: true, isPublished: true, name: true },
        });
        if (!template) throw notFound('Template not found');
        assertEditable(template);

        // Every section a question is moved INTO must belong to this template
        // (#5155). The updates below scope the question by template, but its new
        // `sectionId` was written as given, so a question could be moved into
        // another template's section — a published one included.
        const targetSectionIds = [
            ...new Set(input.sections.flatMap((s) => (s.questions ?? []).map((q) => q.sectionId))),
        ];
        if (targetSectionIds.length > 0) {
            const owned = await db.vendorAssessmentTemplateSection.count({
                where: { id: { in: targetSectionIds }, tenantId: ctx.tenantId, templateId },
            });
            if (owned !== targetSectionIds.length) {
                throw badRequest('A question can only be moved into a section of the same template.');
            }
        }

        // Apply section + question rewrites in a single sweep. Each
        // updateMany scopes to (id, tenantId, templateId) so a
        // tampered sectionId / questionId in the input cannot mutate
        // rows in another template.
        for (const s of input.sections) {
            await db.vendorAssessmentTemplateSection.updateMany({
                where: {
                    id: s.id,
                    tenantId: ctx.tenantId,
                    templateId,
                },
                data: { sortOrder: s.sortOrder },
            });
            if (s.questions) {
                for (const q of s.questions) {
                    await db.vendorAssessmentTemplateQuestion.updateMany({
                        where: {
                            id: q.id,
                            tenantId: ctx.tenantId,
                            templateId,
                        },
                        data: {
                            sectionId: q.sectionId,
                            sortOrder: q.sortOrder,
                        },
                    });
                }
            }
        }

        await logEvent(db, ctx, {
            action: 'VENDOR_ASSESSMENT_TEMPLATE_REORDERED',
            entityType: 'VendorAssessmentTemplate',
            entityId: templateId,
            details: `Reordered ${input.sections.length} section(s)`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'VendorAssessmentTemplate',
                operation: 'reordered',
                after: {
                    sectionCount: input.sections.length,
                    questionCount: input.sections.reduce(
                        (n, s) => n + (s.questions?.length ?? 0),
                        0,
                    ),
                },
                summary: `Vendor questionnaire template reordered`,
            },
        });

        return { id: templateId };
    });
}

// ─── 6. getTemplateTree ────────────────────────────────────────────

/**
 * Read-side helper for the builder UI — full template tree with
 * sections + questions ordered by sortOrder. Mirrors the public
 * response-flow loader but without the token gate.
 */
export async function getTemplateTree(
    ctx: RequestContext,
    templateId: string,
) {
    if (!ctx.permissions.canRead) {
        throw badRequest('Read access required.');
    }
    return runInTenantContext(ctx, async (db) => {
        const template = await db.vendorAssessmentTemplate.findFirst({
            where: { id: templateId, tenantId: ctx.tenantId },
            include: {
                sections: { orderBy: { sortOrder: 'asc' } },
                questions: { orderBy: { sortOrder: 'asc' } },
            },
        });
        if (!template) throw notFound('Template not found');
        return template;
    });
}

// ─── 7. publishTemplate ────────────────────────────────────────────

/**
 * Flip an unpublished draft to `isPublished=true`, making it selectable
 * in the send-assessment flow. Publishing is a one-way status change:
 * once published the template is read-only (the publish-guard rejects
 * every mutating usecase), and a live assessment pins to a specific
 * version — so an admin who wants further edits must clone first.
 *
 * Guards:
 *   • 404 if the template is missing / in another tenant.
 *   • `ALREADY_PUBLISHED` if it is already published (idempotency guard
 *     — a double-publish is a client bug, not a silent no-op).
 *   • `EMPTY_TEMPLATE` if it has zero questions — an empty questionnaire
 *     is never a valid thing to send to a vendor.
 */
export async function publishTemplate(
    ctx: RequestContext,
    templateId: string,
) {
    assertCanManageVendorAssessmentTemplates(ctx);

    return runInTenantContext(ctx, async (db) => {
        const template = await db.vendorAssessmentTemplate.findFirst({
            where: { id: templateId, tenantId: ctx.tenantId },
            select: {
                id: true,
                key: true,
                version: true,
                name: true,
                isPublished: true,
                _count: { select: { questions: true } },
            },
        });
        if (!template) throw notFound('Template not found');
        if (template.isPublished) {
            throw badRequest(
                'ALREADY_PUBLISHED',
                `Template "${template.name}" is already published.`,
            );
        }
        if (template._count.questions === 0) {
            throw badRequest(
                'EMPTY_TEMPLATE',
                'Cannot publish a template with no questions',
            );
        }

        const updated = await db.vendorAssessmentTemplate.update({
            where: { id: templateId },
            data: { isPublished: true },
            select: { id: true, isPublished: true },
        });

        await logEvent(db, ctx, {
            action: 'VENDOR_ASSESSMENT_TEMPLATE_PUBLISHED',
            entityType: 'VendorAssessmentTemplate',
            entityId: templateId,
            details:
                `Published template "${template.name}" ` +
                `(key=${template.key}, v${template.version}, ` +
                `${template._count.questions} question(s))`,
            detailsJson: {
                category: 'status_change',
                entityName: 'VendorAssessmentTemplate',
                fromStatus: 'draft',
                toStatus: 'published',
                reason: `Vendor questionnaire template published (key=${template.key}, v${template.version})`,
            },
        });

        return updated;
    });
}

/** List templates for the admin index page. */
export async function listTemplates(ctx: RequestContext) {
    if (!ctx.permissions.canRead) {
        throw badRequest('Read access required.');
    }
    return runInTenantContext(ctx, async (db) => {
        return db.vendorAssessmentTemplate.findMany({
            where: { tenantId: ctx.tenantId, isLatestVersion: true },
            select: {
                id: true,
                key: true,
                version: true,
                name: true,
                description: true,
                isPublished: true,
                isGlobal: true,
                createdAt: true,
                updatedAt: true,
                _count: { select: { sections: true, questions: true } },
            },
            orderBy: { updatedAt: 'desc' },
        });
    });
}
