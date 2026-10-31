import { Prisma } from '@prisma/client';
import { RequestContext } from '../../types';
import { assertCanViewFrameworks, assertCanInstallFrameworkPack } from '../../policies/framework.policies';
import { logEvent } from '../../events/audit';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { notFound, badRequest, ConflictError } from '@/lib/errors/types';
import type { FrameworkInstallRefusal } from '@/lib/framework-install-refusals';
import { prisma } from '@/lib/prisma';
import { getEffectivePlan } from '@/lib/billing/entitlements';
import { recordFrameworkInstalled } from '@/lib/observability/business-metrics';
import { controlDataFromTemplate, resolveRelatedPolicyIds } from '../control/template-projection';
import { taskFromTemplateTask, installableTemplateTasks } from '../control/task-from-template';
import { LIVE_TEMPLATE_TASKS } from '../../repositories/ControlTemplateRepository';
import type { FrameworkTemplateRefusal } from '@/lib/framework-template-refusals';

// в”Ђв”Ђв”Ђ Pack Install (tenant-scoped, idempotent) в”Ђв”Ђв”Ђ

interface TemplateForPreview {
    code: string;
    requirementLinks: { requirementId: string }[];
}

/**
 * Which templates already have a control in this workspace, and how many of
 * each one's requirement mappings that control is missing (#4731).
 *
 * Installing again restores them (`installPacksInTenant` re-creates the
 * mappings and policy links of a control that already exists), so the wizard
 * offers the install while any is missing. It used to offer it only for new
 * controls, which left a workspace that had lost its mappings with no way
 * back but mapping each requirement by hand.
 */
async function installedState(db: PrismaTx, tenantId: string, templates: readonly TemplateForPreview[]) {
    const controls = await db.control.findMany({
        where: { tenantId, code: { in: templates.map((t) => t.code) } },
        select: { id: true, code: true },
    });
    const controlIdByCode = new Map(controls.map((c) => [c.code, c.id]));
    const links = controls.length === 0
        ? []
        : await db.controlRequirementLink.findMany({
            where: { tenantId, controlId: { in: controls.map((c) => c.id) } },
            select: { controlId: true, requirementId: true },
        });
    const linked = new Set(links.map((l) => `${l.controlId}:${l.requirementId}`));
    const missingByCode = new Map<string, number>();
    for (const t of templates) {
        const controlId = controlIdByCode.get(t.code);
        if (!controlId) continue;
        missingByCode.set(t.code, t.requirementLinks.filter((rl) => !linked.has(`${controlId}:${rl.requirementId}`)).length);
    }
    const missingMappings = [...missingByCode.values()].reduce((n, m) => n + m, 0);
    return { existingCodes: new Set(controlIdByCode.keys()), missingByCode, missingMappings };
}

export async function previewPackInstall(ctx: RequestContext, packKey: string) {
    assertCanViewFrameworks(ctx);
    const db = prisma;
    const pack = await db.frameworkPack.findUnique({
        where: { key: packKey },
        include: {
            templateLinks: {
                include: {
                    template: {
                        include: { tasks: LIVE_TEMPLATE_TASKS, requirementLinks: { include: { requirement: true } } },
                    },
                },
            },
            framework: true,
        },
    });
    if (!pack) throw notFound('Pack not found', { reason: 'PACK_NOT_FOUND' satisfies FrameworkInstallRefusal });

    // Which controls already exist for this tenant, and what they are missing.
    const { existingCodes, missingByCode, missingMappings } = await runInTenantContext(ctx, (db) =>
        installedState(db, ctx.tenantId, pack.templateLinks.map((l) => l.template)),
    );

    return {
        packKey: pack.key,
        packName: pack.name,
        framework: { key: pack.framework.key, name: pack.framework.name, version: pack.framework.version },
        totalTemplates: pack.templateLinks.length,
        newControls: pack.templateLinks.filter((l) => !existingCodes.has(l.template.code)).length,
        existingControls: pack.templateLinks.filter((l) => existingCodes.has(l.template.code)).length,
        missingMappings,
        templates: pack.templateLinks.map((l) => ({
            code: l.template.code,
            title: l.template.title,
            tasks: l.template.tasks.length,
            requirements: l.template.requirementLinks.map((rl) => ({ code: rl.requirement.code, title: rl.requirement.title })),
            alreadyInstalled: existingCodes.has(l.template.code),
            missingMappings: missingByCode.get(l.template.code) ?? 0,
        })),
    };
}

type PackForInstall = Prisma.FrameworkPackGetPayload<{ include: typeof PACK_INSTALL_INCLUDE }>;

const PACK_INSTALL_INCLUDE = {
    templateLinks: {
        include: {
            template: {
                include: { tasks: LIVE_TEMPLATE_TASKS, requirementLinks: true },
            },
        },
    },
    framework: true,
} satisfies Prisma.FrameworkPackInclude;

interface PackInstallCounts {
    packKey: string;
    packName: string;
    controlsCreated: number;
    tasksCreated: number;
    mappingsCreated: number;
    policyLinksCreated: number;
}

/**
 * Install the templates of several packs in ONE tenant transaction, each
 * template at most once.
 *
 * Packs over one framework may share templates — a framework whose packs are
 * its subcategories links its common controls into every one — so a template
 * already handled by an earlier pack in this call is skipped, and a pack's
 * counts are what IT added. Each pack gets its own FRAMEWORK_PACK_INSTALLED
 * audit row, exactly as a single-pack install always has.
 */
async function installPacksInTenant(ctx: RequestContext, packs: PackForInstall[]) {
    // ISO27001 has 93 controls × (lookup + create + 5 default tasks +
    // requirement-link upserts), which is too much work for the default
    // 5 s Prisma interactive-transaction timeout. Bump it to 60 s so the
    // entire pack install runs atomically.
    return runInTenantContext(ctx, async (tdb) => {
        const handled = new Set<string>();
        const results: PackInstallCounts[] = [];

        // Tenant policies by normalised title — the internal controls carry
        // their related-policy NAMES; link each to the tenant's matching policy
        // where one exists (never create a policy here).
        const tenantPolicies = await tdb.policy.findMany({
            where: { tenantId: ctx.tenantId },
            select: { id: true, title: true },
        });
        const policyByTitle = new Map(tenantPolicies.map((p) => [p.title.trim().toLowerCase(), p.id]));

        for (const pack of packs) {
            let controlsCreated = 0;
            let tasksCreated = 0;
            let mappingsCreated = 0;
            let policyLinksCreated = 0;

            const linkPolicies = async (controlId: string, relatedPolicies: string | null) => {
                if (!relatedPolicies) return;
                const policyIds = resolveRelatedPolicyIds(relatedPolicies, policyByTitle);
                if (!policyIds.length) return;
                const res = await tdb.policyControlLink.createMany({
                    data: policyIds.map((policyId) => ({ tenantId: ctx.tenantId, policyId, controlId })),
                    skipDuplicates: true,
                });
                policyLinksCreated += res.count;
            };

            // A pack installs EXACTLY the controls its standard defines, and
            // nothing else: 93 for ISO/IEC 27001:2022 Annex A, and likewise for
            // every other framework. The number a customer sees must be the
            // number in the standard.
            //
            // This previously also swept in every global ControlTemplate
            // carrying a requirement link into this framework, on the reasoning
            // that the internal-controls library is not a standalone pack and
            // is otherwise unreachable. The effect: installing ISO 27001 created
            // 233 controls -- the 93 Annex A controls plus the 140 internal
            // controls whose related policies happen to map, policy-mediated,
            // to some Annex A requirement. `previewPackInstall` counted only the
            // pack's own templates, so the wizard promised 93 and delivered 233.
            //
            // Reachability for the internal-controls library is a real problem
            // but a separate one, and it needs its own install path -- see
            // prisma/control-template-seed.ts. It is not a decision a framework
            // pack should make on the tenant's behalf.
            for (const { template: tmpl } of pack.templateLinks) {
                // By code: it is the template's unique key and the one the
                // idempotency check below matches controls on.
                if (handled.has(tmpl.code)) continue;
                handled.add(tmpl.code);

                // Idempotent: skip if control with this code already exists
                const existing = await tdb.control.findFirst({
                    where: { tenantId: ctx.tenantId, code: tmpl.code },
                });
                if (existing) {
                    // Restore any requirement mapping the control has lost, and
                    // count it: a re-install is how a workspace repairs them
                    // (#4731), so the result says how many came back.
                    if (tmpl.requirementLinks.length > 0) {
                        const restored = await tdb.controlRequirementLink.createMany({
                            data: tmpl.requirementLinks.map((rl) => ({
                                tenantId: ctx.tenantId, controlId: existing.id, requirementId: rl.requirementId,
                            })),
                            skipDuplicates: true,
                        });
                        mappingsCreated += restored.count;
                    }
                    await linkPolicies(existing.id, tmpl.relatedPolicies);
                    continue;
                }

                // Create control from template
                const control = await tdb.control.create({
                    data: {
                        // Shared with POST /controls/templates/install — see
                        // control/template-projection.ts. The two paths produced
                        // different controls from the same template until
                        // 2026-08-06.
                        ...controlDataFromTemplate(tmpl, {
                            tenantId: ctx.tenantId,
                            userId: ctx.userId,
                        }),
                    },
                });
                controlsCreated++;

                // Create tasks from template tasks
                for (const tt of installableTemplateTasks(tmpl.tasks)) {
                    await tdb.task.create({
                        data: taskFromTemplateTask(tt, ctx, control.id),
                    });
                    tasksCreated++;
                }

                // Create requirement mappings
                for (const rl of tmpl.requirementLinks) {
                    await tdb.controlRequirementLink.create({
                        data: { tenantId: ctx.tenantId, controlId: control.id, requirementId: rl.requirementId },
                    });
                    mappingsCreated++;
                }

                await linkPolicies(control.id, tmpl.relatedPolicies);
            }

            // Record the choice. For a framework with several packs, the packs
            // a workspace installed are the scope its coverage is counted over
            // (pack-scope.ts). Only ever added: a later pack widens the scope.
            await tdb.tenantFrameworkPack.upsert({
                where: { tenantId_packId: { tenantId: ctx.tenantId, packId: pack.id } },
                create: { tenantId: ctx.tenantId, frameworkId: pack.frameworkId, packId: pack.id },
                update: {},
            });

            const packKey = pack.key;
            await logEvent(tdb, ctx, {
                action: 'FRAMEWORK_PACK_INSTALLED',
                entityType: 'Framework',
                entityId: pack.frameworkId,
                details: `Pack "${pack.name}" installed: ${controlsCreated} controls, ${tasksCreated} tasks, ${mappingsCreated} mappings, ${policyLinksCreated} policy links`,
                detailsJson: { category: 'entity_lifecycle', entityName: 'FrameworkPack', operation: 'created', after: { packKey, controlsCreated, tasksCreated, mappingsCreated, policyLinksCreated }, summary: `Pack "${pack.name}" installed` },
                metadata: { packKey, controlsCreated, tasksCreated, mappingsCreated, policyLinksCreated },
            });

            results.push({ packKey, packName: pack.name, controlsCreated, tasksCreated, mappingsCreated, policyLinksCreated });
        }
        return results;
    }, { timeout: 60_000, maxWait: 10_000 });
}

export async function installPack(ctx: RequestContext, packKey: string) {
    assertCanInstallFrameworkPack(ctx);
    const db = prisma;
    const pack = await db.frameworkPack.findUnique({
        where: { key: packKey },
        include: PACK_INSTALL_INCLUDE,
    });
    if (!pack) throw notFound('Pack not found', { reason: 'PACK_NOT_FOUND' satisfies FrameworkInstallRefusal });

    const [counts] = await installPacksInTenant(ctx, [pack]);
    const result = { ...counts, framework: pack.framework.key };

    const plan = await getEffectivePlan(ctx);
    recordFrameworkInstalled({ frameworkKey: result.framework, plan });
    return result;
}

/**
 * Take a pack out of this workspace's scope for its framework (#4372).
 *
 * For a framework with several packs, the packs a workspace installed are what
 * its coverage counts (`pack-scope.ts`). Removing one deletes only that record,
 * so its requirements stop counting. No control, task or mapping is touched:
 * they may serve another pack or framework, and a control is archived on its
 * own if it is no longer wanted.
 *
 * The last chosen pack is refused. With no record the framework falls back to
 * counting every requirement, so removing it would WIDEN the scope, the
 * opposite of what removal means; install asks for at least one pack for the
 * same reason. The count and the delete run under one advisory lock per
 * (workspace, framework), so two removals racing cannot both see two packs and
 * leave none.
 *
 * Same gate as install: choosing what the workspace has taken on is one act.
 */
export async function removeChosenPack(ctx: RequestContext, frameworkKey: string, packKey: string) {
    assertCanInstallFrameworkPack(ctx);
    const pack = await prisma.frameworkPack.findUnique({
        where: { key: packKey },
        select: { id: true, key: true, name: true, frameworkId: true, framework: { select: { key: true } } },
    });
    if (!pack || pack.framework.key !== frameworkKey) throw notFound('Pack not found');

    return runInTenantContext(ctx, async (tdb) => {
        await tdb.$executeRawUnsafe(
            `SELECT pg_advisory_xact_lock(hashtext($1))`,
            `framework-pack-scope:${ctx.tenantId}:${pack.frameworkId}`,
        );
        const where = { tenantId_packId: { tenantId: ctx.tenantId, packId: pack.id } };
        const row = await tdb.tenantFrameworkPack.findUnique({ where, select: { id: true } });
        if (!row) {
            throw new ConflictError('This pack is not one of your chosen packs.', { reason: 'PACK_NOT_CHOSEN' });
        }
        const chosen = await tdb.tenantFrameworkPack.count({
            where: { tenantId: ctx.tenantId, frameworkId: pack.frameworkId },
        });
        if (chosen <= 1) {
            throw new ConflictError(
                'Keep at least one pack. With none chosen, coverage would count every requirement of the framework.',
                { reason: 'LAST_CHOSEN_PACK' },
            );
        }
        await tdb.tenantFrameworkPack.delete({ where });
        await logEvent(tdb, ctx, {
            action: 'FRAMEWORK_PACK_REMOVED',
            entityType: 'Framework',
            entityId: pack.frameworkId,
            details: `Pack "${pack.name}" removed from the workspace's chosen packs`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'FrameworkPack',
                operation: 'deleted',
                before: { packKey: pack.key },
                summary: `Pack "${pack.name}" removed from scope`,
            },
            metadata: { packKey: pack.key, remainingChosenPacks: chosen - 1 },
        });
        return { packKey: pack.key, framework: frameworkKey, remainingChosenPacks: chosen - 1 };
    });
}

/**
 * Validate the chosen packs of ONE framework for a preview or an install, and
 * return their keys deduplicated, in the order chosen.
 *
 * This is where "choose at least one" is enforced on the server: an empty
 * choice is refused, as is a key that names no pack or names a pack of a
 * different framework — the wizard asks for the packs of the framework in its
 * URL, and a request mixing in another framework's pack is not that choice.
 */
async function assertChosenPacks(frameworkKey: string, packKeys: readonly string[]): Promise<string[]> {
    const keys = [...new Set(packKeys.map((k) => k.trim()).filter(Boolean))];
    if (keys.length === 0) throw badRequest('Choose at least one pack to install.', { reason: 'NO_PACK_CHOSEN' satisfies FrameworkInstallRefusal });
    const found = await prisma.frameworkPack.findMany({
        where: { key: { in: keys } },
        select: { key: true, framework: { select: { key: true } } },
    });
    const known = new Set(found.map((p) => p.key));
    const missing = keys.filter((k) => !known.has(k));
    if (missing.length > 0) throw notFound(`Pack not found: ${missing.join(', ')}`, { reason: 'PACK_NOT_FOUND' satisfies FrameworkInstallRefusal });
    const foreign = found.filter((p) => p.framework.key !== frameworkKey).map((p) => p.key);
    if (foreign.length > 0) {
        throw badRequest(`Not a pack of ${frameworkKey}: ${foreign.sort().join(', ')}`, { reason: 'PACK_OF_OTHER_FRAMEWORK' satisfies FrameworkInstallRefusal });
    }
    return keys;
}

/** Rows back in the order the caller chose, so audit rows and counts read that way. */
function inChosenOrder<P extends { key: string }>(keys: readonly string[], rows: P[]): P[] {
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return keys.map((k) => byKey.get(k)).filter((r): r is P => r !== undefined);
}

/**
 * Preview installing several packs of one framework together: the union of
 * their templates, each counted once.
 */
export async function previewPacksInstall(ctx: RequestContext, frameworkKey: string, packKeys: readonly string[]) {
    assertCanViewFrameworks(ctx);
    const keys = await assertChosenPacks(frameworkKey, packKeys);
    const packs = inChosenOrder(
        keys,
        await prisma.frameworkPack.findMany({
            where: { key: { in: keys } },
            include: {
                templateLinks: {
                    include: {
                        template: {
                            include: { tasks: LIVE_TEMPLATE_TASKS, requirementLinks: { include: { requirement: true } } },
                        },
                    },
                },
                framework: true,
            },
        }),
    );
    const templates = new Map<string, (typeof packs)[number]['templateLinks'][number]['template']>();
    for (const pack of packs) {
        for (const l of pack.templateLinks) {
            if (!templates.has(l.template.code)) templates.set(l.template.code, l.template);
        }
    }
    const list = [...templates.values()];
    const { existingCodes, missingByCode, missingMappings } = await runInTenantContext(ctx, (db) =>
        installedState(db, ctx.tenantId, list),
    );
    const fw = packs[0].framework;

    return {
        packKeys: packs.map((p) => p.key),
        packs: packs.map((p) => ({ key: p.key, name: p.name })),
        framework: { key: fw.key, name: fw.name, version: fw.version },
        totalTemplates: list.length,
        newControls: list.filter((t) => !existingCodes.has(t.code)).length,
        existingControls: list.filter((t) => existingCodes.has(t.code)).length,
        missingMappings,
        templates: list.map((t) => ({
            code: t.code,
            title: t.title,
            tasks: t.tasks.length,
            requirements: t.requirementLinks.map((rl) => ({ code: rl.requirement.code, title: rl.requirement.title })),
            alreadyInstalled: existingCodes.has(t.code),
            missingMappings: missingByCode.get(t.code) ?? 0,
        })),
    };
}

/**
 * Install several packs of one framework — the subcategories a tenant chose —
 * atomically. A template the packs share is installed once.
 */
export async function installPacks(ctx: RequestContext, frameworkKey: string, packKeys: readonly string[]) {
    assertCanInstallFrameworkPack(ctx);
    const keys = await assertChosenPacks(frameworkKey, packKeys);
    const packs = inChosenOrder(
        keys,
        await prisma.frameworkPack.findMany({ where: { key: { in: keys } }, include: PACK_INSTALL_INCLUDE }),
    );
    const perPack = await installPacksInTenant(ctx, packs);
    const sum = (k: 'controlsCreated' | 'tasksCreated' | 'mappingsCreated' | 'policyLinksCreated') =>
        perPack.reduce((n, p) => n + p[k], 0);
    const result = {
        framework: frameworkKey,
        packKeys: perPack.map((p) => p.packKey),
        packName: perPack.map((p) => p.packName).join(', '),
        packs: perPack,
        controlsCreated: sum('controlsCreated'),
        tasksCreated: sum('tasksCreated'),
        mappingsCreated: sum('mappingsCreated'),
        policyLinksCreated: sum('policyLinksCreated'),
    };

    const plan = await getEffectivePlan(ctx);
    recordFrameworkInstalled({ frameworkKey, plan });
    return result;
}

// Coverage + template listing live in `./coverage`, and the barrel
// (`./index.ts`) has always re-exported them from there. This file
// carried a second, DEAD copy of `computeCoverage` + `listTemplates`
// that nothing in src/ could reach.
//
// It was not harmless. The copy was a FORK: the soft-deleted-control fix
// and the deprecated-requirement fix were both applied to the coverage.ts
// side only, so the dead twin still computed the two wrong compliance
// numbers the report family was reconciled to stop producing — and its
// own tests pinned that behaviour, so a reader who found this copy first
// would have found the bug documented as correct. Deleted 2026-08-16.

// в”Ђв”Ђв”Ђ Install Single Template в”Ђв”Ђв”Ђ

export async function installSingleTemplate(ctx: RequestContext, templateCode: string) {
    assertCanInstallFrameworkPack(ctx);
    const db = prisma;

    const tmpl = await db.controlTemplate.findUnique({
        where: { code: templateCode },
        include: { tasks: LIVE_TEMPLATE_TASKS, requirementLinks: true },
    });
    if (!tmpl) throw notFound('Template not found', { reason: 'TEMPLATE_NOT_FOUND' satisfies FrameworkTemplateRefusal });

    return runInTenantContext(ctx, async (tdb) => {
        // Idempotent: check existing
        const existing = await tdb.control.findFirst({
            where: { tenantId: ctx.tenantId, code: tmpl.code },
        });
        if (existing) {
            // Ensure requirement links
            let mappingsCreated = 0;
            for (const rl of tmpl.requirementLinks) {
                await tdb.controlRequirementLink.upsert({
                    where: { controlId_requirementId: { controlId: existing.id, requirementId: rl.requirementId } },
                    create: { tenantId: ctx.tenantId, controlId: existing.id, requirementId: rl.requirementId },
                    update: {},
                });
                mappingsCreated++;
            }
            return { controlId: existing.id, code: tmpl.code, alreadyExisted: true, mappingsCreated };
        }

        const control = await tdb.control.create({
            data: {
                tenantId: ctx.tenantId,
                code: tmpl.code,
                name: tmpl.title,
                category: tmpl.category,
                frequency: tmpl.defaultFrequency,
                status: 'NOT_STARTED',
                createdByUserId: ctx.userId,
            },
        });

        let tasksCreated = 0;
        for (const tt of installableTemplateTasks(tmpl.tasks)) {
            await tdb.task.create({
                data: taskFromTemplateTask(tt, ctx, control.id),
            });
            tasksCreated++;
        }

        let mappingsCreated = 0;
        for (const rl of tmpl.requirementLinks) {
            await tdb.controlRequirementLink.create({
                data: { tenantId: ctx.tenantId, controlId: control.id, requirementId: rl.requirementId },
            });
            mappingsCreated++;
        }

        await logEvent(tdb, ctx, {
            action: 'TEMPLATE_INSTALLED',
            entityType: 'Control',
            entityId: control.id,
            details: `Template "${tmpl.code}" installed: 1 control, ${tasksCreated} tasks, ${mappingsCreated} mappings`,
            detailsJson: { category: 'entity_lifecycle', entityName: 'Control', operation: 'created', summary: 'TEMPLATE_INSTALLED' },
            metadata: { templateCode: tmpl.code, tasksCreated, mappingsCreated },
        });

        return { controlId: control.id, code: tmpl.code, alreadyExisted: false, tasksCreated, mappingsCreated };
    });
}

// в”Ђв”Ђв”Ђ Bulk Map Controls в†” Requirements в”Ђв”Ђв”Ђ

export async function bulkMapControls(
    ctx: RequestContext,
    frameworkKey: string,
    mappings: Array<{ controlId: string; requirementIds: string[] }>
) {
    assertCanInstallFrameworkPack(ctx);
    if (!mappings || mappings.length === 0) throw badRequest('At least one mapping required');
    if (mappings.length > 200) throw badRequest('Max 200 mappings per batch');

    const db = prisma;
    const fw = await db.framework.findFirst({ where: { key: frameworkKey } });
    if (!fw) throw notFound('Framework not found');

    // Validate all requirement IDs belong to this framework
    const reqIds = [...new Set(mappings.flatMap(m => m.requirementIds))];
    const validReqs = await db.frameworkRequirement.findMany({
        where: { frameworkId: fw.id, id: { in: reqIds } },
        select: { id: true },
    });
    const validReqIds = new Set(validReqs.map((r) => r.id));
    const invalidReqIds = reqIds.filter((id) => !validReqIds.has(id));
    if (invalidReqIds.length > 0) throw badRequest(`Invalid requirement IDs: ${invalidReqIds.join(', ')}`);

    return runInTenantContext(ctx, async (tdb) => {
        // Validate all control IDs belong to this tenant
        const controlIds = [...new Set(mappings.map((m) => m.controlId))];
        const validControls = await tdb.control.findMany({
            where: { tenantId: ctx.tenantId, id: { in: controlIds } },
            select: { id: true },
        });

        const validCtrlIds = new Set(validControls.map((c) => c.id));
        const invalidCtrlIds = controlIds.filter((id) => !validCtrlIds.has(id));
        if (invalidCtrlIds.length > 0) throw badRequest(`Invalid control IDs: ${invalidCtrlIds.join(', ')}`);

        let created = 0;
        let existing = 0;
        for (const mapping of mappings) {
            for (const reqId of mapping.requirementIds) {
                try {
                    await tdb.controlRequirementLink.create({
                        data: { tenantId: ctx.tenantId, controlId: mapping.controlId, requirementId: reqId },
                    });
                    created++;
                } catch {
                    // Unique constraint violation = already exists
                    existing++;
                }
            }
        }

        await logEvent(tdb, ctx, {
            action: 'BULK_REQUIREMENTS_MAPPED',
            entityType: 'Framework',
            entityId: fw.id,
            details: `Bulk mapped ${created} new + ${existing} existing controlв†”requirement links`,
            detailsJson: { category: 'custom', event: 'bulk_requirements_mapped' },
            metadata: { frameworkKey, created, existing },
        });

        return { frameworkKey, created, existing, total: created + existing };
    });
}

// в”Ђв”Ђв”Ђ Bulk Install Templates в”Ђв”Ђв”Ђ

export async function bulkInstallTemplates(
    ctx: RequestContext,
    templateCodes: string[]
) {
    assertCanInstallFrameworkPack(ctx);
    if (!templateCodes || templateCodes.length === 0) throw badRequest('At least one template code required', { reason: 'NO_TEMPLATE_CHOSEN' satisfies FrameworkTemplateRefusal });
    if (templateCodes.length > 100) throw badRequest('Max 100 templates per batch', { reason: 'TOO_MANY_TEMPLATES' satisfies FrameworkTemplateRefusal });

    const db = prisma;
    const templates = await db.controlTemplate.findMany({
        where: { code: { in: templateCodes } },
        include: { tasks: LIVE_TEMPLATE_TASKS, requirementLinks: true },
    });
    const foundCodes = new Set(templates.map((t) => t.code));
    const notFound_codes = templateCodes.filter((c) => !foundCodes.has(c));
    if (notFound_codes.length > 0) throw badRequest(`Templates not found: ${notFound_codes.join(', ')}`, { reason: 'TEMPLATE_NOT_FOUND' satisfies FrameworkTemplateRefusal });

    return runInTenantContext(ctx, async (tdb) => {
        let controlsCreated = 0;
        let tasksCreated = 0;
        let mappingsCreated = 0;
        let skipped = 0;

        for (const tmpl of templates) {
            const existing = await tdb.control.findFirst({
                where: { tenantId: ctx.tenantId, code: tmpl.code },
            });
            if (existing) {
                for (const rl of tmpl.requirementLinks) {
                    await tdb.controlRequirementLink.upsert({
                        where: { controlId_requirementId: { controlId: existing.id, requirementId: rl.requirementId } },
                        create: { tenantId: ctx.tenantId, controlId: existing.id, requirementId: rl.requirementId },
                        update: {},
                    });
                }
                skipped++;
                continue;
            }

            const control = await tdb.control.create({
                data: {
                    tenantId: ctx.tenantId,
                    code: tmpl.code,
                    name: tmpl.title,
                    category: tmpl.category,
                    frequency: tmpl.defaultFrequency,
                    status: 'NOT_STARTED',
                    createdByUserId: ctx.userId,
                },
            });
            controlsCreated++;

            for (const tt of installableTemplateTasks(tmpl.tasks)) {
                await tdb.task.create({
                    data: taskFromTemplateTask(tt, ctx, control.id),
                });
                tasksCreated++;
            }

            for (const rl of tmpl.requirementLinks) {
                await tdb.controlRequirementLink.create({
                    data: { tenantId: ctx.tenantId, controlId: control.id, requirementId: rl.requirementId },
                });
                mappingsCreated++;
            }
        }

        await logEvent(tdb, ctx, {
            action: 'BULK_TEMPLATES_INSTALLED',
            entityType: 'ControlTemplate',
            entityId: 'bulk',
            details: `Bulk installed ${controlsCreated} controls, ${tasksCreated} tasks, ${mappingsCreated} mappings (${skipped} skipped)`,
            detailsJson: { category: 'entity_lifecycle', entityName: 'ControlTemplate', operation: 'created', summary: 'BULK_TEMPLATES_INSTALLED' },
            metadata: { controlsCreated, tasksCreated, mappingsCreated, skipped },
        });

        return { controlsCreated, tasksCreated, mappingsCreated, skipped };
    });
}
