import { notFound } from 'next/navigation';

import { getTranslations } from 'next-intl/server';

import { getOrgCtx } from '@/app-layer/context';
import { listOrgAudit } from '@/app-layer/usecases/org-audit';
import { OrgForbiddenPage } from '../_components/OrgForbiddenPage';
import { AuditLogTable } from './AuditLogTable';

/**
 * Epic B — Org Audit Trail (read-only UI).
 *
 * Server-renders the first page of immutable, hash-chained
 * `OrgAuditLog` entries for the org. Subsequent pages are walked by
 * the client island via the `GET /api/org/[orgSlug]/audit-log`
 * endpoint with cursor pagination.
 *
 * RBAC: ORG_ADMIN only (`canManageMembers`). Same anti-enumeration
 * posture as the rest of `/org/[orgSlug]/...` — non-members get a
 * 404 via `getOrgCtx`'s collapse, non-managers are told who reads it.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
    params: Promise<{ orgSlug: string }>;
}

export default async function OrgAuditPage({ params }: PageProps) {
    const { orgSlug } = await params;

    let ctx;
    try {
        ctx = await getOrgCtx({ orgSlug });
    } catch {
        notFound();
    }

    if (!ctx.permissions.canManageMembers) {
        // A Reader is told who reads the log (#4849). Throwing `forbidden(...)`
        // here reached the root error boundary, which showed "an unexpected
        // error has occurred" and reported it as a crash.
        const t = await getTranslations('org');
        return <OrgForbiddenPage orgSlug={orgSlug} message={t('audit.forbiddenMessage')} />;
    }

    const initial = await listOrgAudit(ctx, { limit: 20 });

    return (
        <AuditLogTable
            orgSlug={orgSlug}
            initialRows={JSON.parse(JSON.stringify(initial.rows))}
            initialNextCursor={initial.nextCursor}
        />
    );
}
