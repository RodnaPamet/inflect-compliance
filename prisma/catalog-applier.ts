/**
 * Catalog applier — the write-side of the YAML/JSON ingestion
 * boundary in `prisma/catalog-loader.ts`.
 *
 * Given a parsed `CatalogFile` (the output of `loadCatalogFile`),
 * upsert the rows into the global catalog tables in the same order
 * `seed-catalog.ts` already does:
 *
 *   1. Framework               (upsert on `key_version`)
 *   2. FrameworkRequirement[]  (upsert on `frameworkId_code`)
 *   3. ControlTemplate[]       (create-if-missing on `code`)
 *   4. ControlTemplateTask[]   (default 5-task playbook per template)
 *   5. ControlTemplateRequirementLink[]  (template ↔ requirement edges)
 *   6. FrameworkPack           (upsert on `key`)
 *   7. PackTemplateLink[]      (upsert on composite key)
 *
 * Idempotent — safe to re-run. Rows are upsert-or-skip-if-exists, so
 * a re-run of the same catalog file is a no-op apart from updating
 * mutable fields (titles, descriptions, sortOrder).
 *
 * @module prisma/catalog-applier
 */
import type { PrismaClient } from '@prisma/client';
import {
    type CatalogFile,
    assertCatalogConsistency,
} from './catalog-loader';
import { GENERIC_TEMPLATE_TASKS } from './generic-template-tasks';
import { taskContentHash } from './catalog-loader';


/** What one template's task reconcile did. */
export interface TaskReconcileResult {
    created: number;
    updated: number;
    deprecated: number;
    unchanged: number;
}

function addReconcile(a: TaskReconcileResult, b: TaskReconcileResult): TaskReconcileResult {
    return {
        created: a.created + b.created,
        updated: a.updated + b.updated,
        deprecated: a.deprecated + b.deprecated,
        unchanged: a.unchanged + b.unchanged,
    };
}

/** The authored-task shape this file receives from the loader. */
export type AuthoredTask = {
    title: { en: string; bg?: string };
    description: { en: string; bg?: string };
    phase: 'SCOPE' | 'IMPLEMENT' | 'OPERATE' | 'REVIEW';
    steps?: Array<{ text: { en: string; bg?: string }; hint?: { en: string; bg?: string } }>;
    evidenceHint?: { en: string; bg?: string };
    suggestedRole?: string;
    sortOrder: number;
};

/**
 * Reconcile one template's tasks against its authored content.
 *
 * Keyed on `(templateId, contentHash)`, four outcomes:
 *
 *   unchanged   the hash is already on a live row  -> skip
 *   new         the hash is absent                 -> create
 *   changed     same sortOrder, different hash     -> update in place
 *   missing     a live row this run never matched  -> set deprecatedAt
 *
 * NOTHING IS EVER DELETED, and that is the load-bearing rule rather than a
 * preference: a tenant may have installed the task, and its `Task` rows
 * outlive the template by design. Deprecation stops it being installed AGAIN
 * without touching what already exists — `installableTemplateTasks` filters
 * on it, and every previously-installed copy keeps working.
 *
 * "Changed" is matched on `sortOrder` because that is the only stable handle
 * authored content carries: titles are exactly what re-authoring rewrites, so
 * matching on title would read every edit as a delete plus a create and lose
 * the row identity that `Task.templateTaskId` now depends on.
 */
export async function reconcileTemplateTasks(
    prisma: PrismaClient,
    templateId: string,
    authored: readonly AuthoredTask[],
): Promise<TaskReconcileResult> {
    const result: TaskReconcileResult = { created: 0, updated: 0, deprecated: 0, unchanged: 0 };
    if (authored.length === 0) return result;

    const existing = await prisma.controlTemplateTask.findMany({
        where: { templateId },
        select: { id: true, contentHash: true, sortOrder: true, deprecatedAt: true },
    });
    const live = existing.filter((e) => !e.deprecatedAt);

    // Rows this run accounted for. Tracked by ROW ID rather than by sortOrder,
    // because sortOrder is NOT unique in the wild: every one of production's
    // 1,155 pre-existing template tasks sits at sortOrder 0, since the loops
    // that created them predate the column and took its default. Keying the
    // map by sortOrder collapses those five rows per template into one, and
    // the four it drops are then invisible to BOTH the update and the
    // deprecation pass — so they would survive as live boilerplate sitting
    // beside the authored tasks, which is the exact state this reconcile
    // exists to end.
    const matched = new Set<string>();

    const byHash = new Map<string, (typeof live)[number]>();
    for (const row of live) {
        if (row.contentHash && !byHash.has(row.contentHash)) byHash.set(row.contentHash, row);
    }
    const bySortOrder = new Map<number, (typeof live)[number]>();
    for (const row of live) {
        if (!bySortOrder.has(row.sortOrder)) bySortOrder.set(row.sortOrder, row);
    }

    for (const task of authored) {
        const hash = taskContentHash(task);

        const sameContent = byHash.get(hash);
        if (sameContent && !matched.has(sameContent.id)) {
            matched.add(sameContent.id);
            result.unchanged++;
            continue;
        }

        // The scalar columns carry `en`; `i18nJson` carries everything, so a
        // reader that only knows English is unaffected and a reader that
        // wants Bulgarian has somewhere to find it.
        const data = {
            title: task.title.en,
            description: task.description.en,
            phase: task.phase,
            sortOrder: task.sortOrder,
            stepsJson: task.steps ? (task.steps as unknown as object) : undefined,
            evidenceHint: task.evidenceHint?.en ?? null,
            suggestedRole: task.suggestedRole ?? null,
            contentHash: hash,
            i18nJson: task as unknown as object,
            deprecatedAt: null,
        };

        const atSameOrder = bySortOrder.get(task.sortOrder);
        if (atSameOrder && !matched.has(atSameOrder.id)) {
            await prisma.controlTemplateTask.update({ where: { id: atSameOrder.id }, data });
            matched.add(atSameOrder.id);
            result.updated++;
        } else {
            await prisma.controlTemplateTask.create({ data: { templateId, ...data } });
            result.created++;
        }
    }

    // Every live row this run did not account for. Deprecated, never deleted —
    // see the docblock. This is what retires the leftover generic placeholders.
    for (const row of live) {
        if (matched.has(row.id)) continue;
        await prisma.controlTemplateTask.update({
            where: { id: row.id },
            data: { deprecatedAt: new Date() },
        });
        result.deprecated++;
    }

    return result;
}

export interface ApplyCatalogResult {
    framework: { id: string; key: string; created: boolean };
    requirements: { upserted: number };
    templates: { created: number; existing: number };
    pack?: { id: string; key: string; created: boolean; templatesLinked: number };
}

/**
 * Apply a validated CatalogFile to the database. Mirrors the upsert
 * sequence in seed-catalog.ts so the on-disk YAML/JSON shape lands
 * exactly what the legacy seed produces.
 *
 * Cross-validation runs first (`assertCatalogConsistency`) so a
 * typo in `templateCodes`/`requirementCodes` aborts BEFORE any DB
 * writes — never half-applied.
 *
 * @param prisma  The Prisma client to write through.
 * @param file    Parsed + schema-validated catalog data.
 * @param filePath Original source path, used in error messages from
 *                 the consistency check.
 */
export async function applyCatalogFile(
    prisma: PrismaClient,
    file: CatalogFile,
    filePath: string,
): Promise<ApplyCatalogResult> {
    assertCatalogConsistency(file, filePath);

    // ── 1. Framework ────────────────────────────────────────────
    // Keyed on `key` ALONE, which is the framework's real identity:
    // `Framework.key` is `@unique`, so there can only ever be one row per key.
    //
    // This used to key on the compound `key_version` whenever the file declared
    // a version, and that is broken against a row whose version differs — most
    // sharply when it is NULL. `version = '2017'` matches no NULL row, so the
    // upsert found nothing, tried to CREATE, and could not (the `key` unique
    // constraint), and Prisma returned null rather than raising. The next line
    // then read `.id` off it.
    //
    // Not hypothetical: production carried SOC2 with `version: null`, the
    // catalog declared '2017', and the seeder died with
    // "Cannot read properties of null (reading 'id')" on every deploy — a
    // failure that was visible in the container log and nowhere else, because
    // the entrypoint runs seeders non-fatally by design.
    //
    // `version` moves into the payload, where it belongs: it is data about the
    // framework, not part of its identity.
    const fwBefore = await prisma.framework.findFirst({ where: { key: file.framework.key } });
    const framework = await prisma.framework.upsert({
        where: { key: file.framework.key },
        update: {
            name: file.framework.name,
            ...(file.framework.version ? { version: file.framework.version } : {}),
            ...(file.framework.kind ? { kind: file.framework.kind } : {}),
            ...(file.framework.description !== undefined
                ? { description: file.framework.description }
                : {}),
        },
        create: {
            key: file.framework.key,
            name: file.framework.name,
            ...(file.framework.version ? { version: file.framework.version } : {}),
            ...(file.framework.kind ? { kind: file.framework.kind } : {}),
            ...(file.framework.description !== undefined
                ? { description: file.framework.description }
                : {}),
        },
    });

    // ── 2. Requirements ─────────────────────────────────────────
    const requirementMap: Record<string, string> = {};
    for (let i = 0; i < file.requirements.length; i++) {
        const req = file.requirements[i];
        const r = await prisma.frameworkRequirement.upsert({
            where: {
                frameworkId_code: { frameworkId: framework.id, code: req.code },
            },
            update: {
                title: req.title,
                description: req.summary ?? null,
                ...(req.theme !== undefined ? { theme: req.theme } : {}),
                ...(req.themeNumber !== undefined ? { themeNumber: req.themeNumber } : {}),
                ...(req.section !== undefined ? { section: req.section } : {}),
                sortOrder: req.sortOrder ?? i,
            },
            create: {
                frameworkId: framework.id,
                code: req.code,
                title: req.title,
                description: req.summary ?? null,
                category: req.category ?? req.theme ?? req.section ?? '',
                ...(req.theme !== undefined ? { theme: req.theme } : {}),
                ...(req.themeNumber !== undefined ? { themeNumber: req.themeNumber } : {}),
                ...(req.section !== undefined ? { section: req.section } : {}),
                sortOrder: req.sortOrder ?? i,
            },
        });
        requirementMap[req.code] = r.id;
    }

    // ── 3. ControlTemplates + 4. Tasks + 5. Requirement links ──
    let templatesCreated = 0;
    let templatesExisting = 0;
    let tasksReconciled: TaskReconcileResult = { created: 0, updated: 0, deprecated: 0, unchanged: 0 };
    const templateMap: Record<string, string> = {};

    /**
     * Ensure a template's requirement links, whether it was just created or
     * already existed.
     *
     * This used to run ONLY on the create path, so an existing template kept
     * whatever links it happened to have — including none. That is not a
     * cosmetic gap like a stale title: requirement links are the reachability
     * wiring. `installFrameworkPack` finds templates BY
     * `requirementLinks.some.requirement.frameworkId`, so a template with no
     * links is present in the catalogue and installable by nobody.
     *
     * The file is authoritative for links even where it deliberately is not
     * authoritative for titles — re-titling a shipped control is a decision,
     * but a declared link is a statement about what the control covers.
     */
    const ensureLinks = async (templateId: string, requirementCodes: readonly string[]) => {
        for (const reqCode of requirementCodes) {
            const requirementId = requirementMap[reqCode];
            if (!requirementId) continue; // already covered by assertCatalogConsistency
            await prisma.controlTemplateRequirementLink.upsert({
                where: { templateId_requirementId: { templateId, requirementId } },
                create: { templateId, requirementId },
                update: {},
            });
        }
    };

    for (const t of file.templates) {
        const existing = await prisma.controlTemplate.findUnique({
            where: { code: t.code },
        });
        if (existing) {
            templatesExisting++;
            templateMap[t.code] = existing.id;
            // Template-level fields keep the existing skip — re-titling a
            // shipped control is a decision, not a sync. Its TASKS reconcile,
            // because authored content is the thing this file now carries and
            // an existing template is exactly where re-authored content lands.
            tasksReconciled = addReconcile(
                tasksReconciled,
                await reconcileTemplateTasks(prisma, existing.id, t.tasks),
            );
            await ensureLinks(existing.id, t.requirementCodes);
            continue;
        }
        const tmpl = await prisma.controlTemplate.create({
            data: {
                code: t.code,
                title: t.title,
                description: t.description ?? null,
                category: t.category,
                defaultFrequency: t.defaultFrequency,
            },
        });
        templateMap[t.code] = tmpl.id;
        templatesCreated++;

        if (t.tasks.length > 0) {
            tasksReconciled = addReconcile(
                tasksReconciled,
                await reconcileTemplateTasks(prisma, tmpl.id, t.tasks),
            );
        } else {
            // No authored content for this template yet. The generic five are
            // still the honest default — see prisma/generic-template-tasks.ts
            // for why they survive and what deletes them.
            for (const task of GENERIC_TEMPLATE_TASKS) {
                await prisma.controlTemplateTask.create({
                    data: { templateId: tmpl.id, title: task.title, description: task.description },
                });
            }
        }

        await ensureLinks(tmpl.id, t.requirementCodes);

    }

    // ── 6. + 7. Pack + PackTemplateLinks ───────────────────────
    let packResult: ApplyCatalogResult['pack'];
    if (file.pack) {
        const packBefore = await prisma.frameworkPack.findUnique({
            where: { key: file.pack.key },
        });
        const pack = await prisma.frameworkPack.upsert({
            where: { key: file.pack.key },
            update: {
                name: file.pack.name,
                frameworkId: framework.id,
                ...(file.pack.version ? { version: file.pack.version } : {}),
                ...(file.pack.description !== undefined
                    ? { description: file.pack.description }
                    : {}),
            },
            create: {
                key: file.pack.key,
                name: file.pack.name,
                frameworkId: framework.id,
                ...(file.pack.version ? { version: file.pack.version } : {}),
                ...(file.pack.description !== undefined
                    ? { description: file.pack.description }
                    : {}),
            },
        });

        // Default to every template in this file when omitted.
        const codes = file.pack.templateCodes ?? file.templates.map((t) => t.code);
        let linked = 0;
        for (const code of codes) {
            const templateId = templateMap[code];
            if (!templateId) continue; // already covered by consistency check
            await prisma.packTemplateLink.upsert({
                where: { packId_templateId: { packId: pack.id, templateId } },
                create: { packId: pack.id, templateId },
                update: {},
            });
            linked++;
        }
        packResult = {
            id: pack.id,
            key: pack.key,
            created: !packBefore,
            templatesLinked: linked,
        };
    }

    return {
        framework: {
            id: framework.id,
            key: framework.key,
            created: !fwBefore,
        },
        requirements: { upserted: file.requirements.length },
        templates: { created: templatesCreated, existing: templatesExisting },
        pack: packResult,
    };
}
