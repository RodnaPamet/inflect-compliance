import { notFound } from 'next/navigation';

import { getOrgCtx } from '@/app-layer/context';
import { listInitiatives } from '@/app-layer/usecases/org-security-initiative';
import { listOrgMembers } from '@/app-layer/usecases/org-members';
import { toPlainJson } from '@/lib/server/to-plain-json';
import { InitiativesClient } from './InitiativesClient';

export const dynamic = 'force-dynamic';

/**
 * Org-level security-initiatives (portfolio programmes). Cross-tenant
 * programme tracking — distinct from per-tenant Tasks. ORG_ADMIN manages;
 * any portfolio viewer reads.
 */
export default async function OrgInitiativesPage({ params }: { params: Promise<{ orgSlug: string }> }) {
    const { orgSlug } = await params;
    let ctx;
    try {
        ctx = await getOrgCtx({ orgSlug });
    } catch {
        notFound();
    }
    const [initiatives, members] = await Promise.all([listInitiatives(ctx), listOrgMembers(ctx)]);
    // The owner by name (#4851): the page showed nobody. Owners are org
    // members (the writers check it), so the member list names them all.
    const memberName = new Map(members.map((m) => [m.userId, m.user.name?.trim() || m.user.email]));
    const canManage = ctx.permissions.canConfigureDashboard;
    return (
        <InitiativesClient
            orgSlug={orgSlug}
            canManage={canManage}
            // Only someone who can create an initiative needs the people to
            // choose its owner from.
            members={canManage ? members.map((m) => ({ id: m.userId, label: memberName.get(m.userId) ?? m.userId })) : []}
            initiatives={toPlainJson(
                initiatives.map((i) => ({
                    id: i.id,
                    title: i.title,
                    status: i.status,
                    ownerUserId: i.ownerUserId,
                    ownerName: i.ownerUserId ? (memberName.get(i.ownerUserId) ?? null) : null,
                    targetDate: i.targetDate?.toISOString() ?? null,
                    manualProgressPercent: i.manualProgressPercent,
                    linkCount: i.links.length,
                    tenantSpan: new Set(i.links.map((l) => l.linkedTenantId)).size,
                })),
            )}
        />
    );
}
