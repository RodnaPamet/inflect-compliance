import { notFound } from 'next/navigation';

import { getTranslations } from 'next-intl/server';

import { getOrgCtx } from '@/app-layer/context';
import { listOrgMembers } from '@/app-layer/usecases/org-members';
import { listPendingOrgInvites } from '@/app-layer/usecases/org-invites';
import { OrgForbiddenPage } from '../_components/OrgForbiddenPage';
import { MembersTable } from './MembersTable';

/**
 * GAP O4-2 — Org members management page.
 *
 * Server-rendered list of every OrgMembership under the org. Gates
 * on `canManageMembers` (ORG_ADMIN only) and collapses non-permission
 * cases to `notFound()` for the same anti-enumeration posture as the
 * rest of the org tree.
 *
 * Read path: server fetch via the `listOrgMembers` usecase.
 * Write path: the client island uses the existing
 * `POST /api/org/{slug}/members` and
 * `DELETE /api/org/{slug}/members?userId=` endpoints. After a
 * successful mutation the page reloads via `router.refresh()` so the
 * server-rendered list reflects the new state.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
    params: Promise<{ orgSlug: string }>;
}

export default async function OrgMembersPage({ params }: PageProps) {
    const { orgSlug } = await params;

    let ctx;
    try {
        ctx = await getOrgCtx({ orgSlug });
    } catch {
        notFound();
    }

    if (!ctx.permissions.canManageMembers) {
        // A Reader is told who manages members (#4848). Throwing
        // `forbidden(...)` here reached the root error boundary, which showed
        // "an unexpected error has occurred" and reported it as a crash.
        // Non-members are still collapsed to 404 by getOrgCtx above.
        const t = await getTranslations('org');
        return <OrgForbiddenPage orgSlug={orgSlug} message={t('members.forbiddenMessage')} />;
    }

    const [rows, invites] = await Promise.all([
        listOrgMembers(ctx),
        listPendingOrgInvites(ctx),
    ]);
    const currentUserId = ctx.userId;

    return (
        <MembersTable
            orgSlug={orgSlug}
            currentUserId={currentUserId}
            viewerRole={ctx.orgRole}
            rows={JSON.parse(JSON.stringify(rows))}
            invites={JSON.parse(JSON.stringify(invites))}
        />
    );
}
