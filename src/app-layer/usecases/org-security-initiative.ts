/**
 * Org security initiatives — portfolio-level programme tracking.
 *
 * Concept ported from Cybether (MIT) — its "Security Projects" tracker.
 * Reimplemented native to the Epic 41 org layer.
 *
 * LOAD-BEARING DISTINCTION: an Initiative is a STRATEGIC, named programme
 * the org tracks across its tenants ("Roll out MFA org-wide", "Achieve
 * SOC 2") with its own lifecycle + progress — DISTINCT from atomic tenant
 * remediation (a unified Task: "fix gap X in tenant Y"). An initiative
 * LINKS tenant work; it doesn't replace it.
 *
 * Org-scoped (global prisma, NOT tenant-scoped → no per-tenant RLS / DEK).
 * Cross-tenant link resolution goes through the SANCTIONED path —
 * `withTenantDb(tenantId, …)` per linked tenant (runs as app_user, RLS
 * enforced via the org's auto-provisioned ADMIN membership) — NEVER by
 * bypassing tenant isolation. `description` is sanitised here. Create +
 * status-change are substantive → they audit.
 */
import type { InitiativeStatus, Prisma } from '@prisma/client';

import prisma from '@/lib/prisma';
import { withTenantDb } from '@/lib/db-context';
import { OrgContext } from '../types';
import { forbidden, badRequest, notFound } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { appendOrgAuditEntry } from '@/lib/audit/org-audit-writer';
import { logger } from '@/lib/observability/logger';

export const INITIATIVE_STATUSES = ['PLANNED', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'CANCELLED'] as const;
export const INITIATIVE_LINK_TYPES = ['CONTROL', 'RISK', 'TASK', 'FINDING'] as const;
const STALE_DAYS = 30;

/** Terminal/"done" statuses per linked entity type for the progress rollup. */
const DONE_STATUS: Record<string, Set<string>> = {
    CONTROL: new Set(['IMPLEMENTED']),
    RISK: new Set(['MITIGATED', 'ACCEPTED', 'CLOSED']),
    TASK: new Set(['RESOLVED', 'CLOSED']),
    FINDING: new Set(['CLOSED']),
};

export interface InitiativeProgress {
    percent: number;
    completed: number;
    total: number;
    /** True when manualProgressPercent overrode the rollup. */
    manual: boolean;
}

function assertRead(ctx: OrgContext) {
    if (!ctx.permissions.canViewPortfolio) {
        throw forbidden('You do not have access to this organization.');
    }
}
function assertWrite(ctx: OrgContext) {
    // Write = canConfigureDashboard (ORG_ADMIN). Initiatives are managed
    // from the org dashboard surface by the same admin who configures it;
    // no separate flag in v1 (all org-write is ORG_ADMIN). Documented.
    if (!ctx.permissions.canConfigureDashboard) {
        throw forbidden('Only an organization admin can manage initiatives.');
    }
}

export function isInitiativeAtRisk(i: { status: InitiativeStatus; targetDate: Date | string | null }): boolean {
    if (i.status === 'BLOCKED') return true;
    if (!i.targetDate || i.status === 'COMPLETED' || i.status === 'CANCELLED') return false;
    return new Date(i.targetDate).getTime() < Date.now();
}

export function isInitiativeStale(i: { status: InitiativeStatus; updatedAt: Date | string }): boolean {
    if (i.status !== 'IN_PROGRESS') return false;
    const days = (Date.now() - new Date(i.updatedAt).getTime()) / (1000 * 60 * 60 * 24);
    return days > STALE_DAYS;
}

/**
 * Pure progress derivation given resolved link completion counts.
 * manualProgressPercent WINS; otherwise completed/total of linked work.
 * Unit-tested directly (no DB).
 */
export function deriveProgress(
    manualProgressPercent: number | null | undefined,
    completed: number,
    total: number,
): InitiativeProgress {
    if (manualProgressPercent != null) {
        return { percent: Math.max(0, Math.min(100, manualProgressPercent)), completed, total, manual: true };
    }
    return { percent: total > 0 ? Math.round((completed / total) * 100) : 0, completed, total, manual: false };
}

/**
 * Resolve linked-work completion ACROSS TENANTS via the sanctioned
 * per-tenant read path. Groups links by tenant, opens one
 * `withTenantDb(tenantId, …)` per tenant (RLS enforced), batch-reads the
 * linked entities, and counts the "done" ones. Never bypasses isolation.
 */
async function resolveLinkCompletion(
    links: Array<{ linkedTenantId: string; entityType: string; entityId: string }>,
): Promise<{ completed: number; total: number }> {
    const total = links.length;
    if (total === 0) return { completed: 0, total: 0 };

    const byTenant = new Map<string, typeof links>();
    for (const l of links) {
        const arr = byTenant.get(l.linkedTenantId) ?? [];
        arr.push(l);
        byTenant.set(l.linkedTenantId, arr);
    }

    let completed = 0;
    // guardrail-allow: n+1 — intentional per-tenant loop: each tenant needs
    // its OWN withTenantDb transaction (RLS bound per-tenant); cross-tenant
    // batching is impossible by design. Bounded by the org's tenant count.
    for (const [tenantId, tLinks] of byTenant) { // guardrail-allow: n+1
        try {
            completed += await withTenantDb(tenantId, async (db) => {
                let done = 0;
                const byType = (t: string) => tLinks.filter((l) => l.entityType === t).map((l) => l.entityId);
                const readDone = async (
                    type: string,
                    rows: Array<{ status: string }>,
                ) => {
                    done += rows.filter((r) => DONE_STATUS[type]?.has(r.status)).length;
                };
                const controlIds = byType('CONTROL');
                if (controlIds.length) {
                    await readDone('CONTROL', await db.control.findMany({ where: { id: { in: controlIds } }, select: { status: true } }));
                }
                const riskIds = byType('RISK');
                if (riskIds.length) {
                    await readDone('RISK', await db.risk.findMany({ where: { id: { in: riskIds } }, select: { status: true } }));
                }
                const taskIds = byType('TASK');
                if (taskIds.length) {
                    await readDone('TASK', await db.task.findMany({ where: { id: { in: taskIds } }, select: { status: true } }));
                }
                const findingIds = byType('FINDING');
                if (findingIds.length) {
                    await readDone('FINDING', await db.finding.findMany({ where: { id: { in: findingIds } }, select: { status: true } }));
                }
                return done;
            });
        } catch (err) {
            logger.warn('org-initiative.link_resolution_failed', {
                component: 'org-security-initiative',
                tenantId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return { completed, total };
}

/** Manual progress wins; else cross-tenant rollup of linked work. */
export async function getInitiativeProgress(initiative: {
    manualProgressPercent: number | null;
    links: Array<{ linkedTenantId: string; entityType: string; entityId: string }>;
}): Promise<InitiativeProgress> {
    if (initiative.manualProgressPercent != null) {
        return deriveProgress(initiative.manualProgressPercent, 0, initiative.links.length);
    }
    const { completed, total } = await resolveLinkCompletion(initiative.links);
    return deriveProgress(null, completed, total);
}

// ─── CRUD ───────────────────────────────────────────────────────────

export async function listInitiatives(ctx: OrgContext, options: { status?: InitiativeStatus; take?: number } = {}) {
    assertRead(ctx);
    return prisma.orgSecurityInitiative.findMany({
        where: { organizationId: ctx.organizationId, ...(options.status ? { status: options.status } : {}) },
        orderBy: [{ status: 'asc' }, { targetDate: 'asc' }],
        include: { links: true },
        take: options.take ?? 200,
    });
}

export async function getInitiative(ctx: OrgContext, id: string) {
    assertRead(ctx);
    const init = await prisma.orgSecurityInitiative.findFirst({
        where: { id, organizationId: ctx.organizationId },
        include: { links: true },
    });
    if (!init) throw notFound('Initiative not found');
    return init;
}

/**
 * An initiative's owner must be a member of its organization (#4851). Both
 * writers took any user id, so an owner could be somebody the organization
 * does not know, and the page could not show them.
 */
async function assertOwnerIsMember(ctx: OrgContext, ownerUserId: string | null | undefined): Promise<void> {
    if (!ownerUserId) return;
    const member = await prisma.orgMembership.findUnique({
        where: { organizationId_userId: { organizationId: ctx.organizationId, userId: ownerUserId } },
        select: { id: true },
    });
    if (!member) {
        throw badRequest('The owner must be a member of this organization.', { reason: 'OWNER_NOT_MEMBER' });
    }
}

export async function createInitiative(
    ctx: OrgContext,
    input: { title: string; description?: string | null; ownerUserId?: string | null; targetDate?: string | null },
) {
    assertWrite(ctx);
    const title = sanitizePlainText(input.title ?? '').trim();
    if (!title) throw badRequest('A title is required.');
    await assertOwnerIsMember(ctx, input.ownerUserId);
    const created = await prisma.orgSecurityInitiative.create({
        data: {
            organizationId: ctx.organizationId,
            title,
            description: input.description ? sanitizePlainText(input.description) : null,
            ownerUserId: input.ownerUserId ?? null,
            targetDate: input.targetDate ? new Date(input.targetDate) : null,
        },
    });
    await emitInitiativeAudit(ctx, 'ORG_INITIATIVE_CREATED', { initiativeId: created.id, title });
    return created;
}

export async function updateInitiative(
    ctx: OrgContext,
    id: string,
    input: {
        title?: string;
        description?: string | null;
        ownerUserId?: string | null;
        targetDate?: string | null;
        manualProgressPercent?: number | null;
    },
) {
    assertWrite(ctx);
    await getInitiative(ctx, id); // existence + org scope
    if (input.ownerUserId !== undefined) await assertOwnerIsMember(ctx, input.ownerUserId);
    const data: Prisma.OrgSecurityInitiativeUpdateInput = {};
    if (input.title !== undefined) data.title = sanitizePlainText(input.title);
    if (input.description !== undefined) data.description = input.description ? sanitizePlainText(input.description) : null;
    if (input.ownerUserId !== undefined) data.ownerUserId = input.ownerUserId;
    if (input.targetDate !== undefined) data.targetDate = input.targetDate ? new Date(input.targetDate) : null;
    if (input.manualProgressPercent !== undefined) {
        data.manualProgressPercent =
            input.manualProgressPercent === null ? null : Math.max(0, Math.min(100, input.manualProgressPercent));
    }
    await prisma.orgSecurityInitiative.updateMany({ where: { id, organizationId: ctx.organizationId }, data });
    return getInitiative(ctx, id);
}

export async function changeInitiativeStatus(ctx: OrgContext, id: string, status: InitiativeStatus) {
    assertWrite(ctx);
    if (!(INITIATIVE_STATUSES as readonly string[]).includes(status)) {
        throw badRequest(`Invalid initiative status "${status}".`);
    }
    const existing = await getInitiative(ctx, id);
    const now = new Date();
    const data: Prisma.OrgSecurityInitiativeUpdateInput = { status };
    if (status === 'IN_PROGRESS' && !existing.startedAt) data.startedAt = now;
    if (status === 'COMPLETED') data.completedAt = now;
    await prisma.orgSecurityInitiative.updateMany({ where: { id, organizationId: ctx.organizationId }, data });
    await emitInitiativeAudit(ctx, 'ORG_INITIATIVE_STATUS_CHANGED', {
        initiativeId: id,
        from: existing.status,
        to: status,
    });
    return getInitiative(ctx, id);
}

export async function deleteInitiative(ctx: OrgContext, id: string) {
    assertWrite(ctx);
    await getInitiative(ctx, id);
    await prisma.orgSecurityInitiative.deleteMany({ where: { id, organizationId: ctx.organizationId } });
}

// ─── Links (cross-tenant) ───────────────────────────────────────────

export async function linkWork(
    ctx: OrgContext,
    initiativeId: string,
    input: { tenantId: string; entityType: string; entityId: string },
) {
    assertWrite(ctx);
    await getInitiative(ctx, initiativeId);
    if (!(INITIATIVE_LINK_TYPES as readonly string[]).includes(input.entityType)) {
        throw badRequest(`Invalid link entity type "${input.entityType}".`);
    }
    // The linked work MUST live in a tenant this org owns (authority check).
    const tenant = await prisma.tenant.findFirst({
        where: { id: input.tenantId, organizationId: ctx.organizationId },
        select: { id: true },
    });
    if (!tenant) throw badRequest('Linked work must belong to a tenant in this organization.');
    // The linked item must exist in that workspace (#4852): the route took
    // any id, and a link to nothing counts toward progress as never done.
    const labels = await readEntityLabels(input.tenantId, new Map([[input.entityType, [input.entityId]]]));
    if (!labels.has(`${input.entityType}:${input.entityId}`)) {
        throw badRequest('That item does not exist in the chosen workspace.', { reason: 'LINKED_ITEM_NOT_FOUND' });
    }

    return prisma.orgInitiativeLink.upsert({
        where: {
            initiativeId_linkedTenantId_entityType_entityId: {
                initiativeId,
                linkedTenantId: input.tenantId,
                entityType: input.entityType,
                entityId: input.entityId,
            },
        },
        update: {},
        create: {
            initiativeId,
            organizationId: ctx.organizationId,
            linkedTenantId: input.tenantId,
            entityType: input.entityType,
            entityId: input.entityId,
        },
    });
}

export async function unlinkWork(ctx: OrgContext, linkId: string) {
    assertWrite(ctx);
    const removed = await prisma.orgInitiativeLink.deleteMany({ where: { id: linkId, organizationId: ctx.organizationId } });
    // Say so when there was nothing to remove (#4852), so a refused or stale
    // unlink is not reported as done.
    if (removed.count === 0) throw notFound('That link no longer exists.');
}

// ─── Linked work by name (#4852) ────────────────────────────────────

/**
 * Where each linked entity type opens inside its workspace. A finding has no
 * page of its own: the findings list opens it in a sheet from `?finding=`.
 */
const LINK_HREF: Record<string, (id: string) => string> = {
    CONTROL: (id) => `/controls/${id}`,
    RISK: (id) => `/risks/${id}`,
    TASK: (id) => `/tasks/${id}`,
    FINDING: (id) => `/findings?finding=${id}`,
};

export interface ResolvedLink {
    id: string;
    entityType: string;
    entityId: string;
    linkedTenantId: string;
    /** The workspace's name, or null once it has left the organization. */
    workspaceName: string | null;
    /** The linked item's name, or null when it no longer exists. */
    name: string | null;
    /** Where the item lives, or null when it cannot be opened. */
    href: string | null;
}

type EntityLabel = { name: string };

/** One workspace's entities of each type, by id, through its own RLS context. */
async function readEntityLabels(
    tenantId: string,
    idsByType: Map<string, string[]>,
): Promise<Map<string, EntityLabel>> {
    return withTenantDb(tenantId, async (db) => {
        const out = new Map<string, EntityLabel>();
        const key = (type: string, id: string) => `${type}:${id}`;
        const controls = idsByType.get('CONTROL') ?? [];
        if (controls.length) {
            for (const c of await db.control.findMany({ where: { tenantId, id: { in: controls }, deletedAt: null }, select: { id: true, name: true, code: true } })) {
                out.set(key('CONTROL', c.id), { name: c.code ? `${c.code} · ${c.name}` : c.name });
            }
        }
        const risks = idsByType.get('RISK') ?? [];
        if (risks.length) {
            for (const r of await db.risk.findMany({ where: { tenantId, id: { in: risks }, deletedAt: null }, select: { id: true, title: true } })) {
                out.set(key('RISK', r.id), { name: r.title });
            }
        }
        const tasks = idsByType.get('TASK') ?? [];
        if (tasks.length) {
            for (const tk of await db.task.findMany({ where: { tenantId, id: { in: tasks }, deletedAt: null }, select: { id: true, title: true, key: true } })) {
                out.set(key('TASK', tk.id), { name: tk.key ? `${tk.key} · ${tk.title}` : tk.title });
            }
        }
        const findings = idsByType.get('FINDING') ?? [];
        if (findings.length) {
            for (const f of await db.finding.findMany({ where: { tenantId, id: { in: findings }, deletedAt: null }, select: { id: true, title: true } })) {
                out.set(key('FINDING', f.id), { name: f.title });
            }
        }
        return out;
    });
}

/** Names, workspaces and addresses of an initiative's linked work (#4852). */
export async function resolveInitiativeLinks(
    ctx: OrgContext,
    links: Array<{ id: string; linkedTenantId: string; entityType: string; entityId: string }>,
): Promise<ResolvedLink[]> {
    assertRead(ctx);
    if (links.length === 0) return [];
    const tenantIds = [...new Set(links.map((l) => l.linkedTenantId))];
    const tenants = await prisma.tenant.findMany({
        where: { id: { in: tenantIds }, organizationId: ctx.organizationId, deletedAt: null },
        select: { id: true, name: true, slug: true },
    });
    const tenantById = new Map(tenants.map((t) => [t.id, t]));
    const labels = new Map<string, EntityLabel>();
    // guardrail-allow: n+1 — one withTenantDb per workspace: each needs its
    // OWN RLS-bound transaction, as `resolveLinkCompletion` above. Bounded by
    // the number of workspaces the initiative spans.
    for (const tenantId of tenantIds) { // guardrail-allow: n+1
        if (!tenantById.has(tenantId)) continue;
        const idsByType = new Map<string, string[]>();
        for (const l of links.filter((x) => x.linkedTenantId === tenantId)) {
            idsByType.set(l.entityType, [...(idsByType.get(l.entityType) ?? []), l.entityId]);
        }
        try {
            for (const [k, v] of await readEntityLabels(tenantId, idsByType)) labels.set(`${tenantId}|${k}`, v);
        } catch (err) {
            logger.warn('org-initiative.link_label_failed', {
                component: 'org-security-initiative',
                tenantId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return links.map((l) => {
        const tenant = tenantById.get(l.linkedTenantId);
        const label = labels.get(`${l.linkedTenantId}|${l.entityType}:${l.entityId}`);
        const hrefFor = LINK_HREF[l.entityType];
        return {
            id: l.id,
            entityType: l.entityType,
            entityId: l.entityId,
            linkedTenantId: l.linkedTenantId,
            workspaceName: tenant?.name ?? null,
            name: label?.name ?? null,
            href: tenant && label && hrefFor ? `/t/${tenant.slug}${hrefFor(l.entityId)}` : null,
        };
    });
}

/** The organization's live workspaces, to choose where linked work lives. */
export async function listLinkableWorkspaces(ctx: OrgContext): Promise<Array<{ id: string; name: string }>> {
    assertWrite(ctx);
    return prisma.tenant.findMany({
        where: { organizationId: ctx.organizationId, deletedAt: null },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
        take: 500,
    });
}

/**
 * Items of one type in one of the organization's workspaces whose name
 * matches `q`, for the Link work picker (#4852). Read through the
 * workspace's own RLS context.
 */
export async function searchLinkCandidates(
    ctx: OrgContext,
    input: { tenantId: string; entityType: string; q: string },
): Promise<Array<{ id: string; name: string }>> {
    assertWrite(ctx);
    if (!(INITIATIVE_LINK_TYPES as readonly string[]).includes(input.entityType)) {
        throw badRequest(`Invalid link entity type "${input.entityType}".`);
    }
    const tenant = await prisma.tenant.findFirst({
        where: { id: input.tenantId, organizationId: ctx.organizationId, deletedAt: null },
        select: { id: true },
    });
    if (!tenant) throw badRequest('Linked work must belong to a workspace in this organization.');
    const q = input.q.trim().slice(0, 200);
    const contains = q ? { contains: q, mode: 'insensitive' as const } : undefined;
    const take = 20;
    return withTenantDb(input.tenantId, async (db) => {
        switch (input.entityType) {
            case 'CONTROL': {
                const rows = await db.control.findMany({
                    where: { tenantId: input.tenantId, deletedAt: null, ...(contains ? { OR: [{ name: contains }, { code: contains }] } : {}) },
                    select: { id: true, name: true, code: true },
                    orderBy: { updatedAt: 'desc' },
                    take,
                });
                return rows.map((r) => ({ id: r.id, name: r.code ? `${r.code} · ${r.name}` : r.name }));
            }
            case 'RISK': {
                const rows = await db.risk.findMany({
                    where: { tenantId: input.tenantId, deletedAt: null, ...(contains ? { title: contains } : {}) },
                    select: { id: true, title: true },
                    orderBy: { updatedAt: 'desc' },
                    take,
                });
                return rows.map((r) => ({ id: r.id, name: r.title }));
            }
            case 'TASK': {
                const rows = await db.task.findMany({
                    where: { tenantId: input.tenantId, deletedAt: null, ...(contains ? { OR: [{ title: contains }, { key: contains }] } : {}) },
                    select: { id: true, title: true, key: true },
                    orderBy: { updatedAt: 'desc' },
                    take,
                });
                return rows.map((r) => ({ id: r.id, name: r.key ? `${r.key} · ${r.title}` : r.title }));
            }
            default: {
                const rows = await db.finding.findMany({
                    where: { tenantId: input.tenantId, deletedAt: null, ...(contains ? { title: contains } : {}) },
                    select: { id: true, title: true },
                    orderBy: { updatedAt: 'desc' },
                    take,
                });
                return rows.map((r) => ({ id: r.id, name: r.title }));
            }
        }
    });
}

// ─── Widget surface ─────────────────────────────────────────────────

export interface InitiativeWidgetRow {
    id: string;
    title: string;
    status: InitiativeStatus;
    ownerUserId: string | null;
    targetDate: string | null;
    progress: InitiativeProgress;
    linkCount: number;
    tenantSpan: number;
    atRisk: boolean;
    stale: boolean;
}

export interface InitiativeWidgetData {
    rows: InitiativeWidgetRow[];
    inFlight: number;
    atRisk: number;
}

/** Top-N in-flight initiatives with rolled-up progress, for the widget. */
export async function getInitiativesForWidget(
    ctx: OrgContext,
    options: { topN?: number; statusFilter?: InitiativeStatus[] } = {},
): Promise<InitiativeWidgetData> {
    assertRead(ctx);
    const topN = Math.min(Math.max(options.topN ?? 5, 1), 20);
    const statusFilter = options.statusFilter?.length
        ? options.statusFilter
        : (['PLANNED', 'IN_PROGRESS', 'BLOCKED'] as InitiativeStatus[]);

    const all = await prisma.orgSecurityInitiative.findMany({
        where: { organizationId: ctx.organizationId, status: { in: statusFilter } },
        orderBy: [{ targetDate: 'asc' }, { createdAt: 'desc' }],
        include: { links: true },
        take: 200,
    });

    const inFlight = all.length;
    const atRisk = all.filter((i) => isInitiativeAtRisk(i)).length;

    // Resolve progress only for the surfaced rows (cap cross-tenant cost).
    const top = all.slice(0, topN);
    const rows: InitiativeWidgetRow[] = [];
    for (const i of top) {
        const progress = await getInitiativeProgress(i);
        rows.push({
            id: i.id,
            title: i.title,
            status: i.status,
            ownerUserId: i.ownerUserId,
            targetDate: i.targetDate?.toISOString() ?? null,
            progress,
            linkCount: i.links.length,
            tenantSpan: new Set(i.links.map((l) => l.linkedTenantId)).size,
            atRisk: isInitiativeAtRisk(i),
            stale: isInitiativeStale(i),
        });
    }
    return { rows, inFlight, atRisk };
}

async function emitInitiativeAudit(
    ctx: OrgContext,
    action: 'ORG_INITIATIVE_CREATED' | 'ORG_INITIATIVE_STATUS_CHANGED',
    detailsJson: Record<string, unknown>,
): Promise<void> {
    try {
        await appendOrgAuditEntry({
            organizationId: ctx.organizationId,
            actorUserId: ctx.userId,
            actorType: 'USER',
            action,
            targetUserId: null,
            detailsJson,
            requestId: ctx.requestId,
        });
    } catch (err) {
        logger.warn('org-initiative.audit_emit_failed', {
            component: 'org-security-initiative',
            action,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
