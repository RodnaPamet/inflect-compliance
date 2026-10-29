import { getTranslations } from 'next-intl/server';
import { listAuditLogs } from '@/app-layer/usecases/auditLog';
import { PageHeader } from '@/components/layout/PageHeader';
import { ListPageShell } from '@/components/layout/ListPageShell';
import { gateAdminPage } from '../_lib/admin-page-gate';
import { AuditLogClient } from './AuditLogClient';

export const dynamic = 'force-dynamic';

/**
 * R13-PR10 — dedicated audit log page.
 *
 * Extracted from the admin landing's "Audit log" tab so the
 * landing page stays a pure pill-nav surface. The "Notifications"
 * pill in the admin landing is paired with an "Audit log" pill
 * that points here.
 *
 * Server component does the fetch; the DataTable lives in the client
 * island.
 *
 * Gated here, before the read, on exactly what `listAuditLogs` asserts —
 * `canAudit`: OWNER, ADMIN, AUDITOR (owner decision 2026-10-29, an AUDITOR may
 * read the audit log). It used to call the read for every member and turn the
 * usecase's refusal into an empty table; it now refuses before the read, as
 * every admin server page does, because the client admin layout cannot keep
 * server-rendered props out of the payload. A failure of the read itself now
 * reaches the error boundary instead of reading as an empty log.
 * See `../_lib/admin-page-requirements.ts`.
 */
export default async function AuditLogPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const gate = await gateAdminPage('/admin/audit-log', params);
    if (!gate.allowed) return gate.forbidden;
    const { ctx, tenantSlug } = gate;

    const t = await getTranslations('admin');
    const auditLog = await listAuditLogs(ctx);

    const tenantHref = (path: string) => `/t/${tenantSlug}${path}`;
    // An AUDITOR reaches this page without `admin.view` (owner decision
    // 2026-10-29), so the Admin crumb would lead them to the forbidden page.
    const adminCrumb = ctx.appPermissions.admin.view
        ? [{ label: t('title'), href: tenantHref('/admin') }]
        : [];

    return (
        <ListPageShell className="gap-default">
            <ListPageShell.Header>
                <PageHeader
                    back={{ smart: true }}
                    breadcrumbs={[
                        { label: t('crumb.dashboard'), href: tenantHref('/dashboard') },
                        ...adminCrumb,
                        { label: t('auditLog') },
                    ]}
                    title={t('auditLog')}
                />
            </ListPageShell.Header>

            <AuditLogClient
                auditLog={JSON.parse(JSON.stringify(auditLog))}
                translations={{
                    time: t('time'),
                    user: t('user'),
                    action: t('action'),
                    entity: t('entity'),
                    details: t('details'),
                    noEntries: t('noEntries'),
                }}
            />
        </ListPageShell>
    );
}
