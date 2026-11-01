'use client';

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ScrollText } from 'lucide-react';

import { ListPageShell } from '@/components/layout/ListPageShell';
import { DataTable, createColumns, TableEmptyState } from '@/components/ui/table';
import { StatusBadge } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { formatDateTime } from '@inflect/ui/lib/format-date';
import { Heading } from '@/components/ui/typography';

interface UserRef {
    id: string;
    email: string | null;
    name: string | null;
}

/** Every `OrgAuditAction` the log stores (#4849): the page knew five. */
export const ORG_AUDIT_ACTIONS = [
    'ORG_MEMBER_ADDED',
    'ORG_MEMBER_REMOVED',
    'ORG_MEMBER_ROLE_CHANGED',
    'ORG_ADMIN_PROVISIONED_TO_TENANTS',
    'ORG_ADMIN_DEPROVISIONED_FROM_TENANTS',
    'ORG_INVITE_CREATED',
    'ORG_INVITE_REDEEMED',
    'ORG_INVITE_REVOKED',
    'ORG_THREAT_LEVEL_SET',
    'ORG_MATURITY_RATING_SET',
    'ORG_INITIATIVE_CREATED',
    'ORG_INITIATIVE_STATUS_CHANGED',
    'ORG_AUTHZ_DENIED',
    'ORG_TENANT_DELETED',
    'ORG_AGENT_SWITCHES_CHANGED',
] as const;

export type OrgAuditActionValue = (typeof ORG_AUDIT_ACTIONS)[number];

interface AuditRow {
    id: string;
    occurredAt: string;
    /** A value this build does not know still renders, as "Other event". */
    action: string;
    actorType: string;
    actor: UserRef | null;
    target: UserRef | null;
    detailsJson: unknown;
    requestId: string | null;
    entryHash: string;
    previousHash: string | null;
    version: number;
}

interface Props {
    orgSlug: string;
    initialRows: AuditRow[];
    initialNextCursor: string | null;
}

const ACTION_LABEL_KEY: Record<OrgAuditActionValue, string> = {
    ORG_MEMBER_ADDED: 'audit.actionMemberAdded',
    ORG_MEMBER_REMOVED: 'audit.actionMemberRemoved',
    ORG_MEMBER_ROLE_CHANGED: 'audit.actionRoleChanged',
    ORG_ADMIN_PROVISIONED_TO_TENANTS: 'audit.actionProvisioned',
    ORG_ADMIN_DEPROVISIONED_FROM_TENANTS: 'audit.actionDeprovisioned',
    ORG_INVITE_CREATED: 'audit.actionInviteCreated',
    ORG_INVITE_REDEEMED: 'audit.actionInviteRedeemed',
    ORG_INVITE_REVOKED: 'audit.actionInviteRevoked',
    ORG_THREAT_LEVEL_SET: 'audit.actionThreatLevelSet',
    ORG_MATURITY_RATING_SET: 'audit.actionMaturityRated',
    ORG_INITIATIVE_CREATED: 'audit.actionInitiativeCreated',
    ORG_INITIATIVE_STATUS_CHANGED: 'audit.actionInitiativeStatusChanged',
    ORG_AUTHZ_DENIED: 'audit.actionAccessRefused',
    ORG_TENANT_DELETED: 'audit.actionWorkspaceDeleted',
    ORG_AGENT_SWITCHES_CHANGED: 'audit.actionAgentSwitchesChanged',
};

type OrgTranslate = ReturnType<typeof useTranslations>;

const ACTION_VARIANT: Record<OrgAuditActionValue, 'success' | 'error' | 'info' | 'warning' | 'neutral'> = {
    ORG_MEMBER_ADDED: 'success',
    ORG_MEMBER_REMOVED: 'error',
    ORG_MEMBER_ROLE_CHANGED: 'warning',
    ORG_ADMIN_PROVISIONED_TO_TENANTS: 'info',
    ORG_ADMIN_DEPROVISIONED_FROM_TENANTS: 'info',
    ORG_INVITE_CREATED: 'info',
    ORG_INVITE_REDEEMED: 'success',
    ORG_INVITE_REVOKED: 'warning',
    ORG_THREAT_LEVEL_SET: 'info',
    ORG_MATURITY_RATING_SET: 'info',
    ORG_INITIATIVE_CREATED: 'success',
    ORG_INITIATIVE_STATUS_CHANGED: 'info',
    ORG_AUTHZ_DENIED: 'error',
    ORG_TENANT_DELETED: 'error',
    ORG_AGENT_SWITCHES_CHANGED: 'warning',
};

function isKnownAction(action: string): action is OrgAuditActionValue {
    return (ORG_AUDIT_ACTIONS as readonly string[]).includes(action);
}

/** Organization roles as words: a stored ORG_ADMIN is "Org admin". */
const ORG_ROLE_LABEL_KEY: Record<string, string> = {
    ORG_OWNER: 'members.roleOrgOwner',
    ORG_ADMIN: 'members.roleOrgAdmin',
    ORG_READER: 'members.roleOrgReader',
};
/** Workspace roles the provisioning fan-out writes. */
const WORKSPACE_ROLE_LABEL_KEY: Record<string, string> = {
    OWNER: 'audit.workspaceRole.OWNER',
    ADMIN: 'audit.workspaceRole.ADMIN',
    AUDITOR: 'audit.workspaceRole.AUDITOR',
};
const THREAT_TIER_KEY: Record<string, string> = {
    GUARDED: 'widgets.tierGuarded',
    LOW: 'widgets.tierLow',
    ELEVATED: 'widgets.tierElevated',
    HIGH: 'widgets.tierHigh',
    SEVERE: 'widgets.tierSevere',
};
const MATURITY_LEVEL_KEY: Record<string, string> = {
    INITIAL: 'widgets.levelInitial',
    REPEATABLE: 'widgets.levelRepeatable',
    DEFINED: 'widgets.levelDefined',
    MANAGED: 'widgets.levelManaged',
    OPTIMIZING: 'widgets.levelOptimizing',
};
const MATURITY_DOMAIN_KEY: Record<string, string> = {
    GOVERN: 'widgets.domainGovern',
    IDENTIFY: 'widgets.domainIdentify',
    PROTECT: 'widgets.domainProtect',
    DETECT: 'widgets.domainDetect',
    RESPOND: 'widgets.domainRespond',
    RECOVER: 'widgets.domainRecover',
};
const INITIATIVE_STATUS_KEY: Record<string, string> = {
    PLANNED: 'widgets.statusPlanned',
    IN_PROGRESS: 'widgets.statusInProgress',
    BLOCKED: 'widgets.statusBlocked',
    COMPLETED: 'widgets.statusCompleted',
    CANCELLED: 'widgets.statusCancelled',
};
const AGENT_SWITCH_LABEL_KEY: Record<string, string> = {
    agentProfiles: 'settings.agentSwitches.agentProfiles.label',
    toolRunner: 'settings.agentSwitches.toolRunner.label',
};

/**
 * A stored value as words, through `keys`. A value this build has no word for
 * is shown as stored rather than dropped: the log is a record, and a blank
 * would hide what it says.
 */
function word(t: OrgTranslate, keys: Record<string, string>, value: unknown): string {
    const v = typeof value === 'string' ? value : '';
    if (!v) return '—';
    return keys[v] ? t(keys[v]) : v;
}

/**
 * Defensive renderer — strips PII ciphertext envelopes that may leak
 * through if the read-side decryption fails. Same pattern as
 * `user-combobox.tsx::isCiphertextEnvelope` (PR #82).
 */
function readableField(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('v1:') || trimmed.startsWith('v2:')) return null;
    return trimmed;
}

function userLabel(t: OrgTranslate, u: UserRef | null): string {
    if (!u) return '—';
    const name = readableField(u.name);
    const email = readableField(u.email);
    if (name && email) return `${name} (${email})`;
    if (name) return name;
    if (email) return email;
    return t('audit.userFallback', { id: u.id.slice(0, 8) });
}

function onOff(t: OrgTranslate, value: unknown): string {
    return value === true ? t('audit.switchOn') : value === false ? t('audit.switchOff') : '—';
}

/**
 * Compact, human-readable summary of the row's `detailsJson`, for every
 * action the log stores (#4849). Each action shape carries different fields —
 * the details payload is authoritative; this is just a glance-friendly
 * projection, with stored role, level and status values put into words.
 */
export function summarize(t: OrgTranslate, row: AuditRow): string {
    const d = row.detailsJson as Record<string, unknown> | null;
    if (!d) return '';
    switch (row.action) {
        case 'ORG_MEMBER_ADDED':
            return t('audit.roleSummary', { role: word(t, ORG_ROLE_LABEL_KEY, d.role) }) +
                (typeof d.provisionedTenantCount === 'number' && d.provisionedTenantCount > 0
                    ? t('audit.provisionedSuffix', { count: d.provisionedTenantCount })
                    : '');
        case 'ORG_MEMBER_REMOVED':
            return t('audit.wasSummary', { role: word(t, ORG_ROLE_LABEL_KEY, d.previousRole) }) +
                (typeof d.deprovisionedTenantCount === 'number' && d.deprovisionedTenantCount > 0
                    ? t('audit.deprovisionedSuffix', { count: d.deprovisionedTenantCount })
                    : '');
        case 'ORG_MEMBER_ROLE_CHANGED':
            return `${word(t, ORG_ROLE_LABEL_KEY, d.previousRole)} → ${word(t, ORG_ROLE_LABEL_KEY, d.newRole)}`;
        case 'ORG_ADMIN_PROVISIONED_TO_TENANTS':
        case 'ORG_ADMIN_DEPROVISIONED_FROM_TENANTS':
            return typeof d.tenantCount === 'number'
                ? t('audit.tenantCountSummary', {
                      count: d.tenantCount,
                      role: word(t, WORKSPACE_ROLE_LABEL_KEY, d.role ?? 'ADMIN'),
                  })
                : '';
        case 'ORG_INVITE_CREATED':
        case 'ORG_INVITE_REVOKED':
            return t('audit.inviteSummary', {
                email: readableField(typeof d.email === 'string' ? d.email : null) ?? '—',
                role: word(t, ORG_ROLE_LABEL_KEY, d.role),
            });
        case 'ORG_INVITE_REDEEMED':
            return t('audit.joinedAsSummary', { role: word(t, ORG_ROLE_LABEL_KEY, d.role) });
        case 'ORG_THREAT_LEVEL_SET':
            return t('audit.levelSummary', { level: word(t, THREAT_TIER_KEY, d.level) });
        case 'ORG_MATURITY_RATING_SET':
            return `${word(t, MATURITY_DOMAIN_KEY, d.domain)}: ${word(t, MATURITY_LEVEL_KEY, d.level)}`;
        case 'ORG_INITIATIVE_CREATED':
            return typeof d.title === 'string' ? d.title : '';
        case 'ORG_INITIATIVE_STATUS_CHANGED':
            return `${word(t, INITIATIVE_STATUS_KEY, d.from)} → ${word(t, INITIATIVE_STATUS_KEY, d.to)}`;
        case 'ORG_AUTHZ_DENIED':
            if (d.reason === 'OWNER_MEMBERSHIP_NEEDS_OWNER') return t('audit.deniedOwnerMembership');
            return typeof d.path === 'string'
                ? t('audit.deniedRequestSummary', {
                      role: word(t, ORG_ROLE_LABEL_KEY, d.orgRole),
                      request: `${typeof d.method === 'string' ? d.method : ''} ${d.path}`.trim(),
                  })
                : '';
        case 'ORG_TENANT_DELETED':
            return t('audit.workspaceDeletedSummary', {
                name: typeof d.name === 'string' ? d.name : '—',
                slug: typeof d.slug === 'string' ? d.slug : '—',
                count: typeof d.revokedMemberships === 'number' ? d.revokedMemberships : 0,
            });
        case 'ORG_AGENT_SWITCHES_CHANGED': {
            const changes = (d.changes ?? {}) as Record<string, { before?: unknown; after?: unknown }>;
            return Object.entries(changes)
                .map(([key, c]) => `${word(t, AGENT_SWITCH_LABEL_KEY, key)}: ${onOff(t, c?.before)} → ${onOff(t, c?.after)}`)
                .join('; ');
        }
        default:
            return '';
    }
}

export function AuditLogTable({ orgSlug, initialRows, initialNextCursor }: Props) {
    const t = useTranslations('org');
    const [rows, setRows] = useState<AuditRow[]>(initialRows);
    const [cursor, setCursor] = useState<string | null>(initialNextCursor);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // The action filter (#4849). The API took `action` all along; the page
    // offered no way to pass it. Empty is every action.
    const [action, setAction] = useState<OrgAuditActionValue | ''>('');

    const actionOptions = useMemo<ComboboxOption[]>(
        () => [
            { value: '', label: t('audit.allActions') },
            ...ORG_AUDIT_ACTIONS.map((a) => ({ value: a, label: t(ACTION_LABEL_KEY[a]) })),
        ],
        [t],
    );

    /** One page of entries; `from` is the cursor to continue from, or none. */
    const fetchPage = useCallback(
        async (forAction: OrgAuditActionValue | '', from: string | null) => {
            const params = new URLSearchParams({ limit: '20' });
            if (from) params.set('cursor', from);
            if (forAction) params.set('action', forAction);
            const res = await fetch(`/api/org/${orgSlug}/audit-log?${params.toString()}`);
            if (!res.ok) throw new Error('fetch failed');
            return (await res.json()) as { rows: AuditRow[]; nextCursor: string | null };
        },
        [orgSlug],
    );

    const loadMore = useCallback(async () => {
        if (!cursor || loading) return;
        setLoading(true);
        setError(null);
        try {
            const data = await fetchPage(action, cursor);
            setRows((prev) => [...prev, ...data.rows]);
            setCursor(data.nextCursor);
        } catch {
            // Never the HTTP status or a JavaScript message: neither is
            // something a person can act on.
            setError(t('audit.fetchFailed'));
        } finally {
            setLoading(false);
        }
    }, [action, cursor, loading, fetchPage, t]);

    const chooseAction = useCallback(
        async (next: OrgAuditActionValue | '') => {
            setAction(next);
            setLoading(true);
            setError(null);
            try {
                const data = await fetchPage(next, null);
                setRows(data.rows);
                setCursor(data.nextCursor);
            } catch {
                setError(t('audit.fetchFailed'));
            } finally {
                setLoading(false);
            }
        },
        [fetchPage, t],
    );

    const columns = useMemo(
        () =>
            createColumns<AuditRow>([
                {
                    id: 'occurredAt',
                    header: t('audit.colTime'),
                    cell: ({ row }) => (
                        <span
                            className="font-mono text-xs text-content-muted"
                            data-testid={`org-audit-time-${row.original.id}`}
                        >
                            {formatDateTime(row.original.occurredAt)}
                        </span>
                    ),
                },
                {
                    id: 'action',
                    header: t('audit.colAction'),
                    cell: ({ row }) => {
                        const a = row.original.action;
                        // An action a newer deploy wrote is named, never a
                        // missing translation key.
                        return isKnownAction(a) ? (
                            <StatusBadge variant={ACTION_VARIANT[a]}>{t(ACTION_LABEL_KEY[a])}</StatusBadge>
                        ) : (
                            <StatusBadge variant="neutral">{t('audit.actionOther')}</StatusBadge>
                        );
                    },
                },
                {
                    id: 'actor',
                    header: t('audit.colActor'),
                    cell: ({ row }) => (
                        <span className="text-sm text-content-default">
                            {userLabel(t, row.original.actor)}
                        </span>
                    ),
                },
                {
                    id: 'target',
                    header: t('audit.colTarget'),
                    cell: ({ row }) => (
                        <span className="text-sm text-content-default">
                            {userLabel(t, row.original.target)}
                        </span>
                    ),
                },
                {
                    id: 'summary',
                    header: t('audit.colSummary'),
                    cell: ({ row }) => (
                        <span className="text-sm text-content-muted">
                            {summarize(t, row.original)}
                        </span>
                    ),
                },
            ]),
        [t],
    );

    return (
        <ListPageShell>
            <ListPageShell.Header>
                <div className="flex items-start justify-between gap-default">
                    <div>
                        <Heading level={1} className="flex items-center gap-tight">
                            <ScrollText className="w-5 h-5" aria-hidden="true" />
                            {t('audit.title')}
                        </Heading>
                        <p className="text-sm text-content-muted mt-1">
                            {t('audit.subtitle')}
                        </p>
                    </div>
                    <div className="w-full sm:w-64">
                        <Combobox
                            hideSearch
                            id="org-audit-action-filter"
                            selected={actionOptions.find((o) => o.value === action) ?? null}
                            setSelected={(opt) => {
                                void chooseAction((opt?.value ?? '') as OrgAuditActionValue | '');
                            }}
                            options={actionOptions}
                            placeholder={t('audit.allActions')}
                            matchTriggerWidth
                            buttonProps={{ className: 'w-full', 'aria-label': t('audit.filterLabel') }}
                        />
                    </div>
                </div>
            </ListPageShell.Header>
            <ListPageShell.Body>
                {rows.length === 0 ? (
                    <TableEmptyState
                        title={action ? t('audit.emptyFilteredTitle') : t('audit.emptyTitle')}
                        description={action ? t('audit.emptyFilteredDesc') : t('audit.emptyDesc')}
                    />
                ) : (
                    <DataTable
                        fillBody
                        data={rows}
                        columns={columns}
                        getRowId={(r) => r.id}
                    />
                )}
                {error && (
                    <p
                        role="alert"
                        className="mt-3 text-sm text-status-error"
                        data-testid="org-audit-error"
                    >
                        {error}
                    </p>
                )}
                {cursor && (
                    <div className="mt-4 flex justify-center">
                        <Button
                            variant="secondary"
                            onClick={loadMore}
                            disabled={loading}
                            data-testid="org-audit-load-more"
                        >
                            {loading ? t('common.loading') : t('audit.loadOlder')}
                        </Button>
                    </div>
                )}
            </ListPageShell.Body>
        </ListPageShell>
    );
}
