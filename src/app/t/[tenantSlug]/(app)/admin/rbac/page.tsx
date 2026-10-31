import { getTranslations } from 'next-intl/server';
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
import { gateAdminPage } from '../_lib/admin-page-gate';
import { MembersTable, type MembersTableRow } from './MembersTable';

export const dynamic = 'force-dynamic';

/**
 * Admin-only RBAC overview page.
 * Shows: permission matrix by role, current tenant members + roles.
 *
 * Authorization: this page's own server gate, before any read (`admin.view` +
 * `admin.members`, the key `GET /admin/members` holds for the same member
 * list). It used to say "handled by centralized admin layout guard", but that
 * layout is a client component: it hides the page on screen after this server
 * component has already rendered every member's name, email and role into the
 * payload. See `../_lib/admin-page-requirements.ts`.
 */
export default async function RbacPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    // ─── Server-side guard ───
    const gate = await gateAdminPage('/admin/rbac', params);
    if (!gate.allowed) return gate.forbidden;
    const { ctx, tenantSlug } = gate;
    const t = await getTranslations('admin');
    const tRoles = await getTranslations('roles');
    // Labels for the matrix, from the catalogues the Custom Roles page uses
    // (#4821: this page printed the PermissionSet keys and role enum values).
    // A key with no catalogue string falls back legibly, never to a dotted path.
    const has = (tr: { has?: (k: string) => boolean }, key: string) =>
        typeof tr.has === 'function' && tr.has(key);
    const roleLabel = (role: string) => (has(tRoles, role) ? tRoles(role as Parameters<typeof tRoles>[0]) : role);
    const resourceLabel = (domain: string) =>
        has(t, `resourceLabels.${domain}`) ? t(`resourceLabels.${domain}` as Parameters<typeof t>[0]) : domain;
    const actionLabel = (action: string) =>
        has(t, `roles.actions.${action}`) ? t(`roles.actions.${action}` as Parameters<typeof t>[0]) : action.replace(/_/g, ' ');

    // ─── Data fetching ───
    const tenant = await prisma.tenant.findUnique({
        where: { id: ctx.tenantId },
        select: { name: true },
    });
    const memberRecords = await prisma.tenantMembership.findMany({
        where: { tenantId: ctx.tenantId },
        include: {
            user: { select: { id: true, name: true, email: true } },
            customRole: { select: { name: true } },
        },
        orderBy: { createdAt: 'asc' },
    });

    // Every membership, with its status, so a deactivated or invited person
    // is told apart from an active one (#4821), and its custom role, which is
    // what such a member can actually do.
    const members: MembersTableRow[] = memberRecords.map((m) => ({
        id: m.id,
        name: m.user.name,
        email: m.user.email,
        role: m.role,
        roleLabel: roleLabel(m.role),
        customRoleName: m.customRole?.name ?? null,
        status: m.status,
        statusLabel: has(t, `rbac.status.${m.status}`) ? t(`rbac.status.${m.status}` as Parameters<typeof t>[0]) : m.status,
        createdAtIso: m.createdAt.toISOString(),
    }));

    // A READER of roles, so every built-in role has a column — AI_ADMIN
    // (#3699) included: the matrix documents what a role grants.
    const roles: Role[] = ['OWNER', 'ADMIN', 'EDITOR', 'AUDITOR', 'READER', 'AI_ADMIN'];
    const permissionMatrix: Record<Role, PermissionSet> = {
        OWNER: getPermissionsForRole('OWNER'),
        ADMIN: getPermissionsForRole('ADMIN'),
        EDITOR: getPermissionsForRole('EDITOR'),
        AUDITOR: getPermissionsForRole('AUDITOR'),
        READER: getPermissionsForRole('READER'),
        AI_ADMIN: getPermissionsForRole('AI_ADMIN'),
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
                        name: tenant?.name ?? tenantSlug,
                        em: (c) => <span className="text-content-emphasis font-medium">{c}</span>,
                    })}{' '}
                    <StatusBadge variant="info" id="rbac-your-role">{roleLabel(ctx.role)}</StatusBadge>
                </p>
            </div>

            {/* Members Table */}
            <section>
                <Heading level={2} className="mb-3">{t('rbac.teamMembers')}</Heading>
                <MembersTable members={members} />
            </section>

            {/* Permission Matrix */}
            <section>
                <Heading level={2} className="mb-1">{t('rbac.permissionMatrix')}</Heading>
                <p className="mb-3 text-sm text-content-muted">{t('rbac.matrixNote')}</p>
                <div className={cn(cardVariants({ density: 'none' }), 'overflow-x-auto')}>
                    <table className="data-table">
                        <thead>
                            <tr>
                                <th className="sticky left-0 bg-bg-default/90 z-10">{t('rbac.resource')}</th>
                                <th className="sticky left-[120px] bg-bg-default/90 z-10">{t('rbac.action')}</th>
                                {roles.map((r) => (
                                    <th key={r} className="text-center">{roleLabel(r)}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {permissionRows.map(({ resource, action }) => (
                                <tr key={`${resource}.${action}`} className="group/row">
                                    <td className="text-xs font-medium text-content-default sticky left-0 bg-bg-default/50 group-hover/row:bg-bg-muted">{resourceLabel(resource)}</td>
                                    <td className="text-xs text-content-muted sticky left-[120px] bg-bg-default/50 group-hover/row:bg-bg-muted">{actionLabel(action)}</td>
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
