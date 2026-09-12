'use client';

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { apiErrorMessage } from '@/lib/api-error';
import { Card, cardVariants } from '@/components/ui/card';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import {
    KeyRound, Trash2, Copy, Check,
    Clock, AlertTriangle, Eye, EyeOff,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons/nucleo';
import { Combobox, ComboboxOption } from '@/components/ui/combobox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InfoTooltip, Tooltip } from '@/components/ui/tooltip';
import { useCopyToClipboard } from '@/components/ui/hooks';
import { DataTable, createColumns } from '@/components/ui/table';
import { InlineNotice } from '@/components/ui/inline-notice';
import { formatDateTime } from '@/lib/format-date';
import { useToast } from '@/components/ui/hooks/use-toast';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { cn } from '@/lib/cn';

// ─── Types ───

interface ApiKeyRecord {
    id: string;
    name: string;
    keyPrefix: string;
    scopes: string[];
    expiresAt: string | null;
    revokedAt: string | null;
    lastUsedAt: string | null;
    lastUsedIp: string | null;
    createdById: string;
    createdAt: string;
    createdBy: { id: string; name: string | null; email: string };
    /**
     * THE BINDING (#2445, #2446). Present on the API since the agent register
     * shipped; this screen simply threw it away, which is why an operator had to
     * hold the MCP hub open beside this page to answer "which agent is this key?"
     * during an incident.
     *
     * `agentId === null` is the `no_binding` state — and under
     * `requireRegisteredAgent` it means the key is refused at the tool boundary,
     * not merely unlabelled.
     */
    agentId: string | null;
    maxAutonomyLevel: number | null;
    agent: { id: string; name: string; status: string; autonomyLevel: number } | null;
}

/** An agent this credential could be bound to, for the create form's selector. */
interface AgentOption {
    id: string;
    name: string;
    status: string;
    autonomyLevel: number;
}

interface CreatedKeyResponse extends ApiKeyRecord {
    plaintext: string;
}

// ─── Scope Categories for UI Grouping ───

// Operator-facing half of the API-key scope model, and still a hand-written
// mirror: the LABELS and the read/write/admin GROUPING are editorial and
// cannot be derived. The COVERAGE can be, and now is — for BOTH halves.
// tests/unit/api-key-management.test.ts asserts every PERMISSION_SCHEMA domain
// appears in SCOPE_ACTION_MAP *and* in this map, and that every scope string
// listed here is one validateScopes accepts. Until #2197 only the first of
// those existed, so a domain the auth layer accepted could still be a scope no
// operator could grant through the UI — which is how assets / incidents /
// personnel were unreachable before #2225.
const SCOPE_GROUPS: Record<string, { label: string; scopes: string[] }> = {
    controls:   { label: 'Controls',   scopes: ['controls:read', 'controls:write'] },
    evidence:   { label: 'Evidence',   scopes: ['evidence:read', 'evidence:write'] },
    policies:   { label: 'Policies',   scopes: ['policies:read', 'policies:write', 'policies:admin'] },
    tasks:      { label: 'Tasks',      scopes: ['tasks:read', 'tasks:write'] },
    risks:      { label: 'Risks',      scopes: ['risks:read', 'risks:write'] },
    assets:     { label: 'Assets',     scopes: ['assets:read', 'assets:write'] },
    incidents:  { label: 'Incidents',  scopes: ['incidents:read', 'incidents:admin'] },
    personnel:  { label: 'Personnel',  scopes: ['personnel:read', 'personnel:admin'] },
    // One scope each, and no `:read`: `continuity` / `processes` carry a
    // single `edit` action in PermissionSet, so SCOPE_ACTION_MAP gives them a
    // `write` group and nothing else. Listing `continuity:read` here would be
    // an operator-visible checkbox that validateScopes rejects.
    continuity: { label: 'Business continuity', scopes: ['continuity:write'] },
    processes:  { label: 'Processes',  scopes: ['processes:write'] },
    vendors:    { label: 'Vendors',    scopes: ['vendors:read', 'vendors:write'] },
    tests:      { label: 'Tests',      scopes: ['tests:read', 'tests:write'] },
    frameworks: { label: 'Frameworks', scopes: ['frameworks:read', 'frameworks:write'] },
    audits:     { label: 'Audits',     scopes: ['audits:read', 'audits:write'] },
    reports:    { label: 'Reports',    scopes: ['reports:read', 'reports:write'] },
    admin:      { label: 'Admin',      scopes: ['admin:read', 'admin:write'] },
};

const EXPIRY_OPTIONS = [
    { label: 'No expiry', value: '' },
    { label: '30 days', value: '30' },
    { label: '90 days', value: '90' },
    { label: '180 days', value: '180' },
    { label: '1 year', value: '365' },
];
const EXPIRY_CB_OPTIONS: ComboboxOption[] = EXPIRY_OPTIONS.filter(o => o.value).map(o => ({ value: o.value, label: o.label }));

/** The bindable agents, as Combobox options. */
const AGENT_CB_OPTIONS = (agents: AgentOption[]): ComboboxOption[] =>
    agents.map(a => ({ value: a.id, label: a.name }));

/**
 * The autonomy ceilings this credential may carry — CAPPED AT THE AGENT'S OWN
 * LEVEL, because a key can only ever NARROW what its agent may do.
 *
 * The usecase refuses a higher value, so offering one would be a form that
 * submits to a known refusal. Building the list from the agent instead means the
 * impossible choice is not on screen.
 */
const AUTONOMY_CB_OPTIONS = (agentLevel: number, noneLabel: string): ComboboxOption[] => [
    { value: '', label: noneLabel },
    ...Array.from({ length: agentLevel + 1 }, (_, level) => ({
        value: String(level),
        label: `L${level}`,
    })),
];

/**
 * What this credential acts as — the whole point of #2446.
 *
 * ONE component for both tables. The active and inactive lists are separate
 * column arrays, and a binding rendered twice is a binding that can come to mean
 * two different things; the incident-time question ("which agent is this key?")
 * must not have two answers depending on which table you are looking at.
 *
 * `no_binding` is stated as a CONSEQUENCE, not as an empty cell. Under
 * `requireRegisteredAgent` an unbound key is refused at the tool boundary, so
 * blankness here would read as "nothing to say" about the one property that
 * decides whether the credential works at all.
 */
function BindingCell({ record, muted }: { record: ApiKeyRecord; muted?: boolean }) {
    const t = useTranslations('admin');
    if (!record.agentId) {
        // Quiet text in the WARNING tone, not a badge. `badge-density` caps this
        // file at four, and the row's loud badge is its scope set — an unbound
        // credential is a fact about the row, not a second alarm competing with
        // it. The colour still carries the warning; only the chrome is dropped.
        return (
            <span className="text-content-warning">{t('apiKeys.noBinding')}</span>
        );
    }
    return (
        <div className="flex flex-wrap items-center gap-1">
            <span className={muted ? 'text-content-subtle' : 'text-content-default'}>
                {record.agent?.name ?? record.agentId}
            </span>
            {record.maxAutonomyLevel !== null && (
                <span className="text-content-subtle">
                    {t('apiKeys.autonomyCap', { level: record.maxAutonomyLevel })}
                </span>
            )}
        </div>
    );
}

function isExpired(expiresAt: string | null): boolean {
    if (!expiresAt) return false;
    return new Date(expiresAt) < new Date();
}

// ─── Scope Picker Component ───

function ScopePicker({
    selected,
    onChange,
}: {
    selected: string[];
    onChange: (scopes: string[]) => void;
}) {
    const t = useTranslations('admin');
    const isFullAccess = selected.includes('*');

    const toggleFullAccess = () => {
        if (isFullAccess) {
            onChange([]);
        } else {
            onChange(['*']);
        }
    };

    const toggleScope = (scope: string) => {
        if (isFullAccess) return;
        if (selected.includes(scope)) {
            onChange(selected.filter(s => s !== scope));
        } else {
            onChange([...selected, scope]);
        }
    };

    return (
        <div className="space-y-compact">
            <div className="flex items-center gap-tight">
                <button
                    type="button"
                    onClick={toggleFullAccess}
                    className={`text-xs px-3 py-1.5 rounded-md transition font-medium ${
                        isFullAccess
                            ? 'bg-bg-warning text-content-warning border border-border-warning'
                            : 'bg-bg-elevated/50 text-content-muted border border-border-emphasis/50 hover:border-border-emphasis'
                    }`}
                    id="scope-full-access"
                >
                    {t('apiKeys.fullAccess')}
                </button>
                <InfoTooltip
                    aria-label={t('apiKeys.fullAccessAria')}
                    iconClassName="h-3.5 w-3.5"
                    content={t('apiKeys.fullAccessTooltip')}
                />
                {isFullAccess && (
                    <span className="text-[10px] text-content-warning flex items-center gap-1">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        {t('apiKeys.grantsAll')}
                    </span>
                )}
            </div>

            {!isFullAccess && (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-tight">
                    {Object.entries(SCOPE_GROUPS).map(([, group]) => (
                        <div key={group.label} className="bg-bg-default/40 rounded-lg p-2 space-y-1">
                            <div className="text-[10px] text-content-subtle uppercase tracking-wider font-medium">
                                {group.label}
                            </div>
                            {group.scopes.map((scope) => {
                                const action = scope.split(':')[1];
                                const isSelected = selected.includes(scope);
                                return (
                                    <button
                                        key={scope}
                                        type="button"
                                        onClick={() => toggleScope(scope)}
                                        className={`
                                            w-full text-left text-[11px] px-2 py-1 rounded transition
                                            ${isSelected
                                                ? 'bg-[var(--brand-subtle)] text-[var(--brand-muted)] border border-[var(--brand-default)]/40'
                                                : 'bg-bg-elevated/30 text-content-muted border border-transparent hover:border-border-emphasis'
                                            }
                                        `}
                                        id={`scope-${scope.replace(':', '-')}`}
                                    >
                                        <span className="capitalize">{action}</span>
                                        {isSelected && <Check className="w-3.5 h-3.5 inline ml-1" />}
                                    </button>
                                );
                            })}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// ─── Copy-Once Key Display ───

export function KeyDisplay({ plaintext }: { plaintext: string }) {
    const t = useTranslations('admin');
    const [visible, setVisible] = useState(false);
    const { copy, copied } = useCopyToClipboard({ timeout: 2500 });
    const toast = useToast();

    const handleCopy = async () => {
        const ok = await copy(plaintext);
        if (ok) {
            toast.success(t('apiKeys.copyToast'));
        } else {
            toast.error(t('apiKeys.copyFailedToast'));
        }
    };

    return (
        <InlineNotice
            variant="warning"
            id="key-display"
            icon={AlertTriangle}
            title={t('apiKeys.copyWarning')}
            className="flex-col items-stretch space-y-tight p-4"
        >
            <div className="flex items-center gap-tight">
                <code className="flex-1 bg-bg-page px-3 py-2 rounded text-sm font-mono text-content-success select-all break-all">
                    {visible ? plaintext : plaintext.slice(0, 13) + '•'.repeat(40)}
                </code>
                <Tooltip content={visible ? t('apiKeys.hideKey') : t('apiKeys.showKey')}>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setVisible(!visible)}
                        aria-label={visible ? t('apiKeys.hideKey') : t('apiKeys.showKey')}
                        id="key-toggle-visibility"
                    >
                        {visible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </Button>
                </Tooltip>
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleCopy}
                    id="key-copy-btn"
                >
                    {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied ? t('apiKeys.copied') : t('apiKeys.copy')}
                </Button>
            </div>
        </InlineNotice>
    );
}

// ─── Main Page ───

export default function ApiKeysPage() {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();

    const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    // Create form
    const [showCreate, setShowCreate] = useState(false);
    const [createName, setCreateName] = useState('');
    const [createScopes, setCreateScopes] = useState<string[]>([]);
    const [createExpiry, setCreateExpiry] = useState('');
    const [createAgentId, setCreateAgentId] = useState('');
    const [createMaxAutonomy, setCreateMaxAutonomy] = useState('');
    const [creating, setCreating] = useState(false);
    /**
     * The bindable agents, and whether we were allowed to ask.
     *
     * This page is gated on `admin.manage`; the agent register is gated on
     * `admin.agent_registry`. They are not the same key and one does not imply
     * the other, so a legitimate admin can reach this form and be refused the
     * list. That is not an error to shout about — it is a narrower permission
     * doing its job — so the selector is REPLACED by a sentence explaining why
     * binding is unavailable, rather than rendering an empty dropdown that looks
     * like "this tenant has no agents".
     */
    const [agents, setAgents] = useState<AgentOption[]>([]);
    const [agentsRefused, setAgentsRefused] = useState(false);
    const [createdKey, setCreatedKey] = useState<CreatedKeyResponse | null>(null);
    // Pending revocation — drives the ConfirmDialog. Replaces the
    // previous window.confirm() call.
    const [keyToRevoke, setKeyToRevoke] = useState<ApiKeyRecord | null>(null);

    // ─── Data Fetching ───
    const fetchKeys = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/admin/api-keys'));
            if (res.ok) setKeys(await res.json());
        } catch {
            setError(t('apiKeys.loadFailed'));
        } finally {
            setLoading(false);
        }
    }, [apiUrl, t]);

    const fetchAgents = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/admin/agents?status=ACTIVE'));
            if (res.status === 403) { setAgentsRefused(true); return; }
            if (!res.ok) return;
            const body = await res.json();
            const rows: AgentOption[] = Array.isArray(body) ? body : (body.agents ?? []);
            setAgents(rows);
        } catch {
            // A failed probe means UNKNOWN, not "no agents". Leaving the list
            // empty without `agentsRefused` renders the selector with nothing in
            // it, which reads as a definite answer we do not have.
            setAgentsRefused(true);
        }
    }, [apiUrl]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchKeys(); }, [fetchKeys]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchAgents(); }, [fetchAgents]);

    // ─── Create ───
    async function handleCreate() {
        setError(null);
        setSuccess(null);
        setCreating(true);

        try {
            let expiresAt: string | null = null;
            if (createExpiry) {
                const date = new Date();
                date.setDate(date.getDate() + parseInt(createExpiry));
                expiresAt = date.toISOString();
            }

            const res = await fetch(apiUrl('/admin/api-keys'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: createName.trim(),
                    scopes: createScopes,
                    expiresAt,
                    // Both accepted by the API since the register shipped, and
                    // both omitted here until now — so every credential this
                    // product minted stood at `no_binding` and was refused the
                    // moment a tenant enforced registration.
                    agentId: createAgentId || null,
                    maxAutonomyLevel:
                        createAgentId && createMaxAutonomy !== ''
                            ? Number(createMaxAutonomy)
                            : null,
                }),
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: 'Create failed' }));
                setError(apiErrorMessage(err, t('apiKeys.createFailed')));
                return;
            }

            const result = await res.json();
            setCreatedKey(result);
            setSuccess(t('apiKeys.createdSuccess', { name: createName }));
            setCreateName('');
            setCreateScopes([]);
            setCreateExpiry('');
            setCreateAgentId('');
            setCreateMaxAutonomy('');
            setShowCreate(false);
            await fetchKeys();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setCreating(false);
        }
    }

    // ─── Revoke ───
    // The button in each row sets `keyToRevoke`; the actual delete
    // happens in the ConfirmDialog's `onConfirm` below.
    function handleRevoke(key: ApiKeyRecord) {
        setKeyToRevoke(key);
    }

    async function performRevoke(key: ApiKeyRecord) {
        setError(null);
        setSuccess(null);
        try {
            const res = await fetch(apiUrl(`/admin/api-keys/${key.id}`), { method: 'DELETE' });
            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: 'Revoke failed' }));
                setError(apiErrorMessage(err, t('apiKeys.revokeFailed')));
                throw new Error(err.error?.message || err.error || 'Revoke failed');
            }
            setSuccess(t('apiKeys.revokedSuccess', { name: key.name }));
            await fetchKeys();
        } catch (err) {
            setError((err as Error).message);
            throw err;
        }
    }

    // ─── Partition keys ───
    const activeKeys = keys.filter(k => !k.revokedAt && !isExpired(k.expiresAt));
    const inactiveKeys = keys.filter(k => k.revokedAt || isExpired(k.expiresAt));

    // ─── Epic 52 — DataTable columns ───
    const activeKeyColumns = useMemo(
        () =>
            createColumns<ApiKeyRecord>([
                {
                    accessorKey: 'name',
                    header: t('apiKeys.colName'),
                    cell: ({ row }) => (
                        <span className="text-sm font-medium text-content-emphasis">{row.original.name}</span>
                    ),
                },
                {
                    accessorKey: 'keyPrefix',
                    header: t('apiKeys.colKey'),
                    cell: ({ row }) => (
                        <code className="text-content-muted font-mono">{row.original.keyPrefix}...</code>
                    ),
                },
                {
                    accessorKey: 'agentId',
                    header: t('apiKeys.colBinding'),
                    cell: ({ row }) => <BindingCell record={row.original} />,
                },
                {
                    accessorKey: 'scopes',
                    header: t('apiKeys.colScopes'),
                    cell: ({ row }) => {
                        const scopes = row.original.scopes as string[];
                        return (
                            <div className="flex flex-wrap gap-1">
                                {scopes.slice(0, 3).map((s) => (
                                    <StatusBadge variant="info" size="sm" key={s}>{s}</StatusBadge>
                                ))}
                                {scopes.length > 3 && (
                                    <StatusBadge variant="neutral" size="sm">+{scopes.length - 3}</StatusBadge>
                                )}
                            </div>
                        );
                    },
                },
                {
                    accessorKey: 'expiresAt',
                    header: t('apiKeys.colExpires'),
                    cell: ({ row }) =>
                        row.original.expiresAt ? (
                            <span className="flex items-center gap-1 text-content-muted">
                                <Clock className="w-3.5 h-3.5" />
                                {formatDateTime(row.original.expiresAt)}
                            </span>
                        ) : (
                            <span className="text-content-subtle">{t('apiKeys.colNever')}</span>
                        ),
                },
                {
                    accessorKey: 'lastUsedAt',
                    header: t('apiKeys.colLastUsed'),
                    cell: ({ row }) => (
                        <span className="text-content-muted">{formatDateTime(row.original.lastUsedAt)}</span>
                    ),
                },
                {
                    accessorKey: 'createdAt',
                    header: t('apiKeys.colCreated'),
                    cell: ({ row }) => (
                        <span className="text-content-subtle">
                            {formatDateTime(row.original.createdAt)}
                            <br />
                            <span className="text-content-subtle">
                                {t('apiKeys.byCreator', { name: row.original.createdBy?.name || row.original.createdBy?.email || '—' })}
                            </span>
                        </span>
                    ),
                },
                {
                    id: 'actions',
                    header: () => <span className="sr-only">{t('apiKeys.colActions')}</span>,
                    cell: ({ row }) => (
                        <div className="text-right">
                            <Tooltip content={t('apiKeys.revokeAria')}>
                                <Button
                                    variant="destructive"
                                    size="xs"
                                    onClick={() => handleRevoke(row.original)}
                                    aria-label={t('apiKeys.revokeAria')}
                                    id={`revoke-key-${row.original.id}`}
                                >
                                    <Trash2 className="w-3.5 h-3.5" />
                                </Button>
                            </Tooltip>
                        </div>
                    ),
                },
            ]),
        // handleRevoke identity is stable within this component — but we
        // include it so an eslint-exhaustive-deps warning doesn't slip in
        // if someone refactors it into a useCallback later.

        [t],
    );

    const inactiveKeyColumns = useMemo(
        () =>
            createColumns<ApiKeyRecord>([
                {
                    accessorKey: 'name',
                    header: t('apiKeys.colName'),
                    cell: ({ row }) => (
                        <span className="text-sm text-content-muted line-through">{row.original.name}</span>
                    ),
                },
                {
                    accessorKey: 'keyPrefix',
                    header: t('apiKeys.colKey'),
                    cell: ({ row }) => (
                        <code className="text-content-subtle font-mono">{row.original.keyPrefix}...</code>
                    ),
                },
                {
                    accessorKey: 'agentId',
                    header: t('apiKeys.colBinding'),
                    cell: ({ row }) => <BindingCell record={row.original} muted />,
                },
                {
                    id: 'status',
                    header: t('apiKeys.colStatus'),
                    cell: ({ row }) =>
                        row.original.revokedAt ? (
                            <StatusBadge variant="error" size="sm">{t('apiKeys.revoked')}</StatusBadge>
                        ) : (
                            <StatusBadge variant="warning" size="sm">{t('apiKeys.expired')}</StatusBadge>
                        ),
                },
                {
                    accessorKey: 'createdAt',
                    header: t('apiKeys.colCreated'),
                    cell: ({ row }) => (
                        <span className="text-content-subtle">{formatDateTime(row.original.createdAt)}</span>
                    ),
                },
            ]),
        [t],
    );

    if (loading) {
        return (
            <div className="space-y-section animate-fadeIn">
                <Heading level={2} className="flex items-center gap-tight">
                    <KeyRound className="w-6 h-6 text-[var(--brand-default)]" />
                    Loading API keys…
                </Heading>
                <Card className="space-y-default">
                    <div className="h-4 bg-bg-elevated/60 rounded w-1/3 animate-pulse" />
                    <div className="h-4 bg-bg-elevated/60 rounded w-2/3 animate-pulse" />
                </Card>
            </div>
        );
    }

    return (
        <div className="space-y-section animate-fadeIn">
            {/* Header */}
            <div className="flex items-center justify-between flex-wrap gap-default">
                <div>
                    <PageBreadcrumbs
                        items={[
                            { label: t('crumb.dashboard'), href: tenantHref('/dashboard') },
                            { label: t('crumb.admin'), href: tenantHref('/admin') },
                            { label: t('crumb.apiKeys') },
                        ]}
                        className="mb-1"
                    />
                    <BackAffordance />
                    <Heading level={1} className="flex items-center gap-tight">
                        <KeyRound className="w-6 h-6 text-[var(--brand-default)]" />
                        {t('apiKeys.pageTitle')}
                    </Heading>
                    <p className="text-sm text-content-muted mt-1">
                        {t('apiKeys.pageDescription')}
                    </p>
                </div>
                {!showCreate && !createdKey && (
                    <Button variant="primary" icon={<Plus className="-ml-0.5 -mr-2.5" />} onClick={() => setShowCreate(true)} id="create-api-key-btn">
                        {t('apiKeys.headerButton')}
                    </Button>
                )}
            </div>

            {/* Messages */}
            {error && (
                <InlineNotice
                    variant="error"
                    id="api-keys-error"
                    onDismiss={() => setError(null)}
                >
                    {error}
                </InlineNotice>
            )}
            {success && (
                <InlineNotice
                    variant="success"
                    id="api-keys-success"
                    onDismiss={() => setSuccess(null)}
                >
                    {success}
                </InlineNotice>
            )}

            {/* Created Key Display (show once) */}
            {createdKey && (
                <div className="space-y-tight">
                    <KeyDisplay plaintext={createdKey.plaintext} />
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setCreatedKey(null)}
                        id="dismiss-key-display"
                    >
                        {t('apiKeys.dismissKey')}
                    </Button>
                </div>
            )}

            {/* Create Form */}
            {showCreate && (
                <div className={cn(cardVariants(), 'border border-[var(--brand-default)]/30 space-y-default')} id="create-key-form">
                    <Heading level={3}>{t('apiKeys.createTitle')}</Heading>

                    <div>
                        <label className="text-xs text-content-muted uppercase tracking-wider mb-1 block">{t('apiKeys.nameLabel')}</label>
                        <input
                            type="text" value={createName} onChange={(e) => setCreateName(e.target.value)}
                            placeholder={t('apiKeys.namePlaceholder')}
                            className="input w-full" maxLength={100} id="key-name-input"
                        />
                    </div>

                    <div>
                        <div className="mb-1 flex items-center gap-1.5">
                            <label className="text-xs text-content-muted uppercase tracking-wider">{t('apiKeys.expiryLabel')}</label>
                            <InfoTooltip
                                aria-label={t('apiKeys.expiryAria')}
                                iconClassName="h-3.5 w-3.5"
                                content={t('apiKeys.expiryTooltip')}
                            />
                        </div>
                        <Combobox
                            hideSearch
                            id="key-expiry-select"
                            selected={EXPIRY_CB_OPTIONS.find(o => o.value === createExpiry) ?? null}
                            setSelected={(opt) => setCreateExpiry(opt?.value ?? '')}
                            options={EXPIRY_CB_OPTIONS}
                            placeholder={t('apiKeys.noExpiry')}
                            matchTriggerWidth
                            buttonProps={{ className: 'w-full sm:w-48' }}
                        />
                    </div>

                    <div>
                        <div className="mb-1 flex items-center gap-1.5">
                            <label className="text-xs text-content-muted uppercase tracking-wider">{t('apiKeys.bindingLabel')}</label>
                            <InfoTooltip
                                aria-label={t('apiKeys.bindingAria')}
                                iconClassName="h-3.5 w-3.5"
                                content={t('apiKeys.bindingTooltip')}
                            />
                        </div>
                        {agentsRefused ? (
                            <p className="text-xs text-content-muted" id="key-binding-unavailable">
                                {t('apiKeys.bindingUnavailable')}
                            </p>
                        ) : (
                            <>
                                <Combobox
                                    id="key-agent-select"
                                    selected={AGENT_CB_OPTIONS(agents).find(o => o.value === createAgentId) ?? null}
                                    setSelected={(opt) => {
                                        setCreateAgentId(opt?.value ?? '');
                                        // A ceiling with no agent to min against is
                                        // refused by a CHECK constraint, so clearing
                                        // the agent must clear the ceiling too rather
                                        // than submit a state the database forbids.
                                        if (!opt?.value) setCreateMaxAutonomy('');
                                    }}
                                    options={AGENT_CB_OPTIONS(agents)}
                                    placeholder={t('apiKeys.agentPlaceholder')}
                                    matchTriggerWidth
                                    buttonProps={{ className: 'w-full sm:w-72' }}
                                />
                                {createAgentId && (
                                    <div className="mt-2">
                                        <div className="mb-1 flex items-center gap-1.5">
                                            <label className="text-xs text-content-muted uppercase tracking-wider">{t('apiKeys.autonomyLabel')}</label>
                                            <InfoTooltip
                                                aria-label={t('apiKeys.autonomyAria')}
                                                iconClassName="h-3.5 w-3.5"
                                                content={t('apiKeys.autonomyTooltip')}
                                            />
                                        </div>
                                        <Combobox
                                            hideSearch
                                            id="key-autonomy-select"
                                            selected={
                                                AUTONOMY_CB_OPTIONS(
                                                    agents.find(a => a.id === createAgentId)?.autonomyLevel ?? 0,
                                                    t('apiKeys.autonomyNone'),
                                                ).find(o => o.value === createMaxAutonomy) ?? null
                                            }
                                            setSelected={(opt) => setCreateMaxAutonomy(opt?.value ?? '')}
                                            options={AUTONOMY_CB_OPTIONS(
                                                agents.find(a => a.id === createAgentId)?.autonomyLevel ?? 0,
                                                t('apiKeys.autonomyNone'),
                                            )}
                                            placeholder={t('apiKeys.autonomyNone')}
                                            matchTriggerWidth
                                            buttonProps={{ className: 'w-full sm:w-72' }}
                                        />
                                    </div>
                                )}
                            </>
                        )}
                    </div>

                    <div>
                        <label className="text-xs text-content-muted uppercase tracking-wider mb-2 block">{t('apiKeys.scopesLabel')}</label>
                        <ScopePicker selected={createScopes} onChange={setCreateScopes} />
                    </div>

                    <div className="flex gap-tight pt-2">
                        <Button
                            variant="primary"
                            onClick={handleCreate}
                            disabled={creating || !createName.trim() || createScopes.length === 0}
                            loading={creating}
                            id="key-submit-btn"
                        >
                            {creating ? t('apiKeys.creating') : t('apiKeys.createKey')}
                        </Button>
                        <Button variant="secondary" onClick={() => setShowCreate(false)}>{t('apiKeys.cancel')}</Button>
                    </div>
                </div>
            )}

            {/* Active Keys. R13-PR5 — the outer
                `cardVariants({ density: 'none' })` wrapper was dropped
                so the DataTable primitive's own bordered card is the
                only one (matches Controls list visually). The section
                heading hoists out above the table. */}
            <div id="active-keys-card">
                <Heading level={3} className="mb-3">{t('apiKeys.activeKeysCount', { count: activeKeys.length })}</Heading>
                <DataTable
                    data={activeKeys}
                    columns={activeKeyColumns}
                    getRowId={(k) => k.id}
                    emptyState={t('apiKeys.emptyActive')}
                    resourceName={(p) => (p ? t('apiKeys.resourcePlural') : t('apiKeys.resourceSingular'))}
                    data-testid="active-keys-table"
                />
            </div>

            {/* Inactive/Revoked Keys */}
            {inactiveKeys.length > 0 && (
                <div className="opacity-60" id="inactive-keys-card">
                    <Heading level={3} className="mb-3">{t('apiKeys.revokedSection', { count: inactiveKeys.length })}</Heading>
                    <DataTable
                        data={inactiveKeys}
                        columns={inactiveKeyColumns}
                        getRowId={(k) => k.id}
                        emptyState={t('apiKeys.emptyRevoked')}
                        resourceName={(p) => (p ? t('apiKeys.revokedResourcePlural') : t('apiKeys.revokedResourceSingular'))}
                        data-testid="inactive-keys-table"
                    />
                </div>
            )}

            <ConfirmDialog
                showModal={keyToRevoke !== null}
                setShowModal={(open) => {
                    if (typeof open === 'function') {
                        const next = open(keyToRevoke !== null);
                        if (!next) setKeyToRevoke(null);
                    } else if (!open) {
                        setKeyToRevoke(null);
                    }
                }}
                tone="danger"
                title={
                    keyToRevoke
                        ? t('apiKeys.revokeConfirmTitle', { name: keyToRevoke.name })
                        : t('apiKeys.revokeConfirmTitleGeneric')
                }
                description={
                    keyToRevoke
                        ? t('apiKeys.revokeConfirmDesc', { prefix: keyToRevoke.keyPrefix })
                        : undefined
                }
                confirmLabel={t('apiKeys.revokeConfirm')}
                onConfirm={async () => {
                    if (keyToRevoke) await performRevoke(keyToRevoke);
                }}
            />
        </div>
    );
}
