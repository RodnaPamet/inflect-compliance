/**
 * Framework-version delta-gap engine (Epic Regwatch 2A).
 *
 * When a framework version N+1 lands in the library, this tells each AFFECTED
 * tenant EXACTLY what changed and what their NEW gap is:
 *   - ADDED requirements → new uncovered gaps (no control/evidence yet);
 *   - CHANGED requirements → the tenant's controls mapped to them are FLAGGED
 *     for re-review (`Control.status = NEEDS_REVIEW`) — they may no longer
 *     satisfy the changed obligation;
 *   - REMOVED requirements → the obligation retires.
 *
 * The requirement DIFF itself is computed by the existing library machinery
 * (`computeRequirementDiff` / the version-history in `Framework.metadataJson`).
 * This engine's contribution is the PER-TENANT personalisation + surfacing.
 *
 * Global orchestration runs under `withTenantDb(tenantId, …)` per affected
 * tenant, so every per-tenant write is RLS-scoped. Findings are materialised
 * only on explicit request, idempotently, source-tagged `FRAMEWORK_UPDATE`.
 */
import { ControlStatus, FrameworkDeltaStatus } from '@prisma/client';

import prisma from '@/lib/prisma';
import { parseEnumListFilter } from '@/app-layer/domain/list-filter';
import { withTenantDb } from '@/lib/db-context';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { assertCanRead, assertCanWrite } from '@/app-layer/policies/common';
import { badRequest, notFound } from '@/lib/errors/types';
import { createFinding } from '@/app-layer/usecases/finding';
import { parseHistoryFromMetadata } from '@/app-layer/libraries/version-history';
import type { RequestContext } from '@/app-layer/types';

const FRAMEWORK_UPDATE_SOURCE = 'FRAMEWORK_UPDATE';

export interface FrameworkDiffInput {
    frameworkKey: string;
    fromVersion: string;
    toVersion: string;
    addedCodes: string[];
    changedCodes: string[];
    removedCodes: string[];
    changelog?: string;
}

// ─── Diff recording (global) ────────────────────────────────────────

/**
 * Persist a framework-version diff (idempotent per key+versions). GLOBAL —
 * framework structure is the same for every tenant. Returns the diff id.
 */
export async function recordFrameworkVersionDiff(input: FrameworkDiffInput): Promise<{ diffId: string }> {
    const diff = await prisma.frameworkVersionDiff.upsert({
        where: {
            frameworkKey_fromVersion_toVersion: {
                frameworkKey: input.frameworkKey, fromVersion: input.fromVersion, toVersion: input.toVersion,
            },
        },
        update: {
            addedCodesJson: JSON.stringify(input.addedCodes),
            changedCodesJson: JSON.stringify(input.changedCodes),
            removedCodesJson: JSON.stringify(input.removedCodes),
            changelog: input.changelog ?? null,
        },
        create: {
            frameworkKey: input.frameworkKey, fromVersion: input.fromVersion, toVersion: input.toVersion,
            addedCodesJson: JSON.stringify(input.addedCodes),
            changedCodesJson: JSON.stringify(input.changedCodes),
            removedCodesJson: JSON.stringify(input.removedCodes),
            changelog: input.changelog ?? null,
        },
        select: { id: true },
    });
    return { diffId: diff.id };
}

/**
 * Read the framework's version-history (populated by the library importer on
 * each version import) and record a diff for its most recent transition. The
 * "version added is the trigger" path. Returns null if there is no prior
 * version to diff against.
 */
export async function recordDiffFromVersionHistory(frameworkKey: string): Promise<{ diffId: string } | null> {
    const fw = await prisma.framework.findFirst({ where: { key: frameworkKey }, orderBy: { version: 'desc' } });
    if (!fw) throw notFound(`Framework not found: ${frameworkKey}`);
    const history = parseHistoryFromMetadata(fw.metadataJson);
    if (history.entries.length < 2) return null; // need a prior version to diff against
    const latest = history.entries[history.entries.length - 1];
    const prior = history.entries[history.entries.length - 2];
    if (latest.addedCodes.length === 0 && latest.changedCodes.length === 0 && latest.removedCodes.length === 0) {
        return null; // no change in the latest transition
    }
    return recordFrameworkVersionDiff({
        frameworkKey,
        fromVersion: String(prior.version),
        toVersion: String(latest.version),
        addedCodes: latest.addedCodes,
        changedCodes: latest.changedCodes,
        removedCodes: latest.removedCodes,
        changelog:
            `${frameworkKey} updated to v${latest.version}: ` +
            `${latest.addedCodes.length} added, ${latest.changedCodes.length} changed, ${latest.removedCodes.length} removed.`,
    });
}

// ─── Per-tenant propagation (global orchestration, per-tenant RLS writes) ──

// Typed against the real enum rather than `as never`'d at the call site: this
// is a compile-time constant (not user input, so not a `parseEnumListFilter`
// site), but naming the enum makes a renamed/removed member a build failure
// instead of a runtime `PrismaClientValidationError`.
const REVIEWABLE_CONTROL_STATUSES: readonly ControlStatus[] = [
    ControlStatus.IMPLEMENTED,
    ControlStatus.IMPLEMENTING,
    ControlStatus.IN_PROGRESS,
];

export interface PropagateResult {
    diffId: string;
    tenantsAffected: number;
}

/**
 * Fan a recorded diff out to every tenant that has the framework INSTALLED
 * (derived: has ≥1 control linked to one of the framework's requirements).
 * Per tenant (RLS-scoped): compute the new gaps + flag controls mapped to
 * changed requirements + upsert a TenantFrameworkDelta + notify the tenant's
 * active members. Idempotent per (tenant, diff).
 */
export async function propagateFrameworkDelta(diffId: string): Promise<PropagateResult> {
    const diff = await prisma.frameworkVersionDiff.findUnique({ where: { id: diffId } });
    if (!diff) throw notFound('Framework version diff not found');
    const addedCodes = JSON.parse(diff.addedCodesJson) as string[];
    const changedCodes = JSON.parse(diff.changedCodesJson) as string[];

    // Tenants with the framework installed (distinct — global read).
    const links = await prisma.controlRequirementLink.findMany({
        where: { requirement: { framework: { key: diff.frameworkKey } } },
        select: { tenantId: true },
        distinct: ['tenantId'],
    });
    const tenantIds = links.map((l) => l.tenantId).filter(Boolean);

    let affected = 0;
    // Intentional per-tenant fan-out: each iteration runs in its own RLS-scoped
    // withTenantDb transaction, so its reads/writes cannot be hoisted into one
    // cross-tenant query. Bounded by the installed-tenant count.
    for (const tenantId of tenantIds) { // guardrail-allow: n+1
        await withTenantDb(tenantId, async (db) => {
            // Controls mapped to a CHANGED requirement → flag for re-review.
            const flagged = changedCodes.length
                ? await db.controlRequirementLink.findMany({
                      where: {
                          tenantId,
                          requirement: { framework: { key: diff.frameworkKey }, code: { in: changedCodes } },
                          control: { status: { in: [...REVIEWABLE_CONTROL_STATUSES] } },
                      },
                      select: { controlId: true },
                  })
                : [];
            const flaggedIds = [...new Set(flagged.map((f) => f.controlId))];
            if (flaggedIds.length) {
                await db.control.updateMany({
                    where: { id: { in: flaggedIds }, tenantId },
                    data: { status: 'NEEDS_REVIEW' },
                });
            }

            await db.tenantFrameworkDelta.upsert({
                where: { tenantId_diffId: { tenantId, diffId } },
                update: {
                    newGapCodesJson: JSON.stringify(addedCodes),
                    flaggedControlIdsJson: JSON.stringify(flaggedIds),
                    newGapCount: addedCodes.length,
                    flaggedControlCount: flaggedIds.length,
                },
                create: {
                    tenantId, diffId, frameworkKey: diff.frameworkKey,
                    fromVersion: diff.fromVersion, toVersion: diff.toVersion,
                    newGapCodesJson: JSON.stringify(addedCodes),
                    flaggedControlIdsJson: JSON.stringify(flaggedIds),
                    newGapCount: addedCodes.length,
                    flaggedControlCount: flaggedIds.length,
                    status: 'NEW',
                },
            });

            // Notify the tenant's active members (in-app, deduped per user/day).
            const members = await db.tenantMembership.findMany({
                where: { tenantId, status: 'ACTIVE' },
                select: { userId: true },
            });
            const day = diff.createdAt.toISOString().slice(0, 10);
            const title = `${diff.frameworkKey} updated to v${diff.toVersion}`;
            const message =
                `${addedCodes.length} new requirement(s) affect you` +
                (flaggedIds.length ? `, ${flaggedIds.length} control(s) need re-review.` : '.');
            await db.notification.createMany({
                data: members.map((m) => ({
                    tenantId, userId: m.userId, type: 'GENERAL' as const, title, message,
                    linkUrl: `/framework-updates`,
                    dedupeKey: `${tenantId}:FRAMEWORK_UPDATE:${diffId}:${m.userId}:${day}`,
                })),
                skipDuplicates: true,
            });
            affected++;
        });
    }
    return { diffId, tenantsAffected: affected };
}

// ─── Tenant read + review surface ───────────────────────────────────

export async function listTenantFrameworkDeltas(ctx: RequestContext, opts: { status?: string; take?: number } = {}) {
    assertCanRead(ctx);
    // `opts.status` is a raw `?status=` query-string value — the `as never`
    // this replaces silenced the compiler but not Prisma, which 500'd on a
    // comma-joined multi-select or a status from another entity's enum.
    const status = parseEnumListFilter<FrameworkDeltaStatus>(
        opts.status,
        Object.values(FrameworkDeltaStatus),
        'framework delta status',
    );
    return runInTenantContext(ctx, (db) =>
        db.tenantFrameworkDelta.findMany({
            where: { tenantId: ctx.tenantId, status },
            orderBy: { createdAt: 'desc' },
            take: opts.take ?? 50,
            include: { diff: true },
        }),
    );
}

export async function getTenantFrameworkDelta(ctx: RequestContext, id: string) {
    assertCanRead(ctx);
    const delta = await runInTenantContext(ctx, (db) =>
        db.tenantFrameworkDelta.findFirst({ where: { id, tenantId: ctx.tenantId }, include: { diff: true } }),
    );
    if (!delta) throw notFound('Framework delta not found');
    return delta;
}

/** Mark a delta REVIEWED or DISMISSED (a human action). */
export async function reviewTenantFrameworkDelta(
    ctx: RequestContext,
    id: string,
    status: 'REVIEWED' | 'DISMISSED',
): Promise<void> {
    assertCanWrite(ctx);
    if (status !== 'REVIEWED' && status !== 'DISMISSED') throw badRequest('Invalid status');
    const res = await runInTenantContext(ctx, (db) =>
        db.tenantFrameworkDelta.updateMany({
            where: { id, tenantId: ctx.tenantId },
            data: { status, reviewedByUserId: ctx.userId, reviewedAt: new Date() },
        }),
    );
    if (res.count === 0) throw notFound('Framework delta not found');
}

/**
 * Explicitly materialise Findings for a delta's new gaps — idempotent (one
 * finding per requirement code, deduped on sourceKind+sourceRef) and
 * source-tagged `FRAMEWORK_UPDATE`. A human opts into this from the UI.
 */
export async function materializeDeltaFindings(ctx: RequestContext, deltaId: string): Promise<{ created: number }> {
    assertCanWrite(ctx);
    const delta = await getTenantFrameworkDelta(ctx, deltaId);
    const newGapCodes = JSON.parse(delta.newGapCodesJson) as string[];
    let created = 0;
    // Bounded idempotency check: one lookup per new-gap code before create, so a
    // re-run never double-creates. Bounded by the delta's added-requirement count.
    for (const code of newGapCodes) { // guardrail-allow: n+1
        const sourceRef = `${delta.frameworkKey}:${delta.toVersion}:${code}`;
        const existing = await runInTenantContext(ctx, (db) =>
            db.finding.findFirst({
                where: { tenantId: ctx.tenantId, sourceKind: FRAMEWORK_UPDATE_SOURCE, sourceRef, deletedAt: null },
                select: { id: true },
            }),
        );
        if (existing) continue; // idempotent
        await createFinding(ctx, {
            severity: 'MEDIUM',
            type: 'NONCONFORMITY',
            title: `New requirement ${code} (${delta.frameworkKey} v${delta.toVersion})`,
            description: `Requirement ${code} was added in ${delta.frameworkKey} v${delta.toVersion} and has no mapped control yet.`,
            sourceKind: FRAMEWORK_UPDATE_SOURCE,
            sourceRef,
        });
        created++;
    }
    return { created };
}
