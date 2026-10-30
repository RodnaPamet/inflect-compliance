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
import { grantExceedingKeys } from '@/lib/custom-role-grant-refusal';
import { Card, cardVariants } from '@/components/ui/card';
import {
    useTenantApiUrl,
    useTenantHref,
    usePermissions,
    useOffersAdminApiWrite,
} from '@/lib/tenant-context-provider';
import {
    ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS,
    CUSTOM_ROLE_ADMIN_BASE_REFUSAL,
    customRoleCarriageRefusalOf,
} from '@/lib/roles';
import {
    getPermissionsForRole,
    permissionsExceeding,
    PERMISSION_SCHEMA,
    type PermissionSet,
} from '@/lib/permissions';
import {
    Shield, Pencil, Trash2, Check,
    ChevronDown, ChevronUp, Users,
} from 'lucide-react';
import type { Role } from '@prisma/client';
import { Button } from '@/components/ui/button';
import { Plus } from '@inflect/ui/components/ui/icons/nucleo';
import { Combobox, ComboboxOption } from '@/components/ui/combobox';
import { Tooltip } from '@/components/ui/tooltip';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ErrorState } from '@/components/ui/error-state';
import { DataTable, createColumns } from '@/components/ui/table';
import { InlineNotice } from '@/components/ui/inline-notice';
import { ListPageShell } from '@/components/layout/ListPageShell';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Heading, Eyebrow } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { cn } from '@inflect/ui/lib/cn';

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
    /**
     * Members carrying the role whose built-in role is not ADMIN. While there
     * are any, the role may not be built on ADMIN or gain an admin key only an
     * ADMIN membership may carry (owner decision, 2026-10-30), so the form
     * locks both. Absent from an older server's list: read as none.
     */
    nonAdminCarriers?: number;
}

// ─── Labels ───
//
// The domain list and its actions come from `PERMISSION_SCHEMA` in
// `@/lib/permissions` — the single source of truth. This file used to
// carry two hand-written copies of it (a full action map, and a
// SHORTER `RESOURCE_KEYS` list right beside it that drove the labels),
// and they disagreed with the type and with each other: #2225 measured
// `assets` / `personnel` / `incidents` missing from `RESOURCE_KEYS`,
// `reports.schedule_external` missing, and four `admin` actions
// missing — including `tenant_lifecycle` and `owner_management`, the
// two flags that separate OWNER from ADMIN, which therefore rendered
// no toggle at all.
//
// Every domain is labelled from `admin.resourceLabels.*` and every action
// from `admin.roles.actions.*` (#4467: two domains and every column heading
// used to show the raw key). A lookup with no catalogue string falls back to
// the raw domain key, or the action key with its underscores replaced, so a
// permission added to `PERMISSION_SCHEMA` before its translation lands
// renders legibly rather than as an empty cell.
// `tests/rendered/custom-roles-page.test.tsx` fails while any domain or action
// lacks a catalogue string.

type Translator = ((key: string) => string) & { has?: (key: string) => boolean };

const humanizeAction = (action: string): string => action.replace(/_/g, ' ');

function catalogueLabel(t: Translator, key: string, fallback: string): string {
    if (typeof t.has === 'function' && !t.has(key)) return fallback;
    const label = t(key);
    // A `t` without `.has` (or one configured to echo the key) returns the
    // key path for a missing message — treat that as missing too rather than
    // painting a dotted path into a cell.
    return label && !label.includes(key) ? label : fallback;
}

/**
 * The page's translator and its label lookups: a permission's domain, its
 * action, the two together, and a built-in role.
 *
 * Every component in this file takes `t` from here rather than binding its
 * own. `tests/guards/i18n-keys-resolve.test.ts` reads translator bindings
 * with a regex, which has no scopes: a file binding `t` more than once beside
 * a second namespace cannot be resolved, and drops out of its coverage.
 */
function useRolesPageText() {
    const t = useTranslations('admin');
    const tRoles = useTranslations('roles');
    return useMemo(() => {
        const resource = (domain: string) =>
            catalogueLabel(t as Translator, `resourceLabels.${domain}`, domain);
        const action = (key: string) =>
            catalogueLabel(t as Translator, `roles.actions.${key}`, humanizeAction(key));
        /** `domain.action`, as the server names a permission, to its label. */
        const permission = (key: string) => {
            const dot = key.indexOf('.');
            const domain = dot < 0 ? key : key.slice(0, dot);
            const act = dot < 0 ? '' : key.slice(dot + 1);
            return t('roles.permissionLabel', { resource: resource(domain), action: action(act) });
        };
        /** A built-in role's display label (`roles.*`), falling back to the code. */
        const roleLabel = (role: string) =>
            typeof tRoles.has === 'function' && tRoles.has(role) ? tRoles(role) : role;
        return { t, resource, action, permission, roleLabel };
    }, [t, tRoles]);
}

const BASE_ROLES: Role[] = ['ADMIN', 'EDITOR', 'AUDITOR', 'READER'];
const ROLE_COLORS: Record<string, StatusBadgeVariant> = {
    ADMIN: 'error',
    EDITOR: 'info',
    AUDITOR: 'warning',
    READER: 'neutral',
};

const holdsPermission = (held: PermissionSet, domain: keyof PermissionSet, action: string): boolean =>
    (held[domain] as Record<string, boolean> | undefined)?.[action] === true;

/**
 * `perms` with every permission the editor does not hold turned off.
 *
 * The server refuses a role holding more than its author does
 * (`assertGrantWithinOwnAuthority`), so a preset or a base role's defaults
 * that carried one would only fail on save. Starting the grid inside what
 * the editor holds is the same rule, applied where they can see it (#4467).
 */
function withinHeld(perms: PermissionSet, held: PermissionSet): PermissionSet {
    const out: Record<string, Record<string, boolean>> = {};
    for (const domain of Object.keys(PERMISSION_SCHEMA) as (keyof PermissionSet)[]) {
        const source = { ...(perms[domain] as Record<string, boolean>) };
        for (const action of PERMISSION_SCHEMA[domain]) {
            if (source[action] === true && !holdsPermission(held, domain, action)) source[action] = false;
        }
        out[domain] = source;
    }
    return out as unknown as PermissionSet;
}

/**
 * The admin keys the form may not switch ON for a role that members who are
 * not Admins carry: every `ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS` key the stored
 * role does not already grant. The server refuses exactly what a save ADDS
 * (`customRoleCarriageRefusal`), so a key the role already grants stays
 * switchable — off, and back on.
 */
function adminOnlyLockedKeys(initial: CustomRole | undefined): ReadonlySet<string> {
    if (!initial || (initial.nonAdminCarriers ?? 0) === 0) return new Set();
    return new Set(
        ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS.filter((key) => initial.permissionsJson.admin?.[key] !== true).map(
            (key) => `admin.${key}`,
        ),
    );
}

/** `perms` with every locked key off — a preset or a base role's defaults start inside the rule. */
function withoutLocked(perms: PermissionSet, locked: ReadonlySet<string>): PermissionSet {
    if (locked.size === 0) return perms;
    const admin = { ...perms.admin } as Record<string, boolean>;
    for (const key of locked) admin[key.slice('admin.'.length)] = false;
    return { ...perms, admin: admin as PermissionSet['admin'] };
}

// ─── Permission Grid Component ───

/**
 * One toggle per permission. A permission the EDITOR does not hold cannot be
 * turned on (#4467): the server refuses a role holding more than its author
 * does, and used to say so only on save, naming the permissions by their keys.
 * One the role already grants can still be turned off — the server accepts a
 * role narrowed to within the editor's own permissions, so the grid does too.
 */
function PermissionGrid({
    permissions,
    onChange,
    held,
    adminOnlyLocked,
}: {
    permissions: PermissionSet;
    onChange: (p: PermissionSet) => void;
    held: PermissionSet;
    /** `domain.action` keys this role may not gain while non-Admin members carry it. */
    adminOnlyLocked: ReadonlySet<string>;
}) {
    const labels = useRolesPageText();
    const { t } = labels;
    const toggle = (resource: keyof PermissionSet, action: string) => {
        const current = (permissions[resource] as Record<string, boolean>)[action] ?? false;
        if (!current && !holdsPermission(held, resource, action)) return;
        if (!current && adminOnlyLocked.has(`${resource}.${action}`)) return;
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
                            <th key={action} className="text-center px-2 align-bottom min-w-[4.5rem]">
                                {labels.action(action)}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {(Object.keys(PERMISSION_SCHEMA) as (keyof PermissionSet)[]).map((resource) => {
                        const resourceActions = PERMISSION_SCHEMA[resource];
                        return (
                            <tr key={resource} className="group/row">
                                <td className="sticky left-0 bg-bg-default/50 text-xs font-medium text-content-default group-hover/row:bg-bg-muted">
                                    {labels.resource(resource)}
                                </td>
                                {allActions.map((action) => {
                                    const hasAction = resourceActions.includes(action);
                                    if (!hasAction) {
                                        return <td key={action} className="text-center"><span className="text-content-subtle">—</span></td>;
                                    }
                                    const granted = (permissions[resource] as Record<string, boolean>)[action] ?? false;
                                    const holds = holdsPermission(held, resource, action);
                                    const carriageLocked = !granted && adminOnlyLocked.has(`${resource}.${action}`);
                                    const locked = (!granted && !holds) || carriageLocked;
                                    const permission = labels.permission(`${resource}.${action}`);
                                    const hint = granted
                                        ? t(holds ? 'roles.cellGranted' : 'roles.cellGrantedNotHeld', { permission })
                                        : !holds
                                          ? t('roles.cellNotHeld', { permission })
                                          : carriageLocked
                                            ? t('roles.cellAdminMembershipOnly', { permission })
                                            : t('roles.cellNotGranted', { permission });
                                    return (
                                        <td key={action} className="text-center">
                                            <Tooltip content={hint}>
                                                <button
                                                    type="button"
                                                    onClick={() => toggle(resource, action)}
                                                    // aria-disabled, not disabled: a disabled
                                                    // button takes no pointer or focus, so its
                                                    // tooltip could never say why it is off.
                                                    aria-disabled={locked || undefined}
                                                    aria-pressed={granted}
                                                    aria-label={permission}
                                                    className={cn(
                                                        'inline-flex items-center justify-center w-5 h-5 rounded transition',
                                                        granted
                                                            ? 'bg-bg-success text-content-success hover:bg-bg-success'
                                                            : 'bg-bg-elevated/50 text-content-subtle',
                                                        locked
                                                            ? 'opacity-40 cursor-not-allowed'
                                                            : 'cursor-pointer',
                                                        !granted && !locked && 'hover:bg-bg-muted',
                                                    )}
                                                    id={`perm-${resource}-${action}`}
                                                >
                                                    {granted ? <Check size={10} /> : null}
                                                </button>
                                            </Tooltip>
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
    const labels = useRolesPageText();
    const { t, roleLabel } = labels;
    // The editor's own permissions, as the server resolved them for this
    // request's tenant (custom-role aware). The server refuses a role that
    // grants more than these (`assertGrantWithinOwnAuthority`).
    const held = usePermissions();
    // While members who are not Admins carry the role, it may not be built on
    // ADMIN or gain an admin key only an ADMIN membership carries (owner
    // decision, 2026-10-30). Locked as the server judges it: against the role
    // as stored, so a legacy role can still be narrowed.
    const nonAdminCarriers = initial?.nonAdminCarriers ?? 0;
    const lockedKeys = useMemo(() => adminOnlyLockedKeys(initial), [initial]);
    const baseAdminLocked = nonAdminCarriers > 0 && initial?.baseRole !== 'ADMIN';
    const baseRoleOptions: ComboboxOption[] = useMemo(
        () =>
            BASE_ROLES.map((r) => ({
                value: r,
                label: roleLabel(r),
                ...(r === 'ADMIN' && baseAdminLocked ? { disabledTooltip: t('roles.baseAdminMembershipOnly') } : {}),
            })),
        [roleLabel, baseAdminLocked, t],
    );
    const [name, setName] = useState(initial?.name ?? '');
    const [description, setDescription] = useState(initial?.description ?? '');
    const [baseRole, setBaseRole] = useState<Role>(initial?.baseRole ?? 'READER');
    const [permissions, setPermissions] = useState<PermissionSet>(
        () => initial?.permissionsJson ?? withinHeld(getPermissionsForRole('READER'), held),
    );
    const [showGrid, setShowGrid] = useState(!!initial);

    // Permissions this role grants that the editor does not hold. Only an
    // existing role can have any (one an Owner built, say): the grid lets the
    // editor turn them off but not on, and the server refuses the save while
    // any remain, so the form says so and holds the button.
    const exceeding = permissionsExceeding(permissions, held);
    // A locked key switched on, or the ADMIN base chosen, while locked. The
    // grid and the base list never get there; held here so the button agrees.
    const breaksCarriage =
        (baseAdminLocked && baseRole === 'ADMIN') ||
        [...lockedKeys].some((key) => permissions.admin?.[key.slice('admin.'.length) as keyof PermissionSet['admin']] === true);
    // Whether the grid will grey anything out for this editor at all.
    const holdsLessThanAll = useMemo(
        () => permissionsExceeding(getPermissionsForRole('OWNER'), held).length > 0,
        [held],
    );

    const handleBaseRoleChange = (role: Role) => {
        setBaseRole(role);
        if (!initial) {
            setPermissions(withinHeld(getPermissionsForRole(role), held));
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
                        selected={baseRoleOptions.find(o => o.value === baseRole) ?? null}
                        setSelected={(opt) => { if (opt) handleBaseRoleChange(opt.value as Role); }}
                        options={baseRoleOptions}
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

            {nonAdminCarriers > 0 && (
                <InlineNotice variant="info" id="role-admin-membership-only">
                    {t('roles.adminMembershipOnlyNotice', {
                        count: nonAdminCarriers,
                        admin: roleLabel('ADMIN'),
                        permissions: ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS.map((k) => labels.permission(`admin.${k}`)).join(', '),
                    })}
                </InlineNotice>
            )}

            {exceeding.length > 0 && (
                <InlineNotice variant="warning" id="role-exceeds-held">
                    {t('roles.exceedsHeldNotice', {
                        permissions: exceeding.map(labels.permission).join(', '),
                    })}
                </InlineNotice>
            )}

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
                                        onClick={() => setPermissions(withoutLocked(withinHeld(getPermissionsForRole(r), held), lockedKeys))}
                                        className="text-[10px] px-2 py-0.5 rounded bg-bg-elevated/50 text-content-default hover:bg-bg-muted/50 transition"
                                        id={`preset-${r}`}
                                    >
                                        {roleLabel(r)}
                                    </button>
                                ))}
                            </div>
                        </div>
                        {holdsLessThanAll && (
                            <p className="text-xs text-content-muted mb-3" id="roles-not-held-hint">
                                {t('roles.notHeldHint')}
                            </p>
                        )}
                        <PermissionGrid
                            permissions={permissions}
                            onChange={setPermissions}
                            held={held}
                            adminOnlyLocked={lockedKeys}
                        />
                    </div>
                )}
            </div>

            <div className="flex gap-tight pt-2">
                <Button
                    variant="primary"
                    type="button"
                    onClick={() => onSubmit({ name: name.trim(), description: description.trim(), baseRole, permissionsJson: permissions })}
                    disabled={submitting || !name.trim() || exceeding.length > 0 || breaksCarriage}
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
    const labels = useRolesPageText();
    const { t, roleLabel } = labels;
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    // Create, change and delete pass the edge (an Owner or Admin MEMBERSHIP),
    // the routes' `admin.manage` and the usecases' `assertCanManageMembers`
    // (the coarse admin tier of a custom role's base). Offered only where all
    // three let it through (#4467 findings 6 and 9).
    const canManage = useOffersAdminApiWrite({ key: 'admin.manage', floor: 'canAdmin' });

    const [roles, setRoles] = useState<CustomRole[]>([]);
    const [loading, setLoading] = useState(true);
    // The role list did not load: the server's reason, shown IN PLACE of the
    // table. Kept apart from `error` (an action's refusal) because an empty
    // table under a failed load reads as "this workspace has no custom roles".
    const [loadError, setLoadError] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    // Form state
    const [showCreate, setShowCreate] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    // Delete confirmation
    const [deleteTarget, setDeleteTarget] = useState<CustomRole | null>(null);
    const [deleteOpen, setDeleteOpen] = useState(false);

    // ─── Data Fetching ───
    const fetchRoles = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/admin/roles'));
            if (res.ok) {
                const data = await res.json();
                setRoles(Array.isArray(data) ? data.filter((r: CustomRole) => r.isActive) : []);
                setLoadError(null);
            } else {
                const body = await res.json().catch(() => null);
                setLoadError(apiErrorMessage(body, t('roles.loadFailed')));
            }
        } catch {
            setLoadError(t('roles.loadFailed'));
        } finally {
            setLoading(false);
        }
    }, [apiUrl, t]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchRoles(); }, [fetchRoles]);

    /**
     * A refused create or update, in the user's language. The "you cannot
     * grant what you do not hold" refusal names permissions by their keys,
     * so it is re-said with the grid's labels; any other refusal is the
     * server's own sentence.
     */
    const refusalMessage = (body: unknown, fallback: string): string => {
        const exceeded = grantExceedingKeys(body);
        if (exceeded && exceeded.length > 0) {
            return t('roles.grantRefused', { permissions: exceeded.map(labels.permission).join(', ') });
        }
        // Only an ADMIN membership carries a role built on ADMIN or granting an
        // admin-membership-only key (2026-10-30): said with the grid's labels.
        const carriage = customRoleCarriageRefusalOf(body);
        if (carriage) {
            return carriage.reason === CUSTOM_ROLE_ADMIN_BASE_REFUSAL
                ? t('roles.carriageRefusedBase', {
                      base: roleLabel(carriage.baseRole ?? 'ADMIN'),
                      count: carriage.blockingMemberships,
                  })
                : t('roles.carriageRefusedKeys', {
                      permissions: carriage.keys.map(labels.permission).join(', '),
                      count: carriage.blockingMemberships,
                  });
        }
        return apiErrorMessage(body, fallback);
    };

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
                const body = await res.json().catch(() => null);
                setError(refusalMessage(body, t('roles.createFailed')));
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
                const body = await res.json().catch(() => null);
                setError(refusalMessage(body, t('roles.updateFailed')));
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

    /**
     * Delete goes through a ConfirmDialog, not the Epic 67 undo toast. A
     * custom role is access configuration, and deleting one changes what
     * OTHER people may do: every member carrying it goes back to the role on
     * their own membership, which can allow more than the custom role did.
     * That has to be read before the commit, which a toast shown after the
     * click cannot do, and once committed re-creating the role does not give
     * it back to anyone (docs/destructive-actions.md, "When NOT to use this
     * pattern"). The dialog's verb is "Delete", the destructive vocabulary for
     * erasing a configuration.
     */
    async function performDelete() {
        const role = deleteTarget;
        if (!role) return;
        setError(null);
        setSuccess(null);
        try {
            const res = await fetch(apiUrl(`/admin/roles/${role.id}`), { method: 'DELETE' });
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                setError(apiErrorMessage(body, t('roles.deleteFailed')));
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
                        {roleLabel(row.original.baseRole)}
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
                    if (!canManage) return null;
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
                                    onClick={() => {
                                        setDeleteTarget(role);
                                        setDeleteOpen(true);
                                    }}
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
        [t, roleLabel, canManage],
    );

    // The back link and breadcrumb, in every state — they rendered only while
    // the page was loading (#4467).
    const pageNav = (
        <>
            <BackAffordance />
            <PageBreadcrumbs
                items={[
                    { label: t('crumb.dashboard'), href: tenantHref('/dashboard') },
                    { label: t('crumb.admin'), href: tenantHref('/admin') },
                    { label: t('roles.crumbSelf') },
                ]}
                className="mb-1"
            />
        </>
    );

    // ─── Loading ───
    if (loading) {
        return (
            <div className="space-y-section animate-fadeIn">
                {pageNav}
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
            <ListPageShell.Header className="space-y-default">
                {pageNav}
                <div className="flex items-center justify-between flex-wrap gap-default">
                    <div>
                        <Heading level={1} className="flex items-center gap-tight">
                            <Shield className="w-6 h-6 text-[var(--brand-default)]" />
                            {t('roles.title')}
                        </Heading>
                        {/* No count over a list that did not load: "0 custom
                            roles" would be a claim the page cannot make. */}
                        {!loadError && (
                            <p className="text-sm text-content-muted mt-1">
                                {t('roles.headerDesc', { count: roles.length })}
                            </p>
                        )}
                    </div>
                    {canManage && !showCreate && !editingId && (
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
                {!canManage && (
                    <InlineNotice variant="info" id="roles-manage-refused">
                        {t('roles.manageRefusedNotice')}
                    </InlineNotice>
                )}
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
                    {loadError ? (
                        // A failed load is never "No custom roles defined
                        // yet": the list is unknown, and the server's reason
                        // says why.
                        <ErrorState
                            title={t('roles.loadFailed')}
                            description={loadError !== t('roles.loadFailed') ? loadError : undefined}
                            onRetry={() => { void fetchRoles(); }}
                            data-testid="roles-load-error"
                        />
                    ) : (
                        <DataTable
                            fillBody
                            data={visibleRoles}
                            columns={roleColumns}
                            getRowId={(r) => r.id}
                            emptyState={t('roles.emptyState', { button: t('roles.addRole') })}
                            resourceName={(p) => (p ? t('roles.rolesPlural') : t('roles.roleSingular'))}
                            selectionEnabled={false}
                            data-testid="roles-table"
                        />
                    )}
                </div>
            </ListPageShell.Body>

            <ConfirmDialog
                showModal={deleteOpen}
                setShowModal={setDeleteOpen}
                tone="danger"
                title={deleteTarget ? t('roles.deleteTitle', { name: deleteTarget.name }) : ''}
                description={
                    deleteTarget && deleteTarget._count.memberships > 0
                        ? `${t('roles.deleteDesc')} ${t('roles.deleteMemberWarning', { count: deleteTarget._count.memberships })}`
                        : t('roles.deleteDesc')
                }
                confirmLabel={t('roles.deleteConfirmLabel')}
                onConfirm={performDelete}
            />
        </ListPageShell>
    );
}
