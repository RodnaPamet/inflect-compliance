 
import { RequestContext } from '../../types';
import { assertCanViewFrameworks } from '../../policies/framework.policies';
import { notFound } from '@/lib/errors/types';
import { prisma } from '@/lib/prisma';
import { runInTenantContext } from '@/lib/db-context';
import { withoutReferenceTwins } from '../../domain/framework-representation';

// в”Ђв”Ђв”Ђ Framework Catalog (global, no tenant filter needed) в”Ђв”Ђв”Ђ

export async function listFrameworks(ctx: RequestContext) {
    assertCanViewFrameworks(ctx);
    const db = prisma;
    // RETIRED FRAMEWORKS ARE FILTERED FROM THE OFFER, NOT FROM THE RECORD.
    // `Framework.retiredAt` means the product no longer ships a standard. A
    // tenant that installed one before keeps every control, link and report it
    // had — which is why the row is retired rather than deleted — so only the
    // surfaces that OFFER a framework filter on it. Reads about what a tenant
    // already HAS (soa, gap-analysis, agent-coverage, policy-template-mapping,
    // test-readiness) deliberately do not.
    //
    // A library row beside its catalogue twin is left out of the offer for the
    // same reason; see `withoutReferenceTwins`.
    const rows = await db.framework.findMany({
        where: { retiredAt: null },
        include: { _count: { select: { requirements: true, packs: true } } },
        orderBy: { key: 'asc' },
    });
    return withoutReferenceTwins(rows, (f) => f._count.packs);
}

/**
 * Installable-framework catalog for the onboarding wizard.
 *
 * Returns every framework that carries at least one control pack — i.e.
 * the frameworks a tenant can actually "set up" (a pack is what install
 * turns into a baseline control register). Frameworks that exist as
 * requirement-only reference data (no pack) are intentionally excluded:
 * selecting one in onboarding would install nothing.
 *
 * The shape is the minimal projection the picker cards need. As packs are
 * authored for more frameworks they appear here automatically — the
 * onboarding picker is data-driven, never a hand-maintained list.
 */
export async function listInstallableFrameworks(ctx: RequestContext) {
    assertCanViewFrameworks(ctx);
    const db = prisma;
    const frameworks = await db.framework.findMany({
        where: { packs: { some: {} }, retiredAt: null },
        include: {
            _count: { select: { requirements: true } },
            packs: {
                select: {
                    key: true,
                    name: true,
                    description: true,
                    templateLinks: { select: { templateId: true } },
                },
                orderBy: { key: 'asc' },
            },
        },
        orderBy: { key: 'asc' },
    });
    return frameworks.map((f) => ({
        key: f.key,
        name: f.name,
        version: f.version,
        description: f.description,
        kind: f.kind,
        requirementCount: f._count.requirements,
        // DISTINCT templates across the packs. A framework whose packs are its
        // subcategories links the shared controls into every one of them, so
        // a sum would count the EU UAS core seven times over.
        controlCount: new Set(f.packs.flatMap((p) => p.templateLinks.map((l) => l.templateId))).size,
        // More than one pack means the tenant chooses which to install — the
        // onboarding picker and the install wizard both require at least one.
        packs: f.packs.map((p) => ({
            key: p.key,
            name: p.name,
            description: p.description,
            controlCount: p.templateLinks.length,
        })),
    }));
}

/**
 * Resolve the installable pack keys for a set of framework keys, grouped by
 * the (lowercased) framework key. One catalog query; case-insensitive so
 * callers may pass canonical DB keys ('ISO27001') or legacy lowercase values
 * ('iso27001'). Used by onboarding to install whatever a tenant selected
 * without a hand-maintained framework→pack map.
 */
export async function resolveFrameworkPackKeys(
    ctx: RequestContext,
    frameworkKeys: string[],
): Promise<Map<string, string[]>> {
    assertCanViewFrameworks(ctx);
    const grouped = new Map<string, string[]>();
    if (frameworkKeys.length === 0) return grouped;
    const wanted = new Set(frameworkKeys.map((k) => k.toLowerCase()));
    const packs = await prisma.frameworkPack.findMany({
        select: { key: true, framework: { select: { key: true } } },
    });
    for (const p of packs) {
        const fwKey = p.framework.key.toLowerCase();
        if (!wanted.has(fwKey)) continue;
        const list = grouped.get(fwKey) ?? [];
        list.push(p.key);
        grouped.set(fwKey, list);
    }
    return grouped;
}

export async function getFramework(ctx: RequestContext, frameworkKey: string, version?: string) {
    assertCanViewFrameworks(ctx);
    const db = prisma;
    const where = version ? { key_version: { key: frameworkKey, version } } : undefined;
    const fw = where
        ? await db.framework.findUnique({ where, include: { _count: { select: { requirements: true, packs: true } } } })
        : await db.framework.findFirst({ where: { key: frameworkKey }, include: { _count: { select: { requirements: true, packs: true } } } });
    if (!fw) throw notFound('Framework not found');
    return fw;
}

export async function getFrameworkRequirements(ctx: RequestContext, frameworkKey: string, version?: string) {
    assertCanViewFrameworks(ctx);
    const db = prisma;
    const fw = version
        ? await db.framework.findUnique({ where: { key_version: { key: frameworkKey, version } } })
        : await db.framework.findFirst({ where: { key: frameworkKey } });
    if (!fw) throw notFound('Framework not found');
    return db.frameworkRequirement.findMany({
        where: { frameworkId: fw.id },
        orderBy: { sortOrder: 'asc' },
    });
}

export async function listFrameworkPacks(ctx: RequestContext, frameworkKey: string, version?: string) {
    assertCanViewFrameworks(ctx);
    const db = prisma;
    const fw = version
        ? await db.framework.findUnique({ where: { key_version: { key: frameworkKey, version } } })
        : await db.framework.findFirst({ where: { key: frameworkKey } });
    if (!fw) throw notFound('Framework not found');
    const packs = await db.frameworkPack.findMany({
        where: { frameworkId: fw.id },
        include: { _count: { select: { templateLinks: true } } },
    });
    if (packs.length === 0) return [];
    // Which of them this workspace chose (`TenantFrameworkPack`, written by
    // the install): the scope a multi-pack framework's coverage counts, and
    // the packs the Packs tab offers to remove (#4372).
    const chosen = await runInTenantContext(ctx, (tdb) =>
        tdb.tenantFrameworkPack.findMany({
            where: { tenantId: ctx.tenantId, frameworkId: fw.id },
            select: { packId: true },
            take: packs.length,
        }),
    );
    const chosenIds = new Set(chosen.map((c) => c.packId));
    return packs.map((p) => ({ ...p, chosen: chosenIds.has(p.id) }));
}
