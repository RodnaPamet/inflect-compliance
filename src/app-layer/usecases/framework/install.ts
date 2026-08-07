import { Prisma } from '@prisma/client';
import { RequestContext } from '../../types';
import { assertCanViewFrameworks, assertCanInstallFrameworkPack } from '../../policies/framework.policies';
import { logEvent } from '../../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { notFound, badRequest } from '@/lib/errors/types';
import { prisma } from '@/lib/prisma';
import { getEffectivePlan } from '@/lib/billing/entitlements';
import { recordFrameworkInstalled } from '@/lib/observability/business-metrics';
import { controlDataFromTemplate, resolveRelatedPolicyIds } from '../control/template-projection';

// в”Ђв”Ђв”Ђ Pack Install (tenant-scoped, idempotent) в”Ђв”Ђв”Ђ

export async function previewPackInstall(ctx: RequestContext, packKey: string) {
    assertCanViewFrameworks(ctx);
    const db = prisma;
    const pack = await db.frameworkPack.findUnique({
        where: { key: packKey },
        include: {
            templateLinks: {
                include: {
                    template: {
                        include: { tasks: true, requirementLinks: { include: { requirement: true } } },
                    },
                },
            },
            framework: true,
        },
    });
    if (!pack) throw notFound('Pack not found');

    // Check which controls already exist for this tenant
    const existingControls = await runInTenantContext(ctx, (db) =>
        db.control.findMany({
            where: { tenantId: ctx.tenantId, code: { in: pack.templateLinks.map((l) => l.template.code) } },
            select: { code: true },
        })
    );

    const existingCodes = new Set(existingControls.map((c) => c.code));

    return {
        packKey: pack.key,
        packName: pack.name,
        framework: { key: pack.framework.key, name: pack.framework.name, version: pack.framework.version },
        totalTemplates: pack.templateLinks.length,
        newControls: pack.templateLinks.filter((l) => !existingCodes.has(l.template.code)).length,
        existingControls: pack.templateLinks.filter((l) => existingCodes.has(l.template.code)).length,
        templates: pack.templateLinks.map((l) => ({
            code: l.template.code,
            title: l.template.title,
            tasks: l.template.tasks.length,
            requirements: l.template.requirementLinks.map((rl) => ({ code: rl.requirement.code, title: rl.requirement.title })),
            alreadyInstalled: existingCodes.has(l.template.code),
        })),
    };
}

export async function installPack(ctx: RequestContext, packKey: string) {
    assertCanInstallFrameworkPack(ctx);
    const db = prisma;
    const pack = await db.frameworkPack.findUnique({
        where: { key: packKey },
        include: {
            templateLinks: {
                include: {
                    template: {
                        include: { tasks: true, requirementLinks: true },
                    },
                },
            },
            framework: true,
        },
    });
    if (!pack) throw notFound('Pack not found');

    // Internal controls are NOT a standalone pack: they are global
    // ControlTemplates mapped (policy-mediated) to framework requirements.
    // Installing a framework pack ALSO populates the internal controls whose
    // requirement mappings reference THIS framework (and that aren't already the
    // pack's own templates), plus their policy links. `installedTemplates` is the
    // pack's own controls + those mapped internal controls.
    const packTemplateIds = pack.templateLinks.map((l) => l.template.id);
    const mappedInternalTemplates = await db.controlTemplate.findMany({
        where: {
            id: { notIn: packTemplateIds },
            requirementLinks: { some: { requirement: { frameworkId: pack.frameworkId } } },
        },
        include: { tasks: true, requirementLinks: true },
    });
    const installedTemplates = [
        ...pack.templateLinks.map((l) => l.template),
        ...mappedInternalTemplates,
    ];

    // ISO27001 has 93 controls × (lookup + create + 5 default tasks +
    // requirement-link upserts), which is too much work for the default
    // 5 s Prisma interactive-transaction timeout. Bump it to 60 s so the
    // entire pack install runs atomically.
    const result = await runInTenantContext(ctx, async (tdb) => {
        let controlsCreated = 0;
        let tasksCreated = 0;
        let mappingsCreated = 0;
        let policyLinksCreated = 0;

        // Tenant policies by normalised title — the internal controls carry
        // their related-policy NAMES; link each to the tenant's matching policy
        // where one exists (never create a policy here).
        const tenantPolicies = await tdb.policy.findMany({
            where: { tenantId: ctx.tenantId },
            select: { id: true, title: true },
        });
        const policyByTitle = new Map(tenantPolicies.map((p) => [p.title.trim().toLowerCase(), p.id]));
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

        for (const tmpl of installedTemplates) {

            // Idempotent: skip if control with this code already exists
            const existing = await tdb.control.findFirst({
                where: { tenantId: ctx.tenantId, code: tmpl.code },
            });
            if (existing) {
                // Still ensure requirement links exist
                for (const rl of tmpl.requirementLinks) {
                    await tdb.controlRequirementLink.upsert({
                        where: { controlId_requirementId: { controlId: existing.id, requirementId: rl.requirementId } },
                        create: { tenantId: ctx.tenantId, controlId: existing.id, requirementId: rl.requirementId },
                        update: {},
                    });
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
            for (const tt of tmpl.tasks) {
                await tdb.task.create({
                    data: {
                        tenantId: ctx.tenantId,
                        controlId: control.id,
                        title: tt.title,
                        description: tt.description,
                        status: 'OPEN',
                        type: 'TASK',
                        createdByUserId: ctx.userId,
                        assigneeUserId: ctx.userId,
                    },
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

        await logEvent(tdb, ctx, {
            action: 'FRAMEWORK_PACK_INSTALLED',
            entityType: 'Framework',
            entityId: pack.frameworkId,
            details: `Pack "${pack.name}" installed: ${controlsCreated} controls, ${tasksCreated} tasks, ${mappingsCreated} mappings, ${policyLinksCreated} policy links`,
            detailsJson: { category: 'entity_lifecycle', entityName: 'FrameworkPack', operation: 'created', after: { packKey, controlsCreated, tasksCreated, mappingsCreated, policyLinksCreated }, summary: `Pack "${pack.name}" installed` },
            metadata: { packKey, controlsCreated, tasksCreated, mappingsCreated, policyLinksCreated },
        });

        return {
            packKey: pack.key,
            packName: pack.name,
            framework: pack.framework.key,
            controlsCreated,
            tasksCreated,
            mappingsCreated,
            policyLinksCreated,
        };
    }, { timeout: 60_000, maxWait: 10_000 });

    const plan = await getEffectivePlan(ctx);
    recordFrameworkInstalled({ frameworkKey: result.framework, plan });
    return result;
}

// в”Ђв”Ђв”Ђ Coverage Computation в”Ђв”Ђв”Ђ

export async function computeCoverage(ctx: RequestContext, frameworkKey: string, version?: string) {
    assertCanViewFrameworks(ctx);
    const db = prisma;

    const fw = version
        ? await db.framework.findUnique({ where: { key_version: { key: frameworkKey, version } } })
        : await db.framework.findFirst({ where: { key: frameworkKey } });
    if (!fw) throw notFound('Framework not found');

    const requirements = await db.frameworkRequirement.findMany({
        where: { frameworkId: fw.id },
        orderBy: { sortOrder: 'asc' },
    });

    // Get all tenant control requirement links for this framework
    const links = await runInTenantContext(ctx, (tdb) =>
        tdb.controlRequirementLink.findMany({
            where: { tenantId: ctx.tenantId, requirementId: { in: requirements.map((r) => r.id) } },
            include: {
                control: { select: { id: true, code: true, name: true, status: true } },
                requirement: { select: { id: true, code: true, title: true } },
            },
        })
    );


    const mappedReqIds = new Set(links.map((l) => l.requirementId));
    const mapped = requirements.filter((r) => mappedReqIds.has(r.id));
    const unmapped = requirements.filter((r) => !mappedReqIds.has(r.id));
    const total = requirements.length;
    const coveragePercent = total > 0 ? Math.round((mapped.length / total) * 100) : 0;

    // Group by section
    const sections = [...new Set(requirements.map((r) => r.section || r.category || 'Other'))];
    const bySection = sections.map((s) => {
        const sectionReqs = requirements.filter((r) => (r.section || r.category || 'Other') === s);
        const sectionMapped = sectionReqs.filter((r) => mappedReqIds.has(r.id));
        return {
            section: s,
            total: sectionReqs.length,
            mapped: sectionMapped.length,
            coveragePercent: sectionReqs.length > 0 ? Math.round((sectionMapped.length / sectionReqs.length) * 100) : 0,
        };
    });

    return {
        framework: { key: fw.key, name: fw.name, version: fw.version },
        total,
        mapped: mapped.length,
        unmapped: unmapped.length,
        coveragePercent,
        bySection,
        unmappedRequirements: unmapped.map((r) => ({ code: r.code, title: r.title, section: r.section || r.category })),

        controlMappings: links.map((l) => ({
            requirementCode: l.requirement.code,
            requirementTitle: l.requirement.title,
            controlCode: l.control.code,
            controlName: l.control.name,
            controlStatus: l.control.status,
        })),
    };
}

// в”Ђв”Ђв”Ђ Template Library (global catalog with tenant install status) в”Ђв”Ђв”Ђ

export async function listTemplates(
    ctx: RequestContext,
    filters: { frameworkKey?: string; section?: string; category?: string; search?: string }
) {
    assertCanViewFrameworks(ctx);
    const db = prisma;


    const where: Prisma.ControlTemplateWhereInput = {};
    if (filters.frameworkKey) {
        const fw = await db.framework.findFirst({ where: { key: filters.frameworkKey } });
        if (!fw) throw notFound('Framework not found');
        where.requirementLinks = { some: { requirement: { frameworkId: fw.id } } };
    }
    if (filters.category) {
        where.category = filters.category;
    }
    if (filters.search) {
        where.OR = [
            { code: { contains: filters.search } },
            { title: { contains: filters.search } },
        ];
    }

    const templates = await db.controlTemplate.findMany({
        where,
        include: {
            tasks: true,
            requirementLinks: { include: { requirement: { include: { framework: true } } } },
            packLinks: { include: { pack: true } },
        },
        orderBy: { code: 'asc' },
    });

    // Check install status per template for this tenant
    const existingControls = await runInTenantContext(ctx, (tdb) =>
        tdb.control.findMany({
            where: { tenantId: ctx.tenantId, code: { in: templates.map((t) => t.code) } },
            select: { code: true },
        })
    );

    const installedCodes = new Set(existingControls.map((c) => c.code));

    // Filter by section if specified (section comes from linked requirement)
    let result = templates;
    if (filters.section) {
        result = templates.filter((t) =>

            t.requirementLinks.some((rl) => (rl.requirement.section || rl.requirement.category) === filters.section)
        );
    }

    return result.map((t) => ({
        id: t.id,
        code: t.code,
        title: t.title,
        description: t.description,
        category: t.category,
        defaultFrequency: t.defaultFrequency,
        isGlobal: t.isGlobal,
        installed: installedCodes.has(t.code),
        tasks: t.tasks.map((tt) => ({ id: tt.id, title: tt.title, description: tt.description })),

        requirements: t.requirementLinks.map((rl) => ({
            code: rl.requirement.code,
            title: rl.requirement.title,
            section: rl.requirement.section || rl.requirement.category,
            framework: { key: rl.requirement.framework.key, name: rl.requirement.framework.name },
        })),

        packs: t.packLinks.map((pl) => ({ key: pl.pack.key, name: pl.pack.name })),
    }));
}

// в”Ђв”Ђв”Ђ Install Single Template в”Ђв”Ђв”Ђ

export async function installSingleTemplate(ctx: RequestContext, templateCode: string) {
    assertCanInstallFrameworkPack(ctx);
    const db = prisma;

    const tmpl = await db.controlTemplate.findUnique({
        where: { code: templateCode },
        include: { tasks: true, requirementLinks: true },
    });
    if (!tmpl) throw notFound('Template not found');

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
        for (const tt of tmpl.tasks) {
            await tdb.task.create({
                data: {
                    tenantId: ctx.tenantId,
                    controlId: control.id,
                    title: tt.title,
                    description: tt.description,
                    status: 'OPEN',
                    type: 'TASK',
                    createdByUserId: ctx.userId,
                    assigneeUserId: ctx.userId,
                },
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
    if (!templateCodes || templateCodes.length === 0) throw badRequest('At least one template code required');
    if (templateCodes.length > 100) throw badRequest('Max 100 templates per batch');

    const db = prisma;
    const templates = await db.controlTemplate.findMany({
        where: { code: { in: templateCodes } },
        include: { tasks: true, requirementLinks: true },
    });
    const foundCodes = new Set(templates.map((t) => t.code));
    const notFound_codes = templateCodes.filter((c) => !foundCodes.has(c));
    if (notFound_codes.length > 0) throw badRequest(`Templates not found: ${notFound_codes.join(', ')}`);

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

            for (const tt of tmpl.tasks) {
                await tdb.task.create({
                    data: {
                        tenantId: ctx.tenantId,
                        controlId: control.id,
                        title: tt.title,
                        description: tt.description,
                        status: 'OPEN',
                        type: 'TASK',
                        createdByUserId: ctx.userId,
                        assigneeUserId: ctx.userId,
                    },
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
