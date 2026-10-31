import { RequestContext } from '../../types';
import { assertCanViewFrameworks } from '../../policies/framework.policies';
import { runInTenantContext } from '@/lib/db-context';
import { notFound } from '@/lib/errors/types';
import { prisma } from '@/lib/prisma';

// There is no requirement writer here. Framework requirements are one global
// catalogue every workspace reads, maintained by the deploy-time seeding and
// import scripts; the in-workspace `upsertRequirements` that rewrote them was
// removed (#4125 follow-up).

// в”Ђв”Ђв”Ђ Diff Computation в”Ђв”Ђв”Ђ

export async function computeRequirementsDiff(
    ctx: RequestContext,
    frameworkKeyFrom: string,
    frameworkKeyTo: string
) {
    assertCanViewFrameworks(ctx);
    const db = prisma;

    const fwFrom = await db.framework.findFirst({ where: { key: frameworkKeyFrom } });
    const fwTo = await db.framework.findFirst({ where: { key: frameworkKeyTo } });
    // Named by side, so the page can say WHICH framework is missing (#4732).
    if (!fwFrom) throw notFound(`Framework "${frameworkKeyFrom}" not found`, { reason: 'DIFF_FROM_NOT_FOUND' });
    if (!fwTo) throw notFound(`Framework "${frameworkKeyTo}" not found`, { reason: 'DIFF_TO_NOT_FOUND' });

    const reqsFrom = await db.frameworkRequirement.findMany({
        where: { frameworkId: fwFrom.id, deprecatedAt: null },
        orderBy: { sortOrder: 'asc' },
    });
    const reqsTo = await db.frameworkRequirement.findMany({
        where: { frameworkId: fwTo.id, deprecatedAt: null },
        orderBy: { sortOrder: 'asc' },
    });

    const fromMap = new Map(reqsFrom.map((r) => [r.code, r]));
    const toMap = new Map(reqsTo.map((r) => [r.code, r]));

    const added: Array<{ code: string; title: string; section: string | null | undefined }> = [];
    const removed: Array<{ code: string; title: string; section: string | null | undefined }> = [];
    // `description` rides beside title and section: a description change was
    // counted and named, and the page had nothing to show for it (#4732).
    type ChangedSide = { title: string; section: string | null | undefined; description: string | null };
    const changed: Array<{ code: string; changes: string[]; from: ChangedSide; to: ChangedSide }> = [];

    // Added in "to" but not in "from"
    for (const [code, req] of toMap) {
        if (!fromMap.has(code)) {
            added.push({ code, title: req.title, section: req.section || req.category });
        }
    }

    // Removed from "from" but not in "to"
    for (const [code, req] of fromMap) {
        if (!toMap.has(code)) {
            removed.push({ code, title: req.title, section: req.section || req.category });
        }
    }

    // Changed (title or section differ)
    for (const [code, reqTo] of toMap) {
        const reqFrom = fromMap.get(code);
        if (reqFrom) {
            const changes: string[] = [];
            if (reqFrom.title !== reqTo.title) changes.push('title');
            if ((reqFrom.section || reqFrom.category) !== (reqTo.section || reqTo.category)) changes.push('section');
            if (reqFrom.description !== reqTo.description) changes.push('description');
            if (changes.length > 0) {
                changed.push({
                    code,
                    changes,
                    from: { title: reqFrom.title, section: reqFrom.section || reqFrom.category, description: reqFrom.description ?? null },
                    to: { title: reqTo.title, section: reqTo.section || reqTo.category, description: reqTo.description ?? null },
                });
            }
        }
    }

    // Compute impact: how many new requirements are unmapped for this tenant
    let unmappedNewCount = 0;
    if (added.length > 0) {
        const newReqIds = added.map((a) => {
            const req = toMap.get(a.code);
            return req?.id;
        }).filter((id): id is string => id !== undefined);

        const existingMappings = await runInTenantContext(ctx, (tdb) =>
            tdb.controlRequirementLink.findMany({
                where: { tenantId: ctx.tenantId, requirementId: { in: newReqIds } },
                select: { requirementId: true },
            })
        );
        const mappedIds = new Set(existingMappings.map((l) => l.requirementId));
        unmappedNewCount = newReqIds.filter((id) => !mappedIds.has(id)).length;
    }

    return {
        from: { key: fwFrom.key, name: fwFrom.name, version: fwFrom.version },
        to: { key: fwTo.key, name: fwTo.name, version: fwTo.version },
        added,
        removed,
        changed,
        summary: {
            added: added.length,
            removed: removed.length,
            changed: changed.length,
            unmappedNewRequirements: unmappedNewCount,
        },
    };
}
