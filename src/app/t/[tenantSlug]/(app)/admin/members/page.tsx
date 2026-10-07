'use client';
/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/**
 * Members & Roles admin — Epic 48 DataTable migration.
 *
 * Two stacked DataTables (members + pending invites) replacing
 * the previous hand-rolled `<table className="data-table">`
 * markup. Same data, same handlers, same stable IDs — the only
 * thing that changes is the rendering layer.
 *
 * The page stays in the ListPageShell-coverage exemption list
 * for the same reason `admin/api-keys/page.tsx` is exempt:
 * multi-table layout (members + invites stacked) doesn't fit
 * the viewport-clamp pattern that ListPageShell exists for.
 */

import { formatDate } from '@/lib/format-date';
import { Card, cardVariants } from '@/components/ui/card';
import { useMemo, useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import {
    Users, UserPlus, ChevronDown, Shield, XCircle,
    MoreVertical, UserMinus, Mail, Monitor, Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover } from '@/components/ui/popover';
import { BulkActionBar, type BulkActionDef } from '@/components/ui/bulk-action-bar';
import { StatusBadge, statusBadgeVariants } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton, SkeletonButton } from '@/components/ui/skeleton';
import { Modal } from '@/components/ui/modal';
import { Combobox, ComboboxOption } from '@/components/ui/combobox';
import { Tooltip } from '@/components/ui/tooltip';
import { DataTable, createColumns } from '@/components/ui/table';
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { InlineNotice } from '@/components/ui/inline-notice';
import { CopyText } from '@/components/ui/copy-text';
import { cn } from '@inflect/ui/lib/cn';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';

// ─── Types ───

interface CustomRoleOption {
    id: string;
    name: string;
    baseRole: string;
}

interface Member {
    id: string;
    userId: string;
    role: string;
    customRoleId: string | null;
    customRole: { id: string; name: string } | null;
    status: string;
    invitedAt: string | null;
    deactivatedAt: string | null;
    createdAt: string;
    user: {
        id: string;
        name: string | null;
        email: string;
        image: string | null;
        createdAt: string;
    };
    invitedBy: { id: string; name: string | null } | null;
    /** Epic C.3 — count of live (non-revoked, non-expired) sessions. */
    activeSessionCount?: number;
}

interface MemberSession {
    sessionId: string;
    userId: string;
    tenantId: string | null;
    ipAddress: string | null;
    userAgent: string | null;
    createdAt: string;
    expiresAt: string;
    lastActiveAt: string;
}

interface Invite {
    id: string;
    email: string;
    role: string;
    expiresAt: string;
    createdAt: string;
    invitedBy: { id: string; name: string | null } | null;
}

/**
 * Defensive normaliser for the members API response. The list cells render
 * `m.user.name` / `m.user.email` / `m.user.image` directly, so a membership
 * whose `user` relation failed to resolve (or any non-array payload) would
 * throw during render and trip the page-level error boundary
 * ("Something went wrong"). Guarantee a well-formed shape so the page can
 * never crash on a single malformed row.
 */
function normalizeMember(m: Member): Member {
    return {
        ...m,
        user: m.user ?? {
            id: m.userId ?? '',
            name: null,
            email: '',
            image: null,
            createdAt: m.createdAt ?? '',
        },
    };
}

/**
 * Coerce an API error response body to a human string for setError().
 *
 * The API error envelope is `{ error: { code, message, requestId } }`
 * (toApiErrorResponse). Passing the raw `err.error` OBJECT to setError() and
 * rendering it as a React child throws "Minified React error #31 — objects are
 * not valid as a React child", which trips the page error boundary. This is
 * exactly what broke inviting: a 4xx invite response (e.g. "already a member")
 * set the error state to the object and crashed the page. Always coerce.
 */
function apiErrorMessage(body: unknown, fallback: string): string {
    if (body && typeof body === 'object') {
        const b = body as { error?: unknown; message?: unknown };
        if (typeof b.error === 'string') return b.error;
        if (b.error && typeof b.error === 'object') {
            const inner = b.error as { message?: unknown };
            if (typeof inner.message === 'string') return inner.message;
        }
        if (typeof b.message === 'string') return b.message;
    }
    return fallback;
}

const ROLES = ['ADMIN', 'EDITOR', 'AUDITOR', 'READER'] as const;
const ROLE_VARIANT: Record<string, 'error' | 'info' | 'warning' | 'neutral'> = {
    ADMIN: 'error',
    EDITOR: 'info',
    AUDITOR: 'warning',
    READER: 'neutral',
};
const ROLE_CB_OPTIONS: ComboboxOption[] = ROLES.map(r => ({ value: r, label: r }));
const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'error' | 'neutral'> = {
    ACTIVE: 'success',
    INVITED: 'warning',
    DEACTIVATED: 'error',
    REMOVED: 'neutral',
};

export default function MembersAdminPage() {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();

    // ─── State ───
    const [members, setMembers] = useState<Member[]>([]);
    const [invites, setInvites] = useState<Invite[]>([]);
    const [loading, setLoading] = useState(true);
    // R14-PR7 — standalone search input retired. Member lists are
    // typically <50; users can scroll or navigate to a specific
    // member via the global command palette (⌘K).
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    // Absolute invite link from the last "add member" — a share-anywhere
    // fallback so access never depends on the invite email arriving.
    const [inviteLink, setInviteLink] = useState<string | null>(null);

    // Invite form
    const [showInvite, setShowInvite] = useState(false);
    const [inviteEmail, setInviteEmail] = useState('');
    const [inviteRole, setInviteRole] = useState<string>('READER');
    const [inviting, setInviting] = useState(false);

    // Role change
    const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
    const [pendingRole, setPendingRole] = useState<string>('');
    const [pendingCustomRoleId, setPendingCustomRoleId] = useState<string | null>(null);
    const [changingRole, setChangingRole] = useState(false);

    // Custom roles
    const [customRoles, setCustomRoles] = useState<CustomRoleOption[]>([]);

    // Action menu
    const [openMenuId, setOpenMenuId] = useState<string | null>(null);

    // Bulk selection + top action row (deactivate / remove).
    const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(new Set());
    const [bulkApplying, setBulkApplying] = useState(false);

    // Bulk selection + top action row for pending invites (revoke).
    const [selectedInviteIds, setSelectedInviteIds] = useState<Set<string>>(new Set());
    const [bulkRevokingInvites, setBulkRevokingInvites] = useState(false);

    // Epic C.3 — sessions modal
    const [sessionsModalUser, setSessionsModalUser] = useState<Member | null>(null);
    const [memberSessions, setMemberSessions] = useState<MemberSession[]>([]);
    const [sessionsLoading, setSessionsLoading] = useState(false);
    const [revokingSessionId, setRevokingSessionId] = useState<string | null>(null);

    // ─── Data fetching ───
    const fetchMembers = useCallback(async () => {
        try {
            const [membersRes, invitesRes, rolesRes] = await Promise.all([
                fetch(apiUrl('/admin/members')),
                fetch(apiUrl('/admin/members?view=invites')),
                fetch(apiUrl('/admin/roles')),
            ]);
            if (membersRes.ok) {
                const raw = await membersRes.json();
                setMembers(Array.isArray(raw) ? raw.map(normalizeMember) : []);
            }
            if (invitesRes.ok) {
                const raw = await invitesRes.json();
                setInvites(Array.isArray(raw) ? raw : []);
            }
            if (rolesRes.ok) {
                const allRoles = await rolesRes.json();
                setCustomRoles(
                    Array.isArray(allRoles)
                        ? allRoles.filter((r: CustomRoleOption & { isActive: boolean }) => r.isActive)
                        : [],
                );
            }
        } catch {
            setError(t('members.failedLoadMembers'));
        } finally {
            setLoading(false);
        }
    }, [apiUrl, t]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchMembers(); }, [fetchMembers]);

    // ─── Handlers (unchanged from pre-migration) ───
    async function handleInvite() {
        if (!inviteEmail.trim()) return;
        setError(null);
        setSuccess(null);
        setInviteLink(null);
        setInviting(true);

        try {
            const res = await fetch(apiUrl('/admin/members'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: inviteEmail.trim().toLowerCase(), role: inviteRole }),
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: t('members.inviteFailed') }));
                setError(apiErrorMessage(err, t('members.inviteFailed')));
                return;
            }

            const data = await res.json();
            // The member is authorised the moment they sign in with this
            // email — access no longer depends on the invite email arriving.
            setSuccess(t('members.memberAddedLoginHint', { email: inviteEmail, role: inviteRole }));
            setInviteLink(
                typeof data?.url === 'string' ? `${window.location.origin}${data.url}` : null,
            );
            setInviteEmail('');
            setInviteRole('READER');
            setShowInvite(false);
            await fetchMembers();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setInviting(false);
        }
    }

    async function handleRoleChange(membershipId: string) {
        setError(null);
        setSuccess(null);
        setChangingRole(true);

        try {
            const member = members.find(m => m.id === membershipId);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const payload: Record<string, any> = {};
            if (pendingRole && pendingRole !== member?.role) {
                payload.role = pendingRole;
            }
            if (pendingCustomRoleId !== (member?.customRoleId ?? null)) {
                payload.customRoleId = pendingCustomRoleId;
            }

            if (Object.keys(payload).length === 0) {
                setEditingRoleId(null);
                return;
            }

            const res = await fetch(apiUrl(`/admin/members/${membershipId}`), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: t('members.roleChangeFailed') }));
                setError(apiErrorMessage(err, t('members.roleChangeFailed')));
                return;
            }

            setSuccess(t('members.roleUpdated'));
            setEditingRoleId(null);
            await fetchMembers();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setChangingRole(false);
        }
    }

    async function handleDeactivate(membershipId: string, email: string) {
        if (!confirm(t('members.deactivateConfirm', { email }))) return;
        setError(null);
        setSuccess(null);
        setOpenMenuId(null);

        try {
            const res = await fetch(apiUrl(`/admin/members/${membershipId}/deactivate`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: t('members.deactivationFailed') }));
                setError(apiErrorMessage(err, t('members.deactivationFailed')));
                return;
            }

            setSuccess(t('members.deactivatedToast', { email }));
            await fetchMembers();
        } catch (err) {
            setError((err as Error).message);
        }
    }

    async function handleRemove(membershipId: string, email: string) {
        if (!confirm(t('members.removeConfirm', { email }))) return;
        setError(null);
        setSuccess(null);
        setOpenMenuId(null);

        try {
            const res = await fetch(apiUrl(`/admin/members/${membershipId}`), {
                method: 'DELETE',
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: t('members.removalFailed') }));
                setError(apiErrorMessage(err, t('members.removalFailed')));
                return;
            }

            setSuccess(t('members.removedToast', { email }));
            await fetchMembers();
        } catch (err) {
            setError((err as Error).message);
        }
    }

    // Top action row — apply deactivate/remove across the selected members.
    // The per-member endpoints are looped client-side (no bulk endpoint); a
    // partial failure surfaces the affected emails without blocking the rest.
    const handleBulkApply = async (action: string) => {
        const ids = Array.from(selectedMemberIds);
        if (ids.length === 0) return;
        setError(null);
        setSuccess(null);
        setBulkApplying(true);

        let ok = 0;
        const failures: string[] = [];
        try {
            for (const id of ids) {
                const email = members.find((m) => m.id === id)?.user.email ?? id;
                const fallback = action === 'remove'
                    ? t('members.removalFailed')
                    : t('members.deactivationFailed');
                try {
                    const res = action === 'remove'
                        ? await fetch(apiUrl(`/admin/members/${id}`), { method: 'DELETE' })
                        : await fetch(apiUrl(`/admin/members/${id}/deactivate`), { method: 'POST' });
                    if (res.ok) {
                        ok += 1;
                    } else {
                        const err = await res.json().catch(() => ({}));
                        failures.push(`${email}: ${apiErrorMessage(err, fallback)}`);
                    }
                } catch (e) {
                    failures.push(`${email}: ${(e as Error).message}`);
                }
            }
            if (ok > 0) {
                setSuccess(t(action === 'remove' ? 'members.bulkRemovedToast' : 'members.bulkDeactivatedToast', { count: ok }));
            }
            if (failures.length > 0) {
                setError(failures.join('; '));
            }
            setSelectedMemberIds(new Set());
            await fetchMembers();
        } finally {
            setBulkApplying(false);
        }
    };

    const memberBulkActions: BulkActionDef[] = useMemo(() => [
        {
            value: 'deactivate',
            label: t('members.deactivate'),
            confirm: { tone: 'warning', confirmLabel: t('members.deactivate') },
        },
        {
            value: 'remove',
            label: t('members.remove'),
            confirm: { tone: 'danger', confirmLabel: t('members.remove') },
        },
    ], [t]);

    // Top action row for pending invites — revoke the selected invitations.
    // Loops the per-invite DELETE endpoint client-side (no bulk endpoint); a
    // partial failure surfaces the affected emails without blocking the rest.
    const handleBulkRevokeInvites = async () => {
        const ids = Array.from(selectedInviteIds);
        if (ids.length === 0) return;
        setError(null);
        setSuccess(null);
        setBulkRevokingInvites(true);

        let ok = 0;
        const failures: string[] = [];
        try {
            for (const id of ids) {
                const email = invites.find((i) => i.id === id)?.email ?? id;
                try {
                    const res = await fetch(apiUrl(`/admin/invites/${id}`), { method: 'DELETE' });
                    if (res.ok) {
                        ok += 1;
                    } else {
                        const err = await res.json().catch(() => ({}));
                        failures.push(`${email}: ${apiErrorMessage(err, t('members.inviteRevocationFailed'))}`);
                    }
                } catch (e) {
                    failures.push(`${email}: ${(e as Error).message}`);
                }
            }
            if (ok > 0) {
                setSuccess(t('members.bulkRevokedInvitesToast', { count: ok }));
            }
            if (failures.length > 0) {
                setError(failures.join('; '));
            }
            setSelectedInviteIds(new Set());
            await fetchMembers();
        } finally {
            setBulkRevokingInvites(false);
        }
    };

    const inviteBulkActions: BulkActionDef[] = useMemo(() => [
        {
            value: 'revoke',
            label: t('members.revokeInviteAction'),
            confirm: { tone: 'danger', confirmLabel: t('members.revokeInviteAction') },
        },
    ], [t]);

    const openSessionsModal = useCallback(async (member: Member) => {
        setSessionsModalUser(member);
        setSessionsLoading(true);
        setMemberSessions([]);
        try {
            const res = await fetch(
                apiUrl(`/admin/sessions?userId=${encodeURIComponent(member.userId)}`),
            );
            if (res.ok) {
                const data = await res.json() as { sessions: MemberSession[] };
                setMemberSessions(data.sessions);
            } else {
                setError(t('members.failedLoadSessions'));
            }
        } catch {
            setError(t('members.failedLoadSessions'));
        } finally {
            setSessionsLoading(false);
        }
    }, [apiUrl, t]);

    const closeSessionsModal = useCallback(() => {
        setSessionsModalUser(null);
        setMemberSessions([]);
    }, []);

    const handleRevokeSession = useCallback(async (sessionId: string) => {
        if (!sessionsModalUser) return;
        if (!confirm(t('members.revokeSessionConfirm'))) return;
        setRevokingSessionId(sessionId);
        try {
            const res = await fetch(apiUrl('/admin/sessions'), {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId, reason: `Revoked from members admin UI` }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                setError(apiErrorMessage(err, t('members.revocationFailed')));
                return;
            }
            setMemberSessions((sessions) => sessions.filter((s) => s.sessionId !== sessionId));
            setSuccess(t('members.sessionRevoked'));
            void fetchMembers();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setRevokingSessionId(null);
        }
    }, [apiUrl, fetchMembers, sessionsModalUser, t]);

    // ─── Filter (R14-PR7 — search retired; full list shown) ───
    const filteredMembers = members;

    // ─── Members DataTable columns ───
    const memberColumns = useMemo(
        () => createColumns<Member>([
            {
                id: 'member',
                header: t('members.colMember'),
                accessorFn: (m) => m.user.name ?? m.user.email,
                cell: ({ row }) => {
                    const m = row.original;
                    return (
                        <div className="flex items-center gap-tight">
                            <InitialsAvatar
                                value={m.user.name || m.user.email}
                                size="md"
                                imageUrl={m.user.image}
                            />
                            <span className="text-sm font-medium text-content-emphasis">{m.user.name || '—'}</span>
                        </div>
                    );
                },
            },
            {
                id: 'email',
                header: t('members.colEmail'),
                accessorFn: (m) => m.user.email,
                cell: ({ row }) => (
                    <span className="text-content-muted">{row.original.user.email}</span>
                ),
            },
            {
                id: 'role',
                header: t('members.colRole'),
                accessorKey: 'role',
                cell: ({ row }) => {
                    const m = row.original;
                    if (editingRoleId === m.id) {
                        return (
                            <div className="space-y-1">
                                <div className="flex items-center gap-1">
                                    <Combobox
                                        hideSearch
                                        id={`role-select-${m.id}`}
                                        selected={ROLE_CB_OPTIONS.find(o => o.value === pendingRole) ?? null}
                                        setSelected={(opt) => setPendingRole(opt?.value ?? pendingRole)}
                                        options={ROLE_CB_OPTIONS}
                                        matchTriggerWidth
                                        buttonProps={{ className: 'text-xs py-1 px-2 w-full sm:w-28' }}
                                    />
                                    <Button
                                        variant="secondary"
                                        size="xs"
                                        onClick={() => handleRoleChange(m.id)}
                                        disabled={changingRole}
                                        loading={changingRole}
                                        id={`role-save-${m.id}`}
                                    >
                                        {t('members.save')}
                                    </Button>
                                    <Button
                                        variant="secondary"
                                        size="xs"
                                        onClick={() => setEditingRoleId(null)}
                                        icon={<XCircle className="w-3.5 h-3.5" />}
                                    />
                                </div>
                                {customRoles.length > 0 && (
                                    <Combobox
                                        hideSearch
                                        id={`custom-role-select-${m.id}`}
                                        selected={customRoles.map(cr => ({ value: cr.id, label: cr.name })).find(o => o.value === (pendingCustomRoleId ?? '')) ?? null}
                                        setSelected={(opt) => setPendingCustomRoleId(opt?.value || null)}
                                        options={customRoles.map(cr => ({ value: cr.id, label: cr.name }))}
                                        placeholder={t('members.customRolePlaceholder')}
                                        matchTriggerWidth
                                        buttonProps={{ className: 'text-xs py-1 px-2 w-full sm:w-48' }}
                                    />
                                )}
                            </div>
                        );
                    }
                    return (
                        <div className="flex items-center gap-1 flex-wrap">
                            <Tooltip
                                content={t('members.clickToChangeRole')}
                                disabled={m.status !== 'ACTIVE'}
                            >
                                <button
                                    type="button"
                                    className={cn(
                                        statusBadgeVariants({ variant: ROLE_VARIANT[m.role] || 'neutral' }),
                                        'cursor-pointer hover:opacity-80 transition',
                                    )}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        if (m.status === 'ACTIVE') {
                                            setEditingRoleId(m.id);
                                            setPendingRole(m.role);
                                            setPendingCustomRoleId(m.customRoleId);
                                        }
                                    }}
                                    id={`role-badge-${m.id}`}
                                >
                                    {m.role}
                                    {m.status === 'ACTIVE' && <ChevronDown className="w-3.5 h-3.5 ml-0.5" />}
                                </button>
                            </Tooltip>
                            {m.customRole && (
                                <Tooltip
                                    title={t('members.customRoleTitle')}
                                    content={m.customRole.name}
                                >
                                    <span className="inline-flex items-center rounded-md px-2 py-1 text-[10px] font-medium bg-info text-content-info border border-border-info cursor-help">
                                        {m.customRole.name}
                                    </span>
                                </Tooltip>
                            )}
                        </div>
                    );
                },
            },
            {
                id: 'status',
                header: t('members.colStatus'),
                accessorKey: 'status',
                cell: ({ row }) => (
                    <StatusBadge variant={STATUS_VARIANT[row.original.status] || 'neutral'} icon={null} size="sm">
                        {row.original.status}
                    </StatusBadge>
                ),
            },
            {
                id: 'sessions',
                header: t('members.colSessions'),
                accessorFn: (m) => m.activeSessionCount ?? 0,
                cell: ({ row }) => {
                    const m = row.original;
                    const count = m.activeSessionCount ?? 0;
                    return (
                        <button
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation();
                                void openSessionsModal(m);
                            }}
                            className={cn(
                                'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium border transition-colors',
                                count > 0
                                    ? 'bg-bg-success text-content-success border-border-success hover:bg-bg-success'
                                    : 'bg-bg-muted text-content-subtle border-border-subtle hover:bg-bg-muted',
                            )}
                            id={`sessions-count-${m.id}`}
                            aria-label={t('members.viewSessionsAria', { count, email: m.user.email })}
                        >
                            <Monitor className="w-3.5 h-3.5" />
                            {count}
                        </button>
                    );
                },
            },
            {
                id: 'joined',
                header: t('members.colJoined'),
                accessorKey: 'createdAt',
                cell: ({ row }) => (
                    <span className="text-content-subtle">{formatDate(row.original.createdAt)}</span>
                ),
            },
            {
                id: 'actions',
                header: '',
                cell: ({ row }) => {
                    const m = row.original;
                    const isActive = m.status === 'ACTIVE';
                    return (
                        // R3 fix — the old in-cell absolute dropdown was clipped
                        // by the DataTable's overflow container (so clicking the
                        // three-dot appeared to do nothing). Popover portals the
                        // menu out of the clip, and adds a Remove action.
                        <div className="text-right" onClick={(e) => e.stopPropagation()}>
                            <Popover
                                align="end"
                                openPopover={openMenuId === m.id}
                                setOpenPopover={(open) => setOpenMenuId(open ? m.id : null)}
                                content={
                                    <Popover.Menu>
                                        {isActive && (
                                            <>
                                                <Popover.Item
                                                    icon={<Shield className="w-3.5 h-3.5" />}
                                                    onClick={() => {
                                                        setEditingRoleId(m.id);
                                                        setPendingRole(m.role);
                                                        setOpenMenuId(null);
                                                    }}
                                                    id={`action-change-role-${m.id}`}
                                                >
                                                    {t('members.changeRole')}
                                                </Popover.Item>
                                                <Popover.Item
                                                    icon={<Monitor className="w-3.5 h-3.5" />}
                                                    onClick={() => {
                                                        setOpenMenuId(null);
                                                        void openSessionsModal(m);
                                                    }}
                                                    id={`action-view-sessions-${m.id}`}
                                                >
                                                    {t('members.viewSessions')}
                                                </Popover.Item>
                                                <Popover.Item
                                                    icon={<UserMinus className="w-3.5 h-3.5" />}
                                                    destructive
                                                    onClick={() => handleDeactivate(m.id, m.user.email)}
                                                    id={`action-deactivate-${m.id}`}
                                                >
                                                    {t('members.deactivate')}
                                                </Popover.Item>
                                            </>
                                        )}
                                        <Popover.Item
                                            icon={<Trash2 className="w-3.5 h-3.5" />}
                                            destructive
                                            onClick={() => handleRemove(m.id, m.user.email)}
                                            id={`action-remove-${m.id}`}
                                        >
                                            {t('members.remove')}
                                        </Popover.Item>
                                    </Popover.Menu>
                                }
                            >
                                <Button
                                    variant="secondary"
                                    size="xs"
                                    icon={<MoreVertical className="w-3.5 h-3.5" />}
                                    id={`member-menu-${m.id}`}
                                    aria-label={t('members.memberActions')}
                                />
                            </Popover>
                        </div>
                    );
                },
            },
        ]),
        // Re-derive columns when any state used inline by the cells
        // changes — otherwise the inline edit row's combobox would
        // render with a stale selection.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [editingRoleId, pendingRole, pendingCustomRoleId, changingRole, customRoles, openMenuId, t],
    );

    // ─── Invites DataTable columns ───
    const inviteColumns = useMemo(
        () => createColumns<Invite>([
            {
                id: 'email',
                header: t('members.colEmail'),
                accessorKey: 'email',
                cell: ({ row }) => (
                    <span className="text-sm text-content-emphasis">{row.original.email}</span>
                ),
            },
            {
                id: 'role',
                header: t('members.colRole'),
                accessorKey: 'role',
                cell: ({ row }) => (
                    <StatusBadge variant={ROLE_VARIANT[row.original.role] || 'neutral'} icon={null}>
                        {row.original.role}
                    </StatusBadge>
                ),
            },
            {
                id: 'invitedBy',
                header: t('members.colInvitedBy'),
                accessorFn: (i) => i.invitedBy?.name ?? '—',
                cell: ({ row }) => (
                    <span className="text-content-muted">{row.original.invitedBy?.name || '—'}</span>
                ),
            },
            {
                id: 'expires',
                header: t('members.colExpires'),
                accessorKey: 'expiresAt',
                cell: ({ row }) => (
                    <span className="text-content-subtle">{formatDate(row.original.expiresAt)}</span>
                ),
            },
        ]),
        [t],
    );

    // ─── Loading state ───
    if (loading) {
        return (
            <div className="space-y-section animate-fadeIn">
                <BackAffordance />
                <PageBreadcrumbs
                    items={[
                        { label: t('crumb.dashboard'), href: tenantHref('/dashboard') },
                        { label: t('crumb.admin'), href: tenantHref('/admin') },
                        { label: t('members.crumbSelf') },
                    ]}
                    className="mb-1"
                />
                <Heading level={2} className="flex items-center gap-tight">
                    <Users className="w-6 h-6 text-[var(--brand-default)]" />
                    {t('members.loadingTitle')}
                </Heading>
                <Card className="space-y-default">
                    <div className="h-4 bg-bg-subtle rounded w-1/3 animate-pulse" />
                    <div className="h-4 bg-bg-subtle rounded w-2/3 animate-pulse" />
                    <div className="h-4 bg-bg-subtle rounded w-1/2 animate-pulse" />
                </Card>
            </div>
        );
    }

    return (
        <div className="space-y-section animate-fadeIn">
            {/* Header */}
            <div className="flex items-center justify-between flex-wrap gap-default">
                <div>
                    <Heading level={1} className="flex items-center gap-tight">
                        <Users className="w-6 h-6 text-[var(--brand-default)]" />
                        {t('members.title')}
                    </Heading>
                    <p className="text-sm text-content-muted mt-1">
                        {t('members.activeMembers', { count: members.filter(m => m.status === 'ACTIVE').length })}
                        {invites.length > 0 && ` · ${t('members.pendingInvites', { count: invites.length })}`}
                    </p>
                </div>
                <Button
                    variant="primary"
                    onClick={() => setShowInvite(true)}
                    icon={<UserPlus className="w-3.5 h-3.5" />}
                    id="invite-member-btn"
                >
                    {t('members.inviteMember')}
                </Button>
            </div>

            {/* Messages */}
            {error && (
                <InlineNotice
                    variant="error"
                    id="members-error"
                    onDismiss={() => setError(null)}
                >
                    {error}
                </InlineNotice>
            )}
            {success && (
                <InlineNotice
                    variant="success"
                    id="members-success"
                    onDismiss={() => { setSuccess(null); setInviteLink(null); }}
                >
                    <div className="space-y-tight">
                        <span>{success}</span>
                        {inviteLink && (
                            <div className="flex items-center gap-tight text-xs">
                                <span className="text-content-muted shrink-0">
                                    {t('members.inviteLinkLabel')}
                                </span>
                                <CopyText
                                    value={inviteLink}
                                    label={t('members.copyInviteLink')}
                                    truncate
                                    className="min-w-0 font-mono"
                                >
                                    {inviteLink}
                                </CopyText>
                            </div>
                        )}
                    </div>
                </InlineNotice>
            )}

            {/* Invite Form */}
            {showInvite && (
                <div className={cn(cardVariants(), 'border border-[var(--brand-default)]/30')} id="invite-form">
                    <Heading level={3} className="mb-4">{t('members.inviteFormTitle')}</Heading>
                    <div className="flex gap-compact items-end flex-wrap">
                        <div className="flex-1 min-w-[200px]">
                            <label className="text-xs text-content-muted uppercase tracking-wider mb-1 block">
                                {t('members.emailLabel')}
                            </label>
                            <input
                                id="invite-email-input"
                                type="email"
                                value={inviteEmail}
                                onChange={(e) => setInviteEmail(e.target.value)}
                                placeholder={t('members.emailPlaceholder')}
                                className="input w-full"
                                autoFocus
                            />
                        </div>
                        <div className="w-full sm:w-40">
                            <label className="text-xs text-content-muted uppercase tracking-wider mb-1 block">
                                {t('members.roleLabel')}
                            </label>
                            <Combobox
                                hideSearch
                                id="invite-role-select"
                                selected={ROLE_CB_OPTIONS.find(o => o.value === inviteRole) ?? null}
                                setSelected={(opt) => setInviteRole(opt?.value ?? 'READER')}
                                options={ROLE_CB_OPTIONS}
                                matchTriggerWidth
                            />
                        </div>
                        <Button
                            variant="primary"
                            onClick={handleInvite}
                            disabled={inviting || !inviteEmail.trim()}
                            loading={inviting}
                            icon={<Mail className="w-3.5 h-3.5" />}
                            id="send-invite-btn"
                        >
                            {t('members.sendInvite')}
                        </Button>
                        <Button
                            variant="secondary"
                            onClick={() => { setShowInvite(false); setInviteEmail(''); }}
                        >
                            {t('members.cancel')}
                        </Button>
                    </div>
                </div>
            )}

            {/* R14-PR7 — standalone "Search members" input retired.
                Find a specific member via the global command palette
                (⌘K) or scroll the list. If granular filtering becomes
                load-bearing here, adopt FilterToolbar — never
                reintroduce a hand-rolled `<input>` per CLAUDE.md
                filter strategy. */}

            {/* Members DataTable (Epic 48 migration).
                R13-PR5 — the outer `cardVariants({ density: 'none' })`
                wrapper was dropped so the DataTable primitive's own
                `bg-bg-default rounded-lg border-border-subtle` card
                is the only one (matches Controls list visually). */}
            <div id="members-table-card">
                {filteredMembers.length === 0 ? (
                    <EmptyState
                        icon={Users}
                        title={t('members.noMembersTitle')}
                    />
                ) : (
                    <DataTable
                        data={filteredMembers}
                        columns={memberColumns}
                        getRowId={(m) => m.id}
                        emptyState={t('members.emptyMembers')}
                        resourceName={(p) => (p ? t('members.resourceMembers') : t('members.resourceMember'))}
                        data-testid="members-table"
                        selectionEnabled
                        selectedRows={Object.fromEntries(
                            Array.from(selectedMemberIds).map((id) => [id, true]),
                        )}
                        onRowSelectionChange={(rows) =>
                            setSelectedMemberIds(new Set(rows.map((r) => r.original.id)))
                        }
                        selectionControls={() => (
                            <BulkActionBar
                                actions={memberBulkActions}
                                onApply={handleBulkApply}
                                applying={bulkApplying}
                                selectedCount={selectedMemberIds.size}
                                entityLabel={t('members.resourceMembers')}
                            />
                        )}
                    />
                )}
            </div>

            {/* Pending Invites DataTable */}
            {invites.length > 0 && (
                <div>
                    <Heading level={2} className="mb-3">{t('members.pendingInvitationsTitle')}</Heading>
                    <div id="invites-table-card">
                        <DataTable
                            data={invites}
                            columns={inviteColumns}
                            getRowId={(i) => i.id}
                            emptyState={t('members.emptyInvites')}
                            resourceName={(p) => (p ? t('members.resourceInvites') : t('members.resourceInvite'))}
                            data-testid="invites-table"
                            selectionEnabled
                            selectedRows={Object.fromEntries(
                                Array.from(selectedInviteIds).map((id) => [id, true]),
                            )}
                            onRowSelectionChange={(rows) =>
                                setSelectedInviteIds(new Set(rows.map((r) => r.original.id)))
                            }
                            selectionControls={() => (
                                <BulkActionBar
                                    actions={inviteBulkActions}
                                    onApply={handleBulkRevokeInvites}
                                    applying={bulkRevokingInvites}
                                    selectedCount={selectedInviteIds.size}
                                    entityLabel={t('members.resourceInvites')}
                                />
                            )}
                        />
                    </div>
                </div>
            )}

            {/* Epic C.3 — sessions modal (Epic 54 Modal primitive) */}
            <Modal
                showModal={sessionsModalUser !== null}
                setShowModal={(open) => {
                    if (!open) closeSessionsModal();
                }}
                size="lg"
                title={sessionsModalUser
                    ? t('members.sessionsFor', { name: sessionsModalUser.user.name || sessionsModalUser.user.email })
                    : t('members.sessionsTitle')}
                description={t('members.sessionsDesc')}
            >
                <Modal.Header
                    title={sessionsModalUser
                        ? t('members.sessionsFor', { name: sessionsModalUser.user.name || sessionsModalUser.user.email })
                        : t('members.sessionsTitle')}
                    description={memberSessions.length === 0 && !sessionsLoading
                        ? t('members.sessionsHeaderEmpty')
                        : t('members.activeSessionsCount', { count: memberSessions.length })}
                />
                <Modal.Body>
                    {sessionsLoading ? (
                        <ul className="space-y-tight" aria-busy="true" aria-label={t('members.loadingSessionsAria')}>
                            {Array.from({ length: 3 }).map((_, i) => (
                                <li
                                    key={i}
                                    className="border border-border-subtle rounded-md p-3 flex items-start justify-between gap-compact"
                                >
                                    <div className="min-w-0 flex-1 space-y-tight">
                                        <Skeleton className="h-4 w-2/3" />
                                        <Skeleton className="h-3 w-1/2" />
                                    </div>
                                    <SkeletonButton className="h-6 w-16" />
                                </li>
                            ))}
                        </ul>
                    ) : memberSessions.length === 0 ? (
                        <EmptyState
                            icon={Monitor}
                            title={t('members.noActiveSessionsTitle')}
                            description={t('members.sessionsEmptyBody')}
                        />
                    ) : (
                        <ul className="space-y-tight" id="sessions-list">
                            {memberSessions.map((s) => (
                                <li
                                    key={s.sessionId}
                                    className="border border-border-subtle rounded-md p-3 flex items-start justify-between gap-compact"
                                    data-session-id={s.sessionId}
                                >
                                    <div className="min-w-0 flex-1">
                                        <p className="text-sm font-medium text-content-emphasis truncate">
                                            {s.userAgent || t('members.unknownDevice')}
                                        </p>
                                        <p className="text-xs text-content-muted mt-0.5">
                                            {t('members.sessionMeta', { ip: s.ipAddress || '—', date: formatDate(s.lastActiveAt) })}
                                        </p>
                                        <p className="text-[10px] text-content-subtle mt-0.5 font-mono break-all">
                                            {s.sessionId}
                                        </p>
                                    </div>
                                    <Button
                                        variant="secondary"
                                        size="xs"
                                        onClick={() => handleRevokeSession(s.sessionId)}
                                        disabled={revokingSessionId === s.sessionId}
                                        id={`revoke-session-${s.sessionId}`}
                                    >
                                        {revokingSessionId === s.sessionId ? t('members.revoking') : t('members.revoke')}
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                </Modal.Body>
            </Modal>
        </div>
    );
}
