import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { resolveTenantContext } from '@/lib/tenant-context';
import { getPermissionsForRole, type PermissionSet } from '@/lib/permissions';
import prisma from '@/lib/prisma';
import type { Role } from '@prisma/client';
import { Check } from 'lucide-react';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { cardVariants } from '@/components/ui/card-variants';
import { cn } from '@inflect/ui/lib/cn';
import { MembersTable, type MembersTableRow } from './MembersTable';

export const dynamic = 'force-dynamic';

/**
 * Admin-only RBAC overview page.
 * Authorization: handled by centralized admin layout guard.
 * Shows: permission matrix by role, current tenant members + roles.
 */
export default async function RbacPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const t = await getTranslations('admin');

    // ─── Server-side guard ───
    const session = await auth();
    if (!session?.user?.id) redirect('/login');

    let tenantCtx;
    try {
        tenantCtx = await resolveTenantContext({ tenantSlug }, session.user.id);
    } catch {
        redirect(`/t/${tenantSlug}/dashboard`);
    }



    // ─── Data fetching ───
    const memberRecords = await prisma.tenantMembership.findMany({
        where: { tenantId: tenantCtx.tenant.id },
        include: { user: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: 'asc' },
    });

    const members: MembersTableRow[] = memberRecords.map((m) => ({
        id: m.id,
        name: m.user.name,
        email: m.user.email,
        role: m.role,
        createdAtIso: m.createdAt.toISOString(),
    }));

    const roles: Role[] = ['OWNER', 'ADMIN', 'EDITOR', 'AUDITOR', 'READER'];
    const permissionMatrix: Record<Role, PermissionSet> = {
        OWNER: getPermissionsForRole('OWNER'),
        ADMIN: getPermissionsForRole('ADMIN'),
        EDITOR: getPermissionsForRole('EDITOR'),
        AUDITOR: getPermissionsForRole('AUDITOR'),
        READER: getPermissionsForRole('READER'),
    };

    // Flatten permission keys for the matrix table
    const permissionRows: { resource: string; action: string }[] = [];
    const sampleSet = permissionMatrix.ADMIN;
    for (const [resource, actions] of Object.entries(sampleSet)) {
        for (const action of Object.keys(actions as Record<string, boolean>)) {
            permissionRows.push({ resource, action });
        }
    }

    return (
        <div className="space-y-page animate-fadeIn">
            <BackAffordance />
            {/* Header */}
            <div>
                <PageBreadcrumbs
                    items={[
                        { label: t('crumb.dashboard'), href: `/t/${tenantSlug}/dashboard` },
                        { label: t('crumb.admin'), href: `/t/${tenantSlug}/admin` },
                        { label: t('rbac.crumbSelf') },
                    ]}
                    className="mb-1"
                />
                <Heading level={1}>{t('rbac.title')}</Heading>
                <p className="text-sm text-content-muted mt-1">
                    {t.rich('rbac.matrixDesc', {
                        name: tenantCtx.tenant.name,
                        em: (c) => <span className="text-content-emphasis font-medium">{c}</span>,
                    })}{' '}
                    <StatusBadge variant="info">{tenantCtx.role}</StatusBadge>
                </p>
            </div>

            {/* Members Table */}
            <section>
                <Heading level={2} className="mb-3">{t('rbac.teamMembers')}</Heading>
                <MembersTable members={members} />
            </section>

            {/* Permission Matrix */}
            <section>
                <Heading level={2} className="mb-3">{t('rbac.permissionMatrix')}</Heading>
                <div className={cn(cardVariants({ density: 'none' }), 'overflow-x-auto')}>
                    <table className="data-table">
                        <thead>
                            <tr>
                                <th className="sticky left-0 bg-bg-default/90 z-10">{t('rbac.resource')}</th>
                                <th className="sticky left-[120px] bg-bg-default/90 z-10">{t('rbac.action')}</th>
                                {roles.map((r) => (
                                    <th key={r} className="text-center">{r}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {permissionRows.map(({ resource, action }) => (
                                <tr key={`${resource}.${action}`} className="group/row">
                                    <td className="text-xs font-medium text-content-default sticky left-0 bg-bg-default/50 group-hover/row:bg-bg-muted">{resource}</td>
                                    <td className="text-xs text-content-muted sticky left-[120px] bg-bg-default/50 group-hover/row:bg-bg-muted">{action}</td>
                                    {roles.map((role) => {
                                        const resourcePerms = permissionMatrix[role][resource as keyof PermissionSet];
                                        const granted = (resourcePerms as Record<string, boolean>)[action];
                                        return (
                                            <td key={role} className="text-center">
                                                {granted ? (
                                                    <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-bg-success text-content-success"><Check size={10} /></span>
                                                ) : (
                                                    <span className="inline-block w-4 h-4 rounded-full bg-bg-elevated/50 text-content-subtle text-[10px] leading-4">—</span>
                                                )}
                                            </td>
                                        );
                                    })}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>
        </div>
    );
}
