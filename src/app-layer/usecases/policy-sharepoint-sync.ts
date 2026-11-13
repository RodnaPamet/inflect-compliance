/**
 * SP-4 — bidirectional SharePoint ↔ IC policy sync.
 *
 *   - link / unlink   — bind a policy to a SharePoint DriveItem + (un)register a
 *                       Graph change-notification subscription.
 *   - push (IC → SP)  — on publish, write the current version's content to the
 *                       linked SP file.
 *   - pull (SP → IC)  — on a Graph notification, create a new PolicyVersion from
 *                       the SP file's content.
 *   - conflict        — compare the stored eTag against the live SP eTag.
 *
 * Content is synced as Markdown (`text/markdown`) — no DOCX dependency. Policy
 * content is encrypted at rest (Epic B); the Prisma middleware decrypts it on
 * read, so we push plaintext and store pulled plaintext through the normal
 * `createPolicyVersion` path (which sanitises).
 *
 * @module usecases/policy-sharepoint-sync
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { env } from '@/env';
import { notFound, badRequest } from '@/lib/errors/types';
import { logEvent } from '../events/audit';
import { edgeLogger } from '@/lib/observability/edge-logger';
import { assertCanWrite } from '../policies/common';
import { createPolicyVersion } from './policy';
import {
    getSharePointClient,
    listSharePointConnections,
} from '../integrations/providers/sharepoint';
import type { SharePointClient } from '../integrations/providers/sharepoint/client';
import { isDocxItem, docxToPolicyHtml } from '../integrations/providers/sharepoint/docx';

const SP_NOTIFICATION_PATH = '/api/webhooks/sharepoint';
const SUBSCRIPTION_TTL_MS = 2 * 24 * 60 * 60 * 1000; // 2 days (Graph max ~4230 min)

/** Resolve a SharePoint client — by connectionId, else the tenant's first. */
async function resolveClient(ctx: RequestContext, connectionId?: string): Promise<SharePointClient> {
    let id = connectionId;
    if (!id) {
        const conns = await listSharePointConnections(ctx);
        if (conns.length === 0) throw badRequest('No SharePoint connection configured');
        id = conns[0].id;
    }
    return getSharePointClient(ctx, id);
}

/** Public resolver for jobs that need the tenant's SharePoint client. */
export async function getSharePointClientForTenant(ctx: RequestContext): Promise<SharePointClient> {
    return resolveClient(ctx);
}

/** The opaque clientState a Graph notification must echo back. */
export function policyClientState(tenantId: string, policyId: string): string {
    return `${tenantId}:${policyId}`;
}

/** Link a policy to a SharePoint file + register a change subscription. */
export async function linkPolicyToSharePoint(
    ctx: RequestContext,
    policyId: string,
    input: { connectionId: string; driveId: string; itemId: string },
): Promise<{ webUrl?: string }> {
    assertCanWrite(ctx);
    const client = await resolveClient(ctx, input.connectionId);
    const item = await client.getItem(input.driveId, input.itemId);

    let subscriptionId: string | undefined;
    try {
        const sub = await client.createSubscription({
            driveId: input.driveId,
            notificationUrl: `${env.APP_URL}${SP_NOTIFICATION_PATH}`,
            clientState: policyClientState(ctx.tenantId, policyId),
            expirationDateTime: new Date(Date.now() + SUBSCRIPTION_TTL_MS).toISOString(),
        });
        subscriptionId = sub.id;
    } catch (err) {
        // A missing public webhook URL (dev) shouldn't block linking — push/pull
        // still works manually; the subscription is the automatic-pull channel.
        edgeLogger.warn('SharePoint subscription create failed (link continues)', {
            component: 'sharepoint',
            error: err instanceof Error ? err.message : String(err),
        });
    }

    return runInTenantContext(ctx, async (db) => {
        const policy = await db.policy.findFirst({ where: { id: policyId, tenantId: ctx.tenantId }, select: { id: true } });
        if (!policy) throw notFound('Policy not found');
        await db.policy.update({
            where: { id: policyId },
            data: {
                spDriveId: input.driveId,
                spItemId: input.itemId,
                spItemETag: item.eTag ?? null,
                spWebUrl: item.webUrl ?? null,
                spSubscriptionId: subscriptionId ?? null,
                spConnectionId: input.connectionId,
            },
        });
        await logEvent(db, ctx, {
            action: 'POLICY_LINKED_SHAREPOINT',
            entityType: 'Policy',
            entityId: policyId,
            details: `Linked policy to SharePoint item ${input.itemId}`,
            detailsJson: {
                category: 'relationship',
                summary: 'Policy linked to SharePoint',
                targetEntity: 'DriveItem',
                targetId: `${input.driveId}:${input.itemId}`,
            },
        });
        return { webUrl: item.webUrl };
    });
}

/** Unlink a policy: delete the subscription + clear the SP fields. */
export async function unlinkPolicyFromSharePoint(ctx: RequestContext, policyId: string): Promise<void> {
    assertCanWrite(ctx);
    const policy = await runInTenantContext(ctx, (db) =>
        db.policy.findFirst({
            where: { id: policyId, tenantId: ctx.tenantId },
            select: { id: true, spSubscriptionId: true, spConnectionId: true },
        }),
    );
    if (!policy) throw notFound('Policy not found');

    if (policy.spSubscriptionId) {
        try {
            const client = await resolveClient(ctx, policy.spConnectionId ?? undefined);
            await client.deleteSubscription(policy.spSubscriptionId);
        } catch (err) {
            edgeLogger.warn('SharePoint subscription delete failed (unlink continues)', {
                component: 'sharepoint',
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    await runInTenantContext(ctx, async (db) => {
        await db.policy.update({
            where: { id: policyId },
            data: { spDriveId: null, spItemId: null, spItemETag: null, spWebUrl: null, spSubscriptionId: null },
        });
        await logEvent(db, ctx, {
            action: 'POLICY_UNLINKED_SHAREPOINT',
            entityType: 'Policy',
            entityId: policyId,
            details: 'Unlinked policy from SharePoint',
            detailsJson: { category: 'relationship', summary: 'Policy unlinked from SharePoint' },
        });
    });
}

/** Push the current policy version's content to the linked SharePoint file. */
export async function pushPolicyToSharePoint(ctx: RequestContext, policyId: string): Promise<void> {
    const policy = await runInTenantContext(ctx, (db) =>
        db.policy.findFirst({
            where: { id: policyId, tenantId: ctx.tenantId },
            select: {
                spDriveId: true,
                spItemId: true,
                spConnectionId: true,
                currentVersion: { select: { contentText: true } },
            },
        }),
    );
    if (!policy?.spDriveId || !policy.spItemId) return; // not linked → nothing to push
    const content = policy.currentVersion?.contentText ?? '';

    const client = await resolveClient(ctx, policy.spConnectionId ?? undefined);
    // SP-F3 — Word-linked policies are SharePoint-authoritative (pull-only).
    // Writing markdown bytes into a .docx would corrupt the document, so skip.
    const linked = await client.getItem(policy.spDriveId, policy.spItemId);
    if (isDocxItem(linked.name)) {
        edgeLogger.info('Policy push skipped — Word-linked policy is SharePoint-authoritative', {
            component: 'sharepoint',
            policyId,
        });
        return;
    }
    const updated = await client.uploadItemContent(policy.spDriveId, policy.spItemId, content, 'text/markdown');

    await runInTenantContext(ctx, async (db) => {
        await db.policy.update({ where: { id: policyId }, data: { spItemETag: updated.eTag ?? null } });
        await logEvent(db, ctx, {
            action: 'POLICY_SYNCED_TO_SHAREPOINT',
            entityType: 'Policy',
            entityId: policyId,
            details: 'Pushed policy content to SharePoint',
            detailsJson: { category: 'status_change', summary: 'Policy pushed to SharePoint' },
        });
    });
}

/** Create a new PolicyVersion from the linked SharePoint file's content. */
export async function pullPolicyFromSharePoint(
    ctx: RequestContext,
    input: { driveId: string; itemId: string },
): Promise<{ pulled: boolean }> {
    const policy = await runInTenantContext(ctx, (db) =>
        db.policy.findFirst({
            where: { tenantId: ctx.tenantId, spDriveId: input.driveId, spItemId: input.itemId },
            select: { id: true, spConnectionId: true, spItemETag: true },
        }),
    );
    if (!policy) return { pulled: false };

    const client = await resolveClient(ctx, policy.spConnectionId ?? undefined);
    const item = await client.getItem(input.driveId, input.itemId);
    // UNCHANGED SINCE THE LAST SYNC (#5148). A drive notification fires for
    // every change, including the echo of our own push, which stored this
    // eTag; pulling it again proposed a duplicate version each time. Only an
    // eTag both sides hold and agree on counts as unchanged.
    if (item.eTag && policy.spItemETag && item.eTag === policy.spItemETag) return { pulled: false };
    const ab = await client.downloadItemContent(input.driveId, input.itemId);

    // SP-F3 — Word docs convert to HTML (mammoth); everything else is treated
    // as markdown text. Prompt-3.2 — an external pull lands as a *proposed*
    // draft version (`proposeOnly`): a live PUBLISHED policy is NOT demoted, so
    // its acknowledgements are never silently stranded. The proposal must go
    // through request-approval → publish to replace the live version.
    if (isDocxItem(item.name)) {
        await createPolicyVersion(ctx, policy.id, {
            contentType: 'HTML',
            contentText: await docxToPolicyHtml(ab),
            changeSummary: 'Synced from SharePoint (Word)',
        }, { proposeOnly: true });
    } else {
        await createPolicyVersion(ctx, policy.id, {
            contentType: 'MARKDOWN',
            contentText: new TextDecoder().decode(ab),
            changeSummary: 'Synced from SharePoint',
        }, { proposeOnly: true });
    }

    await runInTenantContext(ctx, async (db) => {
        await db.policy.update({ where: { id: policy.id }, data: { spItemETag: item.eTag ?? null } });
        await logEvent(db, ctx, {
            action: 'POLICY_SYNCED_FROM_SHAREPOINT',
            entityType: 'Policy',
            entityId: policy.id,
            details: 'Pulled new policy version from SharePoint',
            detailsJson: { category: 'status_change', summary: 'Policy pulled from SharePoint' },
        });
    });
    return { pulled: true };
}

/** Manual pull by policy id (resolves the linked drive/item, then pulls). */
export async function pullPolicyByIdFromSharePoint(ctx: RequestContext, policyId: string): Promise<{ pulled: boolean }> {
    assertCanWrite(ctx);
    const policy = await runInTenantContext(ctx, (db) =>
        db.policy.findFirst({
            where: { id: policyId, tenantId: ctx.tenantId },
            select: { spDriveId: true, spItemId: true },
        }),
    );
    if (!policy?.spDriveId || !policy.spItemId) throw badRequest('Policy is not linked to SharePoint');
    return pullPolicyFromSharePoint(ctx, { driveId: policy.spDriveId, itemId: policy.spItemId });
}

/** Conflict check: the live SP eTag differs from the last-synced eTag. */
export async function getPolicySharePointConflict(ctx: RequestContext, policyId: string): Promise<boolean> {
    const policy = await runInTenantContext(ctx, (db) =>
        db.policy.findFirst({
            where: { id: policyId, tenantId: ctx.tenantId },
            select: { spDriveId: true, spItemId: true, spItemETag: true, spConnectionId: true },
        }),
    );
    if (!policy?.spDriveId || !policy.spItemId) return false;
    const client = await resolveClient(ctx, policy.spConnectionId ?? undefined);
    const item = await client.getItem(policy.spDriveId, policy.spItemId);
    return !!item.eTag && item.eTag !== policy.spItemETag;
}

/** UI status: linked? + the source URL + a (best-effort) conflict flag. */
export async function getPolicySharePointStatus(
    ctx: RequestContext,
    policyId: string,
): Promise<{ linked: boolean; webUrl: string | null; conflict: boolean }> {
    const policy = await runInTenantContext(ctx, (db) =>
        db.policy.findFirst({
            where: { id: policyId, tenantId: ctx.tenantId },
            select: { spDriveId: true, spItemId: true, spItemETag: true, spWebUrl: true, spConnectionId: true },
        }),
    );
    if (!policy?.spDriveId || !policy.spItemId) return { linked: false, webUrl: null, conflict: false };
    let conflict = false;
    try {
        const client = await resolveClient(ctx, policy.spConnectionId ?? undefined);
        const item = await client.getItem(policy.spDriveId, policy.spItemId);
        conflict = !!item.eTag && item.eTag !== policy.spItemETag;
    } catch {
        // A Graph blip shouldn't break the policy page — report no conflict.
    }
    return { linked: true, webUrl: policy.spWebUrl, conflict };
}
