import { RequestContext } from '../../types';
import { ControlTemplateRepository } from '../../repositories/ControlTemplateRepository';
import { ControlRepository } from '../../repositories/ControlRepository';
import { FrameworkRepository } from '../../repositories/FrameworkRepository';
import {
    assertCanReadControls, assertCanCreateControl, assertCanMapFramework,
} from '../../policies/control.policies';
import { logEvent } from '../../events/audit';
import { notFound } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import { Prisma } from '@prisma/client';
import { controlDataFromTemplate, resolveRelatedPolicyIds } from './template-projection';

// ─── Templates ───

export async function listControlTemplates(ctx: RequestContext) {
    assertCanReadControls(ctx);
    return runInTenantContext(ctx, (db) =>
        ControlTemplateRepository.list(db)
    );
}

export async function installControlsFromTemplate(ctx: RequestContext, templateIds: string[]) {
    assertCanCreateControl(ctx);

    return runInTenantContext(ctx, async (db) => {
        // `skipped` distinguishes a template whose control already existed
        // (idempotent no-op) from one actually installed — so the "Installed N"
        // toast counts only real installs, not skipped existing controls.
        // `unresolvedTemplateId` is set on a row when a requested id did not
        // resolve to a template — surfaced to the caller instead of being
        // silently dropped (the row is marked `skipped: true` so it never
        // inflates the caller's install count).
        const results: Array<{ templateCode: string; controlId: string; tasksCreated: number; requirementsLinked: number; skipped: boolean; unresolvedTemplateId?: string }> = [];

        // Built at most once per install call, on first use — most installs
        // touch templates with no relatedPolicies, and this avoids a query
        // per template inside the loop.
        let policyIndex: Map<string, string> | null = null;
        const policyIdByTitle = async () => {
            if (policyIndex) return policyIndex;
            const rows = await db.policy.findMany({
                where: { tenantId: ctx.tenantId },
                select: { id: true, title: true },
            });
            policyIndex = new Map(rows.map((p) => [p.title.trim().toLowerCase(), p.id]));
            return policyIndex;
        };

        for (const templateId of templateIds) {
            const template = await ControlTemplateRepository.getById(db, templateId);
            if (!template) {
                // Record the unresolved id rather than continuing silently, so a
                // stale/typo'd templateId is visible in the response.
                results.push({
                    templateCode: '',
                    controlId: '',
                    tasksCreated: 0,
                    requirementsLinked: 0,
                    skipped: true,
                    unresolvedTemplateId: templateId,
                });
                continue;
            }

            // Check if control with this code already exists for tenant
            const existing = await db.control.findFirst({
                where: { tenantId: ctx.tenantId, code: template.code },
            });
            if (existing) {
                // Skip — idempotent, don't create duplicates
                results.push({
                    templateCode: template.code,
                    controlId: existing.id,
                    tasksCreated: 0,
                    requirementsLinked: 0,
                    skipped: true,
                });
                continue;
            }

            // Create control from template — via the SHARED projection, so
            // this endpoint and the framework install wizard produce the
            // same Control. Until 2026-08-06 this path wrote only
            // code/name/category/frequency, silently dropping the objective,
            // success criteria, testing methodology and policy links that
            // controls.prisma documents as install behaviour.
            const control = await db.control.create({
                data: controlDataFromTemplate(template, {
                    tenantId: ctx.tenantId,
                    userId: ctx.userId,
                }),
            });

            // Resolve the template's relatedPolicies to this tenant's
            // policies. Unknown titles are dropped: a shared template names
            // policies a given tenant may not have written yet, and failing
            // the install for that would be wrong.
            // Only touch the policy table when the template actually names
            // policies — most do not, and the earlier form called the
            // resolver unconditionally, which defeated the laziness it
            // documented and made every install pay for a query it did not
            // need.
            const policyIds = template.relatedPolicies
                ? resolveRelatedPolicyIds(template.relatedPolicies, await policyIdByTitle())
                : [];
            if (policyIds.length > 0) {
                await db.policyControlLink.createMany({
                    data: policyIds.map((policyId) => ({
                        tenantId: ctx.tenantId,
                        policyId,
                        controlId: control.id,
                    })),
                    skipDuplicates: true,
                });
            }

            // Create unified Task rows (NOT legacy controlTask) so template
            // controls show real task counts in the list and roll up into
            // readiness — matching the framework install wizard. Batched into a
            // single createMany (was a per-task create in a loop). The field-
            // encryption extension encrypts Task.description on createMany the
            // same as on create — `createMany` is in its WRITE_ACTIONS set and
            // the array `data` is walked per element.
            const tasksCreated = template.tasks.length;
            if (tasksCreated > 0) {
                await db.task.createMany({
                    data: template.tasks.map((tplTask): Prisma.TaskCreateManyInput => ({
                        tenantId: ctx.tenantId,
                        controlId: control.id,
                        title: tplTask.title,
                        description: tplTask.description,
                        status: 'OPEN',
                        type: 'TASK',
                        createdByUserId: ctx.userId,
                        assigneeUserId: ctx.userId,
                    })),
                });
            }

            // Create control↔requirement links in the CANONICAL table
            // (controlRequirementLink) — the one SoA, per-framework coverage,
            // readiness and every posture surface read. The framework install
            // wizard writes the same table; template-installed controls now
            // count toward posture instead of rendering as unmapped. Batched
            // into a single createMany (was a per-link upsert in a loop). The
            // control is brand-new, so the only possible unique collision is a
            // template that lists the same requirement twice — `skipDuplicates`
            // handles that, the role the per-link upsert used to serve.
            const requirementsLinked = template.requirementLinks.length;
            if (requirementsLinked > 0) {
                await db.controlRequirementLink.createMany({
                    data: template.requirementLinks.map((rl): Prisma.ControlRequirementLinkCreateManyInput => ({
                        tenantId: ctx.tenantId,
                        controlId: control.id,
                        requirementId: rl.requirementId,
                    })),
                    skipDuplicates: true,
                });
            }

            await logEvent(db, ctx, {
                action: 'CONTROL_INSTALLED_FROM_TEMPLATE',
                entityType: 'Control',
                entityId: control.id,
                details: `Installed control from template: ${template.code} — ${template.title}`,
                detailsJson: { category: 'entity_lifecycle', entityName: 'Control', operation: 'created', after: { code: template.code, name: template.title, templateId, tasksCreated, requirementsLinked }, summary: `Installed from template: ${template.code}` },
                metadata: { templateId, tasksCreated, requirementsLinked },
            });

            results.push({
                templateCode: template.code,
                controlId: control.id,
                tasksCreated,
                requirementsLinked,
                skipped: false,
            });
        }

        return results;
    });
}

// ─── Frameworks (read-only) ───

export async function listFrameworks(ctx: RequestContext) {
    assertCanReadControls(ctx);
    return runInTenantContext(ctx, (db) =>
        FrameworkRepository.listFrameworks(db)
    );
}

export async function listFrameworkRequirements(ctx: RequestContext, frameworkKey: string) {
    assertCanReadControls(ctx);
    return runInTenantContext(ctx, async (db) => {
        const result = await FrameworkRepository.listRequirements(db, frameworkKey);
        if (result === null) throw notFound('Framework not found');
        return result;
    });
}

// ─── Requirement Mapping ───

export async function mapRequirementToControl(ctx: RequestContext, controlId: string, requirementId: string) {
    assertCanMapFramework(ctx);
    return runInTenantContext(ctx, async (db) => {
        const control = await db.control.findFirst({ where: { id: controlId, tenantId: ctx.tenantId } });
        if (!control) throw notFound('Control not found');

        // Canonical control↔requirement table — the same one SoA / coverage /
        // readiness read. Upsert keeps the action idempotent (re-mapping an
        // existing link is a no-op rather than a unique-constraint error).
        const link = await db.controlRequirementLink.upsert({
            where: {
                controlId_requirementId: { controlId, requirementId },
            },
            create: { tenantId: ctx.tenantId, controlId, requirementId },
            update: {},
            include: { requirement: { include: { framework: { select: { name: true } } } } },
        });
        return link;
    });
}

export async function unmapRequirementFromControl(ctx: RequestContext, controlId: string, requirementId: string) {
    assertCanMapFramework(ctx);
    return runInTenantContext(ctx, async (db) => {
        const control = await db.control.findFirst({ where: { id: controlId, tenantId: ctx.tenantId } });
        if (!control) throw notFound('Control not found');

        const link = await db.controlRequirementLink.findFirst({
            where: { tenantId: ctx.tenantId, controlId, requirementId },
        });
        if (!link) throw notFound('Mapping not found');

        await db.controlRequirementLink.delete({ where: { id: link.id } });
        return { success: true };
    });
}

/**
 * Framework mappings for one control (#102 item 1 — tab-lazy).
 *
 * The Mappings tab fetches this on demand instead of reading the
 * eager `frameworkMappings` array that `getById` used to carry. The
 * payload shape matches what the page already renders.
 */
export async function listControlMappings(ctx: RequestContext, controlId: string) {
    assertCanReadControls(ctx);
    return runInTenantContext(ctx, async (db) => {
        const control = await db.control.findFirst({
            where: { id: controlId, tenantId: ctx.tenantId },
        });
        if (!control) throw notFound('Control not found');
        return ControlRepository.listControlRequirementLinks(db, ctx, controlId);
    });
}
