/**
 * Issue usecase — the audit **evidence-bundle / freeze** surface.
 *
 * Issue vs Task — the deliberate split (see
 * `docs/implementation-notes/2026-07-14-issue-vs-task.md`):
 *
 *   • **Task** is the unified work-item (the `Task` aggregate + BullMQ
 *     jobs, list at `/tasks`). It is the single canonical model for
 *     "a piece of work someone owns", and `usecases/task.ts` is the
 *     single canonical implementation of every work-item mutation —
 *     including the four-eyes reviewer gate, the assignee≠reviewer
 *     SoD guard, `assertActiveMembers`, source reconciliation and
 *     `bumpEntityCacheVersion`.
 *   • **Issue** used to carry a PARALLEL work-item surface here
 *     (list/get/create/update/status/assign/link/comment/watch/bulk)
 *     that delegated to the same `TaskRepository` rows while
 *     skipping several of those steps. Its `/issues` routes were
 *     retired, leaving the functions with no HTTP entry point, so
 *     they were deleted rather than left as a second implementation
 *     someone could re-wire. Work-item behaviour has exactly one
 *     home: `usecases/task.ts`.
 *
 * What remains is the evidence-bundle lifecycle that three
 * `/api/t/:slug/issues/:issueId/bundles*` routes still call. The
 * underlying `IssueEvidenceBundle` Prisma models are gone, so
 * `EvidenceBundleRepository` is a deprecated stub: the read paths
 * return empty, the write paths throw `deprecatedResource`. The
 * policy gates below still run first, so the routes fail closed for
 * unauthorised callers rather than leaking a deprecation notice.
 */
import { RequestContext } from '../types';
import { EvidenceBundleRepository } from '../repositories/EvidenceBundleRepository';
import { assertCanReadIssues, assertCanManageBundles, assertCanFreeze } from '../policies/issue.policies';
import { logEvent } from '../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { notFound } from '@/lib/errors/types';

// ─── Evidence Bundles (deprecated stubs) ───

export async function listBundles(ctx: RequestContext, issueId: string) {
    assertCanReadIssues(ctx);
    return runInTenantContext(ctx, (db) => EvidenceBundleRepository.listByIssue(db, ctx, issueId));
}

export async function getBundle(ctx: RequestContext, bundleId: string) {
    assertCanReadIssues(ctx);
    return runInTenantContext(ctx, (db) => EvidenceBundleRepository.getById(db, ctx, bundleId));
}

export async function createBundle(ctx: RequestContext, issueId: string, name: string) {
    assertCanManageBundles(ctx);
    return runInTenantContext(ctx, async (db) => {
        const bundle = await EvidenceBundleRepository.create(db, ctx, issueId, name);
        await logEvent(db, ctx, {
            action: 'BUNDLE_CREATED',
            entityType: 'Issue',
            entityId: issueId,
            details: `Evidence bundle "${name}" created`,
            detailsJson: { category: 'entity_lifecycle', entityName: 'Issue', operation: 'created', summary: 'BUNDLE_CREATED' },
            metadata: { bundleId: bundle.id, name },
        });
        return bundle;
    });
}

export async function freezeBundle(ctx: RequestContext, bundleId: string) {
    assertCanFreeze(ctx);
    return runInTenantContext(ctx, async (db) => {
        const bundle = await EvidenceBundleRepository.freeze(db, ctx, bundleId);
        if (!bundle) throw notFound('Bundle not found');
        await logEvent(db, ctx, {
            action: 'BUNDLE_FROZEN',
            entityType: 'Issue',
            entityId: bundle.issueId,
            details: `Evidence bundle "${bundle.name}" frozen — now immutable`,
            // Audit Coherence S8 (2026-05-24) — was tagged
            // `status_change` with hardcoded null fromStatus, but
            // bundle freeze is a one-shot entity_lifecycle event on
            // the bundle (not a status transition on the issue).
            // Re-categorising so SIEM filters on `status_change`
            // see only real Task transitions.
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'EvidenceBundle',
                operation: 'frozen',
                summary: 'BUNDLE_FROZEN',
            },
            metadata: { bundleId: bundle.id },
        });
        return bundle;
    });
}

export async function addBundleItem(ctx: RequestContext, bundleId: string, data: { entityType: string; entityId: string; label?: string }) {
    assertCanManageBundles(ctx);
    return runInTenantContext(ctx, async (db) => {
        const item = await EvidenceBundleRepository.addItem(db, ctx, bundleId, data);
        if (!item) throw notFound('Bundle not found');
        return item;
    });
}

export async function listBundleItems(ctx: RequestContext, bundleId: string) {
    assertCanReadIssues(ctx);
    return runInTenantContext(ctx, (db) => EvidenceBundleRepository.listItems(db, ctx, bundleId));
}
