'use client';
/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/**
 * Custom Roles admin — Epic 48 DataTable migration.
 *
 * Replaces the hand-rolled `<table className="data-table">`
 * with the shared <DataTable> + <ListPageShell> primitives.
 *
 * The previous markup expanded a row inline when editing a role
 * (the row's `<td colSpan={6}>` swapped to a <RoleForm>).
 * That doesn't fit the row-per-record model DataTable assumes,
 * so the edit form now renders ABOVE the table — same place +
 * shape as the existing create form. The selected row is hidden
 * from the table while editing so the user has one obvious focus
 * surface, not two competing ones.
 *
 * Stable IDs preserved: roles-table-card, roles-table,
 * create-role-form, edit-role-form (new), create-role-btn,
 * role-name-input, role-base-select, role-description-input,
 * toggle-permissions-btn, role-submit-btn, edit-role-${id},
 * delete-role-${id}, perm-${resource}-${action},
 * preset-${role}, roles-error, roles-success.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { apiErrorMessage } from '@/lib/api-error';
import { Card, cardVariants } from '@/components/ui/card';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { getPermissionsForRole, type PermissionSet } from '@/lib/permissions';
import {
    Shield, Pencil, Trash2, Check,
    ChevronDown, ChevronUp, Users,
} from 'lucide-react';
import type { Role } from '@prisma/client';
import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons/nucleo';
import { Combobox, ComboboxOption } from '@/components/ui/combobox';
import { Tooltip } from '@/components/ui/tooltip';
import { DataTable, createColumns } from '@/components/ui/table';
import { InlineNotice } from '@/components/ui/inline-notice';
import { ListPageShell } from '@/components/layout/ListPageShell';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Heading, Eyebrow } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { cn } from '@/lib/cn';

// ─── Types ───

interface CustomRole {
    id: string;
    name: string;
    description: string | null;
    baseRole: Role;
    permissionsJson: PermissionSet;
    isActive: boolean;
    createdAt: string;
    updatedAt: string;
    _count: { memberships: number };
}

// ─── Permission Schema (must match src/lib/permissions.ts PERMISSION_SCHEMA) ───

const PERMISSION_SCHEMA: Record<keyof PermissionSet, string[]> = {
    controls: ['view', 'create', 'edit'],
    evidence: ['view', 'upload', 'edit', 'download'],
    policies: ['view', 'create', 'edit', 'approve'],
    tasks: ['view', 'create', 'edit', 'assign'],
    risks: ['view', 'create', 'edit'],
    assets: ['view', 'create', 'edit'],
    vendors: ['view', 'create', 'edit'],
    personnel: ['view', 'manage'],
    tests: ['view', 'create', 'execute'],
    incidents: ['view', 'manage'],
    frameworks: ['view', 'install'],
    audits: ['view', 'manage', 'freeze', 'share'],
    reports: ['view', 'export'],
    admin: ['view', 'manage', 'members', 'sso', 'scim'],
};

const RESOURCE_KEYS = ['controls','evidence','policies','tasks','risks','vendors','tests','frameworks','audits','reports','admin'] as const;
const buildResourceLabels = (t: (k: string) => string): Record<string, string> => Object.fromEntries(RESOURCE_KEYS.map(k => [k, t(`resourceLabels.${k}`)]));

const BASE_ROLES: Role[] = ['ADMIN', 'EDITOR', 'AUDITOR', 'READER'];
const ROLE_COLORS: Record<string, StatusBadgeVariant> = {
    ADMIN: 'error',
    EDITOR: 'info',
    AUDITOR: 'warning',
    READER: 'neutral',
};
const BASE_ROLE_OPTIONS: ComboboxOption[] = BASE_ROLES.map(r => ({ value: r, label: r }));

// ─── Permission Grid Component ───

function PermissionGrid({
    permissions,
    onChange,
    readonly = false,
}: {
    permissions: PermissionSet;
    onChange: (p: PermissionSet) => void;
    readonly?: boolean;
}) {
    const t = useTranslations('admin');
    const RESOURCE_LABELS = buildResourceLabels(t);
    const toggle = (resource: keyof PermissionSet, action: string) => {
        if (readonly) return;
        const current = (permissions[resource] as Record<string, boolean>)[action];
        const updated = {
            ...permissions,
            [resource]: {
                ...permissions[resource],
                [action]: !current,
            },
        };
        onChange(updated);
    };

    const allActions = Array.from(
        new Set(Object.values(PERMISSION_SCHEMA).flat())
    );

    return (
        <div className="overflow-x-auto">
            <table className="data-table text-xs">
                <thead>
                    <tr>
                        <th className="sticky left-0 bg-bg-default/90 z-10 text-left">{t('roles.gridResource')}</th>
                        {allActions.map((action) => (
                            <th key={action} className="text-center capitalize px-2">
                                {action}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {(Object.keys(PERMISSION_SCHEMA) as (keyof PermissionSet)[]).map((resource) => {
                        const resourceActions = PERMISSION_SCHEMA[resource];
                        return (
                            <tr key={resource}>
                                <td className="sticky left-0 bg-bg-default/50 text-xs font-medium text-content-default">
                                    {RESOURCE_LABELS[resource]}
                                </td>
                                {allActions.map((action) => {
                                    const hasAction = resourceActions.includes(action);
                                    if (!hasAction) {
                                        return <td key={action} className="text-center"><span className="text-content-subtle">—</span></td>;
                                    }
                                    const granted = (permissions[resource] as Record<string, boolean>)[action] ?? false;
                                    return (
                                        <td key={action} className="text-center">
                                            <button
                                                type="button"
                                                onClick={() => toggle(resource, action)}
                                                disabled={readonly}
                                                className={`
                                                    inline-flex items-center justify-center w-5 h-5 rounded transition
                                                    ${granted
                                                        ? 'bg-bg-success text-content-success hover:bg-bg-success'
                                                        : 'bg-bg-elevated/50 text-content-subtle hover:bg-bg-muted'
                                                    }
                                                    ${readonly ? 'cursor-default' : 'cursor-pointer'}
                                                `}
                                                title={`${resource}.${action}: ${granted ? 'granted' : 'denied'}`}
                                                id={`perm-${resource}-${action}`}
                                            >
                                                {granted ? <Check size={10} /> : null}
                                            </button>
                                        </td>
                                    );
                                })}
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

// ─── Role Form Component ───

function RoleForm({
    initial,
    onSubmit,
    onCancel,
    submitting,
    submitLabel,
}: {
    initial?: CustomRole;
    onSubmit: (data: { name: string; description: string; baseRole: Role; permissionsJson: PermissionSet }) => void;
    onCancel: () => void;
    submitting: boolean;
    submitLabel: string;
}) {
    const t = useTranslations('admin');
    const [name, setName] = useState(initial?.name ?? '');
    const [description, setDescription] = useState(initial?.description ?? '');
    const [baseRole, setBaseRole] = useState<Role>(initial?.baseRole ?? 'READER');
    const [permissions, setPermissions] = useState<PermissionSet>(
        initial?.permissionsJson ?? getPermissionsForRole('READER'),
    );
    const [showGrid, setShowGrid] = useState(!!initial);

    const handleBaseRoleChange = (role: Role) => {
        setBaseRole(role);
        if (!initial) {
            setPermissions(getPermissionsForRole(role));
        }
    };

    return (
        <div className="space-y-default">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-default">
                <div>
                    <label className="text-xs text-content-muted uppercase tracking-wider mb-1 block">
                        {t('roles.nameLabel')}
                    </label>
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={t('roles.namePlaceholder')}
                        className="input w-full"
                        maxLength={100}
                        id="role-name-input"
                    />
                </div>
                <div>
                    <label className="text-xs text-content-muted uppercase tracking-wider mb-1 block">
                        {t('roles.baseRoleLabel')}
                    </label>
                    <Combobox
                        hideSearch
                        id="role-base-select"
                        selected={BASE_ROLE_OPTIONS.find(o => o.value === baseRole) ?? null}
                        setSelected={(opt) => { if (opt) handleBaseRoleChange(opt.value as Role); }}
                        options={BASE_ROLE_OPTIONS}
                        matchTriggerWidth
                    />
                    <p className="text-[10px] text-content-subtle mt-1">
                        {t('roles.baseRoleHint')}
                    </p>
                </div>
            </div>

            <div>
                <label className="text-xs text-content-muted uppercase tracking-wider mb-1 block">
                    {t('roles.descriptionLabel')}
                </label>
                <input
                    type="text"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={t('roles.descriptionPlaceholder')}
                    className="input w-full"
                    maxLength={500}
                    id="role-description-input"
                />
            </div>

            {/* Permission Grid */}
            <div>
                <button
                    type="button"
                    onClick={() => setShowGrid(!showGrid)}
                    className="flex items-center gap-1 text-sm text-[var(--brand-default)] hover:text-[var(--brand-muted)] transition"
                    id="toggle-permissions-btn"
                >
                    {showGrid ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    {showGrid ? t('roles.hideGrid') : t('roles.showGrid')}
                </button>
                {showGrid && (
                    <div className={cn(cardVariants({ density: 'compact' }), 'mt-3')}>
                        <div className="flex items-center justify-between mb-3">
                            <Eyebrow>{t('roles.permissions')}</Eyebrow>
                            <div className="flex gap-1">
                                <span className="text-[10px] text-content-subtle">{t('roles.presetFrom')}</span>
                                {BASE_ROLES.map((r) => (
                                    <button
                                        key={r}
                                        type="button"
                                        onClick={() => setPermissions(getPermissionsForRole(r))}
                                        className="text-[10px] px-2 py-0.5 rounded bg-bg-elevated/50 text-content-default hover:bg-bg-muted/50 transition"
                                        id={`preset-${r}`}
                                    >
                                        {r}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <PermissionGrid permissions={permissions} onChange={setPermissions} />
                    </div>
                )}
            </div>

            <div className="flex gap-tight pt-2">
                <Button
                    variant="primary"
                    type="button"
                    onClick={() => onSubmit({ name: name.trim(), description: description.trim(), baseRole, permissionsJson: permissions })}
                    disabled={submitting || !name.trim()}
                    loading={submitting}
                    id="role-submit-btn"
                >
                    {submitting ? t('roles.saving') : submitLabel}
                </Button>
                <Button variant="secondary" type="button" onClick={onCancel}>
                    {t('roles.cancel')}
                </Button>
            </div>
        </div>
    );
}

// ─── Main Page ───

export default function CustomRolesPage() {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();

    const [roles, setRoles] = useState<CustomRole[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    // Form state
    const [showCreate, setShowCreate] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    // ─── Data Fetching ───
    const fetchRoles = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/admin/roles'));
            if (res.ok) {
                const data = await res.json();
                setRoles(data.filter((r: CustomRole) => r.isActive));
            }
        } catch {
            setError(t('roles.loadFailed'));
        } finally {
            setLoading(false);
        }
    }, [apiUrl, t]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchRoles(); }, [fetchRoles]);

    // ─── Handlers ───
    async function handleCreate(data: { name: string; description: string; baseRole: Role; permissionsJson: PermissionSet }) {
        setError(null);
        setSuccess(null);
        setSubmitting(true);
        try {
            const res = await fetch(apiUrl('/admin/roles'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: t('roles.createFailed') }));
                setError(apiErrorMessage(err, t('roles.createFailed')));
                return;
            }
            setSuccess(t('roles.createdSuccess', { name: data.name }));
            setShowCreate(false);
            await fetchRoles();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setSubmitting(false);
        }
    }

    async function handleUpdate(roleId: string, data: { name: string; description: string; baseRole: Role; permissionsJson: PermissionSet }) {
        setError(null);
        setSuccess(null);
        setSubmitting(true);
        try {
            const res = await fetch(apiUrl(`/admin/roles/${roleId}`), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: t('roles.updateFailed') }));
                setError(apiErrorMessage(err, t('roles.updateFailed')));
                return;
            }
            setSuccess(t('roles.updatedSuccess', { name: data.name }));
            setEditingId(null);
            await fetchRoles();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setSubmitting(false);
        }
    }

    async function handleDelete(role: CustomRole) {
        const memberWarning = role._count.memberships > 0
            ? t('roles.deleteMemberWarning', { count: role._count.memberships })
            : '';
        if (!confirm(t('roles.deleteConfirm', { name: role.name }) + memberWarning)) return;

        setError(null);
        setSuccess(null);
        try {
            const res = await fetch(apiUrl(`/admin/roles/${role.id}`), { method: 'DELETE' });
            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: t('roles.deleteFailed') }));
                setError(apiErrorMessage(err, t('roles.deleteFailed')));
                return;
            }
            const result = await res.json();
            setSuccess(t('roles.deletedSuccess', { name: role.name, count: result.membersCleared }));
            await fetchRoles();
        } catch (err) {
            setError((err as Error).message);
        }
    }

    // ─── Permission summary for table display ───
    function countGranted(perms: PermissionSet): string {
        let granted = 0;
        let total = 0;
        for (const resource of Object.keys(PERMISSION_SCHEMA) as (keyof PermissionSet)[]) {
            for (const action of PERMISSION_SCHEMA[resource]) {
                total++;
                if ((perms[resource] as Record<string, boolean>)[action]) granted++;
            }
        }
        return `${granted}/${total}`;
    }

    // ─── DataTable columns ───
    const editingRole = useMemo(
        () => (editingId ? roles.find((r) => r.id === editingId) ?? null : null),
        [editingId, roles],
    );
    // Hide the row currently being edited from the table — the
    // edit form above renders the full record, so showing it twice
    // would be visual noise.
    const visibleRoles = useMemo(
        () => (editingId ? roles.filter((r) => r.id !== editingId) : roles),
        [roles, editingId],
    );

    const roleColumns = useMemo(
        () => createColumns<CustomRole>([
            {
                id: 'name',
                header: t('roles.colName'),
                accessorKey: 'name',
                cell: ({ row }) => (
                    <span className="text-sm font-medium text-content-emphasis">{row.original.name}</span>
                ),
            },
            {
                id: 'baseRole',
                header: t('roles.colBaseRole'),
                accessorKey: 'baseRole',
                cell: ({ row }) => (
                    <StatusBadge variant={ROLE_COLORS[row.original.baseRole] || 'neutral'}>
                        {row.original.baseRole}
                    </StatusBadge>
                ),
            },
            {
                id: 'description',
                header: t('roles.colDescription'),
                accessorKey: 'description',
                cell: ({ row }) => (
                    <span className="text-content-muted truncate block max-w-xs">
                        {row.original.description || '—'}
                    </span>
                ),
            },
            {
                id: 'members',
                header: t('roles.colMembers'),
                accessorFn: (r) => r._count.memberships,
                cell: ({ row }) => (
                    <span className="flex items-center gap-1 text-content-default">
                        <Users className="w-3.5 h-3.5" />
                        {row.original._count.memberships}
                    </span>
                ),
            },
            {
                id: 'permissions',
                header: t('roles.colPermissions'),
                accessorFn: (r) => countGranted(r.permissionsJson),
                cell: ({ row }) => (
                    <span className="text-content-muted font-mono">
                        {countGranted(row.original.permissionsJson)}
                    </span>
                ),
            },
            {
                id: 'actions',
                header: '',
                cell: ({ row }) => {
                    const role = row.original;
                    return (
                        <div className="flex gap-1 justify-end" onClick={(e) => e.stopPropagation()}>
                            <Tooltip content={t('roles.editRole')}>
                                <Button
                                    variant="secondary"
                                    size="xs"
                                    onClick={() => {
                                        setShowCreate(false);
                                        setEditingId(role.id);
                                    }}
                                    aria-label={t('roles.editRole')}
                                    id={`edit-role-${role.id}`}
                                >
                                    <Pencil className="w-3.5 h-3.5" />
                                </Button>
                            </Tooltip>
                            <Tooltip content={t('roles.deleteRole')}>
                                <Button
                                    variant="destructive"
                                    size="xs"
                                    onClick={() => handleDelete(role)}
                                    aria-label={t('roles.deleteRole')}
                                    id={`delete-role-${role.id}`}
                                >
                                    <Trash2 className="w-3.5 h-3.5" />
                                </Button>
                            </Tooltip>
                        </div>
                    );
                },
            },
        ]),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [t],
    );

    // ─── Loading ───
    if (loading) {
        return (
            <div className="space-y-section animate-fadeIn">
                <BackAffordance />
                <PageBreadcrumbs
                    items={[
                        { label: t('crumb.dashboard'), href: tenantHref('/dashboard') },
                        { label: t('crumb.admin'), href: tenantHref('/admin') },
                        { label: t('roles.crumbSelf') },
                    ]}
                    className="mb-1"
                />
                <Heading level={2} className="flex items-center gap-tight">
                    <Shield className="w-6 h-6 text-[var(--brand-default)]" />
                    {t('roles.loading')}
                </Heading>
                <Card className="space-y-default">
                    <div className="h-4 bg-bg-elevated/60 rounded w-1/3 animate-pulse" />
                    <div className="h-4 bg-bg-elevated/60 rounded w-2/3 animate-pulse" />
                    <div className="h-4 bg-bg-elevated/60 rounded w-1/2 animate-pulse" />
                </Card>
            </div>
        );
    }

    return (
        <ListPageShell>
            <ListPageShell.Header>
                <div className="flex items-center justify-between flex-wrap gap-default">
                    <div>
                        <Heading level={1} className="flex items-center gap-tight">
                            <Shield className="w-6 h-6 text-[var(--brand-default)]" />
                            {t('roles.title')}
                        </Heading>
                        <p className="text-sm text-content-muted mt-1">
                            {t('roles.headerDesc', { count: roles.length })}
                        </p>
                    </div>
                    {!showCreate && !editingId && (
                        <Button
                            variant="primary"
                            icon={<Plus className="-ml-0.5 -mr-2.5" />}
                            onClick={() => setShowCreate(true)}
                            id="create-role-btn"
                        >
                            {t('roles.addRole')}
                        </Button>
                    )}
                </div>
            </ListPageShell.Header>

            <ListPageShell.Filters className="space-y-default">
                {/* Messages */}
                {error && (
                    <InlineNotice
                        variant="error"
                        id="roles-error"
                        onDismiss={() => setError(null)}
                    >
                        {error}
                    </InlineNotice>
                )}
                {success && (
                    <InlineNotice
                        variant="success"
                        id="roles-success"
                        onDismiss={() => setSuccess(null)}
                    >
                        {success}
                    </InlineNotice>
                )}

                {/* Create Form */}
                {showCreate && (
                    <div className={cn(cardVariants(), 'border border-[var(--brand-default)]/30')} id="create-role-form">
                        <Heading level={3} className="mb-4">{t('roles.createTitle')}</Heading>
                        <RoleForm
                            onSubmit={handleCreate}
                            onCancel={() => setShowCreate(false)}
                            submitting={submitting}
                            submitLabel={t('roles.createSubmit')}
                        />
                    </div>
                )}

                {/* Edit Form (Epic 48 migration — moved from inline-row expansion to
                    above-table panel; matches the create-form pattern) */}
                {editingRole && (
                    <div className={cn(cardVariants(), 'border border-[var(--brand-default)]/30')} id="edit-role-form">
                        <Heading level={3} className="mb-4">
                            {t('roles.editTitle', { name: editingRole.name })}
                        </Heading>
                        <RoleForm
                            initial={editingRole}
                            onSubmit={(data) => handleUpdate(editingRole.id, data)}
                            onCancel={() => setEditingId(null)}
                            submitting={submitting}
                            submitLabel={t('roles.editSubmit')}
                        />
                    </div>
                )}
            </ListPageShell.Filters>

            <ListPageShell.Body>
                {/* R13-PR5 — outer `cardVariants` wrapper dropped so
                    the DataTable's own bordered card is the only one
                    (matches Controls list visually). The wrapper div
                    stays so the `roles-table-card` id is preserved
                    for the E2E + analytics selectors that depend on
                    it. */}
                <div id="roles-table-card">
                    <DataTable
                        fillBody
                        data={visibleRoles}
                        columns={roleColumns}
                        getRowId={(r) => r.id}
                        emptyState={t('roles.emptyState')}
                        resourceName={(p) => (p ? t('roles.rolesPlural') : t('roles.roleSingular'))}
                        data-testid="roles-table"
                    />
                </div>
            </ListPageShell.Body>
        </ListPageShell>
    );
}
