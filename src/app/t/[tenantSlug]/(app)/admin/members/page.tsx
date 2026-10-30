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

import { formatDate } from '@inflect/ui/lib/format-date';
import { Card, cardVariants } from '@/components/ui/card';
import { useMemo, useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useTenantApiUrl, useTenantHref, usePermissions, useTenantContext } from '@/lib/tenant-context-provider';
import {
    CUSTOM_ROLE_ADMIN_BASE_REFUSAL,
    customRoleCarriageRefusal,
    customRoleCarriageRefusalOf,
    isOwnerManagedRole,
    mayCarryCustomRole,
} from '@/lib/roles';
import {
    Users, UserPlus, ChevronDown, Shield, XCircle,
    MoreVertical, UserMinus, Mail, Monitor, Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover } from '@/components/ui/popover';
import { BulkActionBar, type BulkActionDef } from '@/components/ui/bulk-action-bar';
import { StatusBadge, statusBadgeVariants } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
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
import { apiErrorMessage } from '@/lib/api-error';

// ─── Types ───

interface CustomRoleOption {
    id: string;
    name: string;
    baseRole: string;
    /**
     * The role's grant, as the list returns it. Read with its base by
     * `customRoleCarriageRefusal`: only an ADMIN membership carries a role
     * built on ADMIN or granting an admin-membership-only key (2026-10-30).
     */
    permissionsJson: unknown;
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
    /** #3675 — FIRST / SECOND / THIRD, or null for "not declared". */
    lineOfDefence?: LineOfDefence | null;
}

const LINES_OF_DEFENCE = ['FIRST', 'SECOND', 'THIRD'] as const;
type LineOfDefence = (typeof LINES_OF_DEFENCE)[number];
/** The option that stands for `null`: not declared, which satisfies no check. */
const UNDECLARED = 'UNDECLARED';

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
 * The roles the INVITE picker offers — a writer's list. AI_ADMIN (#3699) is
 * never offered here: nobody is invited straight into it, and the API refuses
 * it (`ASSIGNABLE_TENANT_ROLES`).
 */
const ROLES = ['ADMIN', 'EDITOR', 'AUDITOR', 'READER'] as const;
/**
 * What the role CHANGE picker adds for an OWNER (a holder of
 * `admin.owner_management`): an existing member may be moved into AI_ADMIN
 * (#3699 deploy 2). An ADMIN is not offered it, and the API refuses it to them
 * (`OWNER_MANAGED_ROLES`).
 */
const OWNER_ONLY_ROLE_CHANGE_ROLES = ['AI_ADMIN'] as const;
/**
 * Badge tone per role — a reader, so it names every role a row can carry,
 * AI_ADMIN included.
 */
const ROLE_VARIANT: Record<string, 'error' | 'info' | 'warning' | 'neutral'> = {
    ADMIN: 'error',
    EDITOR: 'info',
    AUDITOR: 'warning',
    READER: 'neutral',
    AI_ADMIN: 'info',
};
const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'error' | 'neutral'> = {
    ACTIVE: 'success',
    INVITED: 'warning',
    DEACTIVATED: 'error',
    REMOVED: 'neutral',
};

export default function MembersAdminPage() {
    const t = useTranslations('admin');
    const tRoles = useTranslations('roles');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    // A role's display label (`roles.*`), falling back to the raw value for one
    // the catalogue does not know rather than throwing.
    const roleLabel = useCallback(
        (role: string) => (tRoles.has(role) ? tRoles(role) : role),
        [tRoles],
    );
    const roleOptions: ComboboxOption[] = useMemo(
        () => ROLES.map((r) => ({ value: r, label: roleLabel(r) })),
        [roleLabel],
    );
    // Moving a member into or out of AI_ADMIN is an OWNER's change (#3699).
    const canManageOwnerRoles = usePermissions().admin.owner_management;
    // A member's line of defence (#3675, #3807) is set by an OWNER — the key
    // AND the built-in role, as `setMembershipLineOfDefence` asks — and never
    // on their own membership. The server refuses all three again.
    const { role: viewerRole, userId: viewerUserId } = useTenantContext();
    const canSetLineOfDefence = canManageOwnerRoles && viewerRole === 'OWNER';
    const lineOfDefenceOptions: ComboboxOption[] = useMemo(
        () =>
            [UNDECLARED, ...LINES_OF_DEFENCE].map((v) => ({
                value: v,
                label: t(`members.lineOfDefence.${v}`),
            })),
        [t],
    );
    const roleChangeOptions: ComboboxOption[] = useMemo(
        () =>
            [...ROLES, ...(canManageOwnerRoles ? OWNER_ONLY_ROLE_CHANGE_ROLES : [])].map((r) => ({
                value: r,
                label: roleLabel(r),
            })),
        [roleLabel, canManageOwnerRoles],
    );

    // ─── State ───
    const [members, setMembers] = useState<Member[]>([]);
    const [invites, setInvites] = useState<Invite[]>([]);
    const [loading, setLoading] = useState(true);
    // R14-PR7 — standalone search input retired. Member lists are
    // typically <50; users can scroll or navigate to a specific
    // member via the global command palette (⌘K).
    const [error, setError] = useState<string | null>(null);
    // The member list did not load: the server's reason, shown IN PLACE of the
    // table. Kept apart from `error` (an action's refusal) because an empty
    // table under a failed load reads as "this workspace has no members".
    const [loadError, setLoadError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    // Absolute invite link from the last "add member" — a share-anywhere
    // fallback so access never depends on the invite email arriving.
    const [inviteLink, setInviteLink] = useState<string | null>(null);
    // Whether the server says that invite was actually emailed. False when
    // no mailer is configured or the send failed — the link is then the
    // only way the invitee hears about it.
    const [inviteEmailed, setInviteEmailed] = useState(false);

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

    // Line of defence — the membership being saved, if any.
    const [savingLineId, setSavingLineId] = useState<string | null>(null);

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
                setLoadError(null);
            } else {
                const body = await membersRes.json().catch(() => null);
                setLoadError(apiErrorMessage(body, t('members.failedLoadMembers')));
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
            setLoadError(t('members.failedLoadMembers'));
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
        setInviteEmailed(false);
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
            // When they get access depends on how they sign in (src/auth.ts):
            // a Google or Microsoft sign-in with this email redeems the invite
            // by itself; any other sign-in redeems it only through the invite
            // link. The message says both, with the role's label.
            // Say "emailed" only when the server says it was: a deployment
            // with no mailer sends nothing, and the admin must share the link.
            const emailed = data?.emailSent === true;
            setInviteEmailed(emailed);
            const hintArgs = { email: inviteEmail, role: roleLabel(inviteRole) };
            setSuccess(
                emailed
                    ? t('members.memberAddedEmailed', hintArgs)
                    : t('members.memberAddedNotEmailed', hintArgs),
            );
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

    /**
     * A refused role or custom-role change, in the viewer's language. Only an
     * ADMIN membership carries a custom role built on ADMIN or granting an
     * admin-membership-only key (owner decision, 2026-10-30); that refusal names
     * keys, so it is re-said with the permission grid's labels. Any other
     * refusal is the server's own sentence.
     */
    function roleChangeError(body: unknown): string {
        const carriage = customRoleCarriageRefusalOf(body);
        if (carriage?.reason === CUSTOM_ROLE_ADMIN_BASE_REFUSAL) {
            return t('members.carriageRefusedBase', { base: roleLabel(carriage.baseRole ?? 'ADMIN') });
        }
        if (carriage) {
            const permissions = carriage.keys
                .map((key) =>
                    t('roles.permissionLabel', {
                        resource: t('resourceLabels.admin'),
                        action: t(`roles.actions.${key.slice('admin.'.length)}`),
                    }),
                )
                .join(', ');
            return t('members.carriageRefusedKeys', { permissions });
        }
        return apiErrorMessage(body, t('members.roleChangeFailed'));
    }

    /**
     * Clear the custom role of a member whose role carries none (OWNER, AI_ADMIN
     * — #3720, #3699). No writer can create that combination any more, so this
     * only ever repairs a legacy row; for an OWNER it needs `admin.owner_management`,
     * and only a viewer holding it can open that row's editor.
     */
    async function handleClearCustomRole(membershipId: string) {
        setError(null);
        setSuccess(null);
        setChangingRole(true);
        try {
            const res = await fetch(apiUrl(`/admin/members/${membershipId}`), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ customRoleId: null }),
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
                setError(roleChangeError(err));
                // The server applies a role and a custom role together or not
                // at all, but the row is re-read either way, so it never shows
                // a state the server does not hold.
                await fetchMembers();
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

    async function handleLineOfDefenceChange(member: Member, value: string) {
        const next: LineOfDefence | null = value === UNDECLARED ? null : (value as LineOfDefence);
        if (next === (member.lineOfDefence ?? null)) return;
        setError(null);
        setSuccess(null);
        setSavingLineId(member.id);
        try {
            const res = await fetch(apiUrl(`/admin/members/${member.id}/line-of-defence`), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ lineOfDefence: next }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => null);
                setError(apiErrorMessage(err, t('members.lineOfDefenceFailed')));
                return;
            }
            const body = (await res.json().catch(() => null)) as { independenceFindingIds?: string[] } | null;
            setMembers((ms) => ms.map((m) => (m.id === member.id ? { ...m, lineOfDefence: next } : m)));
            const findings = body?.independenceFindingIds?.length ?? 0;
            // A move off SECOND can break an auditor agent's independence; the
            // server raises a finding rather than refusing, so say so here.
            setSuccess(
                findings > 0
                    ? t('members.lineOfDefenceUpdatedWithFindings', { email: member.user.email, count: findings })
                    : t('members.lineOfDefenceUpdated', { email: member.user.email }),
            );
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setSavingLineId(null);
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
            // Its own sentence: the bar's default says the members are removed,
            // which is the other action.
            confirm: {
                tone: 'warning',
                confirmLabel: t('members.deactivate'),
                description: t('members.bulkDeactivateDescription'),
            },
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

    // Only an OWNER revokes an OWNER's or an AI_ADMIN's sessions, as only an
    // OWNER deactivates one (owner decision, 2026-10-25). One's own are one's own.
    const mayRevokeSessionsOf = (m: Member) =>
        canManageOwnerRoles || !isOwnerManagedRole(m.role) || m.userId === viewerUserId;

    // ─── Filter (R14-PR7 — search retired; full list shown) ───
    const filteredMembers = members;

    // Only an OWNER changes an OWNER's or an AI_ADMIN's role
    // (`OWNER_MANAGED_ROLES`), and neither membership takes a custom role
    // (#3720, #3699), so for anyone else there is nothing to edit on the row.
    // One rule for both ways into the editor — the role badge and the row
    // menu's "Change role" — so neither offers what the other refuses.
    const mayChangeRole = (m: Member) =>
        m.status === 'ACTIVE' && (canManageOwnerRoles || !isOwnerManagedRole(m.role));

    // Seed the editor from the member's CURRENT role and custom role. A
    // leftover pending custom role is either another member's or null, and
    // Save sends any difference — so it would assign the wrong one or clear
    // the member's own.
    const openRoleEditor = (m: Member) => {
        setEditingRoleId(m.id);
        setPendingRole(m.role);
        setPendingCustomRoleId(m.customRoleId);
    };

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
                    // An OWNER or an AI_ADMIN carries no custom role (#3720,
                    // #3699): its scope is always the built-in one. A member who
                    // has one is not promoted until it is removed and saved on
                    // its own.
                    const builtInScopeOnly = !mayCarryCustomRole(pendingRole);
                    const customRoleBlocksPromotion = builtInScopeOnly && Boolean(m.customRoleId);
                    // A row that ALREADY holds such a role with a custom role
                    // predates the rule. The only change it takes is the clear.
                    const legacyCustomRole =
                        !mayCarryCustomRole(m.role) && Boolean(m.customRoleId) && pendingRole === m.role;
                    // Only an ADMIN membership carries a custom role built on
                    // ADMIN or granting an admin-membership-only key (owner
                    // decision, 2026-10-30), asked as the server asks it: what
                    // the change ADDS to what the member carries now, so a
                    // legacy row is never held back from a change that adds
                    // nothing.
                    const shapeOf = (id: string | null) =>
                        (id ? customRoles.find((cr) => cr.id === id) : undefined) ?? null;
                    const carriageRefused = (role: string, customRoleId: string | null) =>
                        customRoleCarriageRefusal(
                            { membershipRole: role, customRole: shapeOf(customRoleId) },
                            { membershipRole: m.role, customRole: shapeOf(m.customRoleId) },
                        ) !== null;
                    const pendingBreaksCarriage =
                        !builtInScopeOnly && carriageRefused(pendingRole, pendingCustomRoleId);
                    if (editingRoleId === m.id) {
                        return (
                            <div className="space-y-1">
                                <div className="flex items-center gap-1">
                                    <Combobox
                                        hideSearch
                                        id={`role-select-${m.id}`}
                                        selected={roleChangeOptions.find(o => o.value === pendingRole) ?? null}
                                        setSelected={(opt) => {
                                            const next = opt?.value ?? pendingRole;
                                            setPendingRole(next);
                                            // Never send a custom role beside a role that carries none.
                                            if (!mayCarryCustomRole(next)) setPendingCustomRoleId(m.customRoleId);
                                        }}
                                        options={roleChangeOptions}
                                        matchTriggerWidth
                                        buttonProps={{ className: 'text-xs py-1 px-2 w-full sm:w-28' }}
                                    />
                                    <Button
                                        variant="secondary"
                                        size="xs"
                                        onClick={() => handleRoleChange(m.id)}
                                        disabled={changingRole || customRoleBlocksPromotion || pendingBreaksCarriage}
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
                                        id={`role-cancel-${m.id}`}
                                        aria-label={t('members.cancelRoleChange')}
                                    />
                                </div>
                                {customRoleBlocksPromotion && !legacyCustomRole && (
                                    <p id={`role-custom-role-conflict-${m.id}`} className="text-xs text-content-warning">
                                        {t('members.builtInScopeNoCustomRole', { role: roleLabel(pendingRole) })}
                                    </p>
                                )}
                                {legacyCustomRole && (
                                    <div className="flex items-center gap-1 flex-wrap">
                                        <p id={`role-legacy-custom-role-${m.id}`} className="text-xs text-content-warning">
                                            {t('members.legacyCustomRoleOnBuiltInScope', { role: roleLabel(m.role) })}
                                        </p>
                                        <Button
                                            variant="secondary"
                                            size="xs"
                                            onClick={() => handleClearCustomRole(m.id)}
                                            disabled={changingRole}
                                            id={`role-remove-custom-role-${m.id}`}
                                        >
                                            {t('members.removeCustomRole')}
                                        </Button>
                                    </div>
                                )}
                                {pendingBreaksCarriage && (
                                    <p id={`role-custom-role-admin-only-${m.id}`} className="text-xs text-content-warning">
                                        {t('members.customRoleNeedsAdminMembership', {
                                            customRole: shapeOf(pendingCustomRoleId)?.name ?? '',
                                        })}
                                    </p>
                                )}
                                {customRoles.length > 0 && !builtInScopeOnly && (
                                    <Combobox
                                        hideSearch
                                        id={`custom-role-select-${m.id}`}
                                        selected={customRoles.map(cr => ({ value: cr.id, label: cr.name })).find(o => o.value === (pendingCustomRoleId ?? '')) ?? null}
                                        setSelected={(opt) => setPendingCustomRoleId(opt?.value || null)}
                                        options={customRoles.map((cr) => ({
                                            value: cr.id,
                                            label: cr.name,
                                            // Offered, but not choosable, with the reason.
                                            ...(carriageRefused(pendingRole, cr.id)
                                                ? { disabledTooltip: t('members.customRoleAdminMembershipOnly') }
                                                : {}),
                                        }))}
                                        placeholder={t('members.customRolePlaceholder')}
                                        matchTriggerWidth
                                        buttonProps={{ className: 'text-xs py-1 px-2 w-full sm:w-48' }}
                                    />
                                )}
                            </div>
                        );
                    }
                    const editable = mayChangeRole(m);
                    return (
                        <div className="flex items-center gap-1 flex-wrap">
                            <Tooltip
                                content={
                                    m.status === 'ACTIVE' && !editable
                                        ? t('members.ownerOnlyRoleChange', { role: roleLabel(m.role) })
                                        : t('members.clickToChangeRole')
                                }
                                disabled={m.status !== 'ACTIVE'}
                            >
                                <button
                                    type="button"
                                    className={cn(
                                        statusBadgeVariants({ variant: ROLE_VARIANT[m.role] || 'neutral' }),
                                        editable ? 'cursor-pointer hover:opacity-80 transition' : 'cursor-default',
                                    )}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        if (editable) openRoleEditor(m);
                                    }}
                                    aria-disabled={!editable || undefined}
                                    id={`role-badge-${m.id}`}
                                >
                                    {roleLabel(m.role)}
                                    {editable && <ChevronDown className="w-3.5 h-3.5 ml-0.5" />}
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
                id: 'lineOfDefence',
                header: t('members.colLineOfDefence'),
                accessorFn: (m) => m.lineOfDefence ?? UNDECLARED,
                cell: ({ row }) => {
                    const m = row.original;
                    const current = m.lineOfDefence ?? UNDECLARED;
                    if (canSetLineOfDefence && m.userId !== viewerUserId) {
                        return (
                            <Combobox
                                hideSearch
                                id={`lod-select-${m.id}`}
                                selected={lineOfDefenceOptions.find((o) => o.value === current) ?? null}
                                setSelected={(opt) => {
                                    if (opt) void handleLineOfDefenceChange(m, opt.value);
                                }}
                                options={lineOfDefenceOptions}
                                matchTriggerWidth
                                disabled={savingLineId !== null}
                                buttonProps={{ className: 'text-xs py-1 px-2 w-full sm:w-32' }}
                            />
                        );
                    }
                    return (
                        <span id={`lod-${m.id}`} className="text-xs text-content-muted">
                            {t(`members.lineOfDefence.${current}`)}
                        </span>
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
                    // Only an OWNER deactivates or removes an OWNER or an
                    // AI_ADMIN (`OWNER_MANAGED_ROLES`), and nobody ends their
                    // own membership. The server refuses all three, so none is
                    // offered.
                    const mayEndMembership =
                        m.userId !== viewerUserId && (canManageOwnerRoles || !isOwnerManagedRole(m.role));
                    // A menu with nothing in it is not rendered at all.
                    const hasActions = isActive || mayEndMembership;
                    if (!hasActions) return null;
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
                                                {mayChangeRole(m) && (
                                                    <Popover.Item
                                                        icon={<Shield className="w-3.5 h-3.5" />}
                                                        onClick={() => {
                                                            openRoleEditor(m);
                                                            setOpenMenuId(null);
                                                        }}
                                                        id={`action-change-role-${m.id}`}
                                                    >
                                                        {t('members.changeRole')}
                                                    </Popover.Item>
                                                )}
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
                                                {mayEndMembership && (
                                                    <Popover.Item
                                                        icon={<UserMinus className="w-3.5 h-3.5" />}
                                                        destructive
                                                        onClick={() => handleDeactivate(m.id, m.user.email)}
                                                        id={`action-deactivate-${m.id}`}
                                                    >
                                                        {t('members.deactivate')}
                                                    </Popover.Item>
                                                )}
                                            </>
                                        )}
                                        {mayEndMembership && (
                                            <Popover.Item
                                                icon={<Trash2 className="w-3.5 h-3.5" />}
                                                destructive
                                                onClick={() => handleRemove(m.id, m.user.email)}
                                                id={`action-remove-${m.id}`}
                                            >
                                                {t('members.remove')}
                                            </Popover.Item>
                                        )}
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
        [editingRoleId, pendingRole, pendingCustomRoleId, changingRole, customRoles, openMenuId, t, roleLabel, roleChangeOptions, canManageOwnerRoles, canSetLineOfDefence, viewerUserId, lineOfDefenceOptions, savingLineId, members],
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
                        {roleLabel(row.original.role)}
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
        [t, roleLabel],
    );

    // The back link and breadcrumb, in every state — they rendered only while
    // the page was loading.
    const pageNav = (
        <>
            <BackAffordance />
            <PageBreadcrumbs
                items={[
                    { label: t('crumb.dashboard'), href: tenantHref('/dashboard') },
                    { label: t('crumb.admin'), href: tenantHref('/admin') },
                    { label: t('members.crumbSelf') },
                ]}
                className="mb-1"
            />
        </>
    );

    // ─── Loading state ───
    if (loading) {
        return (
            <div className="space-y-section animate-fadeIn">
                {pageNav}
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
            {pageNav}
            {/* Header */}
            <div className="flex items-center justify-between flex-wrap gap-default">
                <div>
                    <Heading level={1} className="flex items-center gap-tight">
                        <Users className="w-6 h-6 text-[var(--brand-default)]" />
                        {t('members.title')}
                    </Heading>
                    {/* No count over a list that did not load: "0 active
                        members" would be a claim the page cannot make. */}
                    {!loadError && (
                        <p className="text-sm text-content-muted mt-1">
                            {t('members.activeMembers', { count: members.filter(m => m.status === 'ACTIVE').length })}
                            {invites.length > 0 && ` · ${t('members.pendingInvites', { count: invites.length })}`}
                        </p>
                    )}
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
                                    {inviteEmailed
                                        ? t('members.inviteLinkLabel')
                                        : t('members.inviteLinkLabelNotEmailed')}
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
                                selected={roleOptions.find(o => o.value === inviteRole) ?? null}
                                setSelected={(opt) => setInviteRole(opt?.value ?? 'READER')}
                                options={roleOptions}
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
                {loadError ? (
                    // A failed load is never "No members yet": the list is
                    // unknown, and the server's reason says why.
                    <ErrorState
                        title={t('members.failedLoadMembers')}
                        description={loadError !== t('members.failedLoadMembers') ? loadError : undefined}
                        onRetry={() => { void fetchMembers(); }}
                        data-testid="members-load-error"
                    />
                ) : filteredMembers.length === 0 ? (
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
                        <>
                        {sessionsModalUser && !mayRevokeSessionsOf(sessionsModalUser) && (
                            <p className="text-xs text-content-muted mb-2" id="sessions-owner-only">
                                {t('members.sessionsOwnerOnly')}
                            </p>
                        )}
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
                                    {sessionsModalUser && mayRevokeSessionsOf(sessionsModalUser) && (
                                        <Button
                                            variant="secondary"
                                            size="xs"
                                            onClick={() => handleRevokeSession(s.sessionId)}
                                            disabled={revokingSessionId === s.sessionId}
                                            id={`revoke-session-${s.sessionId}`}
                                        >
                                            {revokingSessionId === s.sessionId ? t('members.revoking') : t('members.revoke')}
                                        </Button>
                                    )}
                                </li>
                            ))}
                        </ul>
                        </>
                    )}
                </Modal.Body>
            </Modal>
        </div>
    );
}
