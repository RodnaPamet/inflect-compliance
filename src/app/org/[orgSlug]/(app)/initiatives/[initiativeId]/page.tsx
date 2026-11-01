import { notFound } from 'next/navigation';

import { getOrgCtx } from '@/app-layer/context';
import {
    getInitiative,
    getInitiativeProgress,
    listLinkableWorkspaces,
    resolveInitiativeLinks,
} from '@/app-layer/usecases/org-security-initiative';
import { listOrgMembers } from '@/app-layer/usecases/org-members';
import { toPlainJson } from '@/lib/server/to-plain-json';
import { InitiativeDetailClient } from './InitiativeDetailClient';

export const dynamic = 'force-dynamic';

export default async function OrgInitiativeDetailPage({
    params,
}: {
    params: Promise<{ orgSlug: string; initiativeId: string }>;
}) {
    const { orgSlug, initiativeId } = await params;
    let ctx;
    try {
        ctx = await getOrgCtx({ orgSlug });
    } catch {
        notFound();
    }
    let initiative;
    try {
        initiative = await getInitiative(ctx, initiativeId);
    } catch {
        notFound();
    }
    const canManage = ctx.permissions.canConfigureDashboard;
    // Linked work by name, with the address of each item (#4852), and, for
    // someone who can edit, the people and workspaces to choose from.
    const [progress, links, members, workspaces] = await Promise.all([
        getInitiativeProgress(initiative),
        resolveInitiativeLinks(ctx, initiative.links),
        listOrgMembers(ctx),
        canManage ? listLinkableWorkspaces(ctx) : Promise.resolve([]),
    ]);
    const memberName = new Map(members.map((m) => [m.userId, m.user.name?.trim() || m.user.email]));

    return (
        <InitiativeDetailClient
            orgSlug={orgSlug}
            canManage={canManage}
            members={canManage ? members.map((m) => ({ id: m.userId, label: memberName.get(m.userId) ?? m.userId })) : []}
            workspaces={workspaces}
            initiative={toPlainJson({
                id: initiative.id,
                title: initiative.title,
                description: initiative.description,
                status: initiative.status,
                ownerUserId: initiative.ownerUserId,
                ownerName: initiative.ownerUserId ? (memberName.get(initiative.ownerUserId) ?? null) : null,
                targetDate: initiative.targetDate?.toISOString() ?? null,
                manualProgressPercent: initiative.manualProgressPercent,
                links,
            })}
            progress={toPlainJson(progress)}
        />
    );
}
