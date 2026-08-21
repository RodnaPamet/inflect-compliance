'use client';
/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

import { formatDate } from '@/lib/format-date';
import { coerceDeclaredBooleans } from '@/lib/integrations/config-form-values';
import { useEffect, useState, useCallback } from 'react';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { Trash2, CheckCircle, XCircle, Loader2, Link2, Eye, EyeOff, RefreshCw, Activity, Pencil } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons/nucleo';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { RequiredMarker } from '@/components/ui/required-marker';
import { Tooltip } from '@/components/ui/tooltip';
import { DataTable, createColumns } from '@/components/ui/table';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading, Eyebrow } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { IdentityCrossLinks } from '@/components/admin/IdentityCrossLinks';
import { RequirePermission } from '@/components/require-permission';
import { cardVariants } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button-variants';
import { cn } from '@/lib/cn';
import { useTranslations } from 'next-intl';
import { SharePointCard } from './SharePointCard';
import { ConnectionHealthPanel } from './ConnectionHealthPanel';

interface ConnectionDTO {
    id: string;
    provider: string;
    name: string;
    isEnabled: boolean;
    configJson: Record<string, unknown>;
    lastTestedAt: string | null;
    lastTestStatus: string | null;
    createdAt: string;
    updatedAt: string;
    secretStatus: string;
    webhookUrl: string;
    _count?: { executions: number };
}

type FieldType = 'string' | 'number' | 'boolean' | 'select' | 'textarea';
interface ConfigFieldInfo { key: string; label: string; type: FieldType; required: boolean; placeholder?: string; description?: string; options?: string[] }
interface ProviderInfo {
    id: string;
    displayName: string;
    description: string;
    supportedChecks: string[];
    configSchema: {
        configFields: ConfigFieldInfo[];
        secretFields: ConfigFieldInfo[];
    };
    // P2 — setup guidance + honest test-validation kind.
    setupGuide?: string;
    liveValidation?: boolean;
    // P3 — hub category (identity / cloud / scm / hris / document / …).
    category?: string;
}

/** P3 — connector category order + i18n label keys for the grouped hub. */
const CATEGORY_ORDER = ['identity', 'cloud', 'scm', 'hris', 'document', 'other'] as const;

export default function AdminIntegrationsPage() {
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const t = useTranslations('admin');

    const [connections, setConnections] = useState<ConnectionDTO[]>([]);
    const [providers, setProviders] = useState<ProviderInfo[]>([]);
    const [webhookBaseUrl, setWebhookBaseUrl] = useState('');
    const [loading, setLoading] = useState(true);
    const [showForm, setShowForm] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [formProvider, setFormProvider] = useState('');
    const [formName, setFormName] = useState('');
    const [formConfig, setFormConfig] = useState<Record<string, string>>({});
    const [formSecrets, setFormSecrets] = useState<Record<string, string>>({});
    const [showSecrets, setShowSecrets] = useState(false);
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState<string | null>(null);
    const [syncingId, setSyncingId] = useState<string | null>(null);
    /**
     * connectionId -> last SUCCESSFUL execution, i.e. when this connection
     * last actually COLLECTED evidence.
     *
     * Deliberately not a new column on IntegrationConnection. The model
     * carries `lastTestedAt` / `lastTestStatus`, which answer "did the
     * credentials work when someone last pressed Test" — a different question
     * from the one an admin is asking, and the reason the table looked
     * informative while telling them nothing about continuity. The answer
     * already existed: `getConnectionsHealth` derives it from
     * IntegrationExecution and the health endpoint already serves it.
     */
    const [lastSuccessById, setLastSuccessById] = useState<Record<string, string | null>>({});
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

    const fetchConnections = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(apiUrl('/admin/integrations'));
            const data = await res.json();
            setConnections(data.connections ?? []);
            // Same endpoint the freshness panel below reads. Fetched here so
            // the table can answer "when did this last collect?" without a
            // schema change.
            try {
                const healthRes = await fetch(apiUrl('/admin/integrations/health'));
                const health = await healthRes.json();
                const map: Record<string, string | null> = {};
                for (const row of (health.connections ?? []) as Array<{ connectionId: string; lastSuccessAt: string | null }>) {
                    map[row.connectionId] = row.lastSuccessAt;
                }
                setLastSuccessById(map);
            } catch {
                // Non-fatal: the table still renders, the column reads "—".
                // A freshness signal is not worth failing the page over.
                setLastSuccessById({});
            }
            setProviders(data.availableProviders ?? []);
            setWebhookBaseUrl(data.webhookBaseUrl ?? '');
        } catch {
            setMessage({ type: 'error', text: t('integrations.loadFailed') });
        }
        setLoading(false);
    }, [apiUrl, t]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchConnections(); }, [fetchConnections]);

    const resetForm = () => {
        setShowForm(false);
        setEditingId(null);
        setFormProvider('');
        setFormName('');
        setFormConfig({});
        setFormSecrets({});
        setShowSecrets(false);
    };

    /** Open the Add form pre-selected to a catalog provider ("Connect" card). */
    const handleConnect = (providerId: string) => {
        setEditingId(null);
        setFormProvider(providerId);
        setFormName('');
        setFormConfig({});
        setFormSecrets({});
        setShowSecrets(false);
        setMessage(null);
        setShowForm(true);
        // Defer so the form has mounted before we scroll it into view.
        setTimeout(() => document.getElementById('save-integration-btn')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
    };

    // External providers worth surfacing as connectable cards — those that
    // actually take a config or secret (internal-only check providers like
    // personnel/device/training carry no config and are driven by their pages).
    const connectableProviders = providers.filter(
        (p) => p.configSchema.configFields.length + p.configSchema.secretFields.length > 0,
    );

    const handleSave = async () => {
        if (!formProvider || !formName) {
            setMessage({ type: 'error', text: t('integrations.providerNameRequired') });
            return;
        }
        setSaving(true);
        setMessage(null);
        try {
            // Form state is all strings; the API needs real JSON booleans for the
            // fields a provider declares boolean. See coerceDeclaredBooleans for
            // why a ticked checkbox otherwise saved as the string 'true' and left
            // the feature off with no error anywhere.
            const declaredBoolean = new Set(
                (providers.find(p => p.id === formProvider)?.configSchema.configFields ?? [])
                    .filter(f => f.type === 'boolean')
                    .map(f => f.key),
            );
            const configJson = coerceDeclaredBooleans(formConfig, declaredBoolean);

            const body: Record<string, unknown> = {
                provider: formProvider,
                name: formName,
                configJson,
            };
            if (editingId) body.id = editingId;

            // Only send secrets if any field has a value
            const hasSecrets = Object.values(formSecrets).some(v => v.trim().length > 0);
            if (hasSecrets) {
                body.secrets = formSecrets;
            }

            const res = await fetch(apiUrl('/admin/integrations'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            if (!res.ok) {
                const err = await res.json();
                setMessage({ type: 'error', text: err.error || t('integrations.saveFailed') });
            } else {
                const data = await res.json();
                setMessage({
                    type: 'success',
                    text: editingId
                        ? t('integrations.connectionUpdated')
                        : `${t('integrations.connectionCreated')}${data.warning ? ` ${data.warning}` : ''}`,
                });
                resetForm();
                await fetchConnections();
                // P1 — kick off an initial sync + check so a fresh connection
                // produces a visible first result (not just a silent row).
                if (!editingId && data.id) {
                    void handleSyncNow(data.id as string);
                }
            }
        } catch {
            setMessage({ type: 'error', text: t('integrations.networkError') });
        }
        setSaving(false);
    };

    /** P2 — open the form to edit an existing connection (edit was unreachable). */
    const handleEdit = (conn: ConnectionDTO) => {
        setEditingId(conn.id);
        setFormProvider(conn.provider);
        setFormName(conn.name);
        // `String(v)` is a DOWNGRADE for a stored boolean, and it is safe only
        // because handleSave converts declared boolean fields back on the way
        // out: true -> 'true' -> checkbox ticked -> true. Break that pairing and
        // editing an unrelated field on a working connection silently turns its
        // booleans into strings, which is how a connection that was writing
        // stops writing with nothing to show for it.
        setFormConfig(Object.fromEntries(Object.entries(conn.configJson ?? {}).map(([k, v]) => [k, v == null ? '' : String(v)])));
        setFormSecrets({});
        setShowSecrets(false);
        setMessage(null);
        setShowForm(true);
        setTimeout(() => document.getElementById('save-integration-btn')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
    };

    const handleTest = async (conn: ConnectionDTO) => {
        setTesting(conn.id);
        setMessage(null);
        try {
            const res = await fetch(apiUrl('/admin/integrations'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    connectionId: conn.id,
                    provider: conn.provider,
                    configJson: conn.configJson,
                }),
            });
            const data = await res.json();
            // P2 — honest labelling: a green check on a shape-only provider means
            // "config looks valid", NOT "connectivity verified".
            const isLive = providers.find(p => p.id === conn.provider)?.liveValidation ?? false;
            setMessage({
                type: data.valid ? 'success' : 'error',
                text: data.valid
                    ? (isLive ? t('integrations.testVerified') : t('integrations.testShapeOnly'))
                    : t('integrations.testFailed', { error: data.error || t('integrations.unknownError') }),
            });
            await fetchConnections();
        } catch {
            setMessage({ type: 'error', text: t('integrations.testFailedNetwork') });
        }
        setTesting(null);
    };

    /** P1 — connection-level "Sync now / run checks now". */
    const handleSyncNow = async (connectionId: string) => {
        setSyncingId(connectionId);
        setMessage({ type: 'success', text: t('integrations.syncRunning') });
        try {
            const res = await fetch(apiUrl(`/admin/integrations/${connectionId}/sync`), { method: 'POST' });
            if (!res.ok) {
                setMessage({ type: 'error', text: t('integrations.syncFailed') });
                return;
            }
            const data = await res.json() as { counts?: { total: number; passed: number; failed: number; error: number }; identity?: { upserted: number } | null };
            setMessage({
                type: (data.counts?.error ?? 0) > 0 ? 'error' : 'success',
                text: t('integrations.syncDone', {
                    total: data.counts?.total ?? 0,
                    passed: data.counts?.passed ?? 0,
                    failed: data.counts?.failed ?? 0,
                    accounts: data.identity?.upserted ?? 0,
                }),
            });
            await fetchConnections();
        } catch {
            setMessage({ type: 'error', text: t('integrations.syncFailed') });
        } finally {
            setSyncingId(null);
        }
    };

    /**
     * P2 — internal check providers (personnel/device/training) take no
     * credentials but still need an IntegrationConnection row to run. Rather
     * than a confusing free-form Add entry, auto-provision them in one click.
     */
    const internalProviders = providers.filter(
        (p) => p.configSchema.configFields.length + p.configSchema.secretFields.length === 0,
    );
    const allInternalEnabled = internalProviders.length > 0 &&
        internalProviders.every((ip) => connections.some((c) => c.provider === ip.id && c.isEnabled));

    const handleEnableInternal = async () => {
        setMessage(null);
        try {
            for (const ip of internalProviders) {
                if (connections.some((c) => c.provider === ip.id)) continue;
                await fetch(apiUrl('/admin/integrations'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ provider: ip.id, name: ip.displayName, configJson: {} }),
                });
            }
            setMessage({ type: 'success', text: t('integrations.internalEnabled') });
            await fetchConnections();
        } catch {
            setMessage({ type: 'error', text: t('integrations.internalEnableFailed') });
        }
    };

    const handleDisable = async (connectionId: string) => {
        setMessage(null);
        try {
            await fetch(apiUrl('/admin/integrations'), {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ connectionId }),
            });
            setMessage({ type: 'success', text: t('integrations.connectionDisabled') });
            await fetchConnections();
        } catch {
            setMessage({ type: 'error', text: t('integrations.disableFailed') });
        }
    };

    const selectedProvider = providers.find(p => p.id === formProvider);

    /**
     * P2 — render a config/secret field as its DECLARED type (was text-for-
     * everything): select → dropdown from options; number → numeric input;
     * boolean → checkbox; textarea → multi-line (service-account JSON blobs);
     * string → text/masked input.
     */
    const renderField = (field: ConfigFieldInfo, isSecret: boolean) => {
        const value = (isSecret ? formSecrets : formConfig)[field.key] ?? '';
        const setValue = (v: string) => (isSecret ? setFormSecrets : setFormConfig)(prev => ({ ...prev, [field.key]: v }));
        const fid = `field-${field.key}`;
        switch (field.type) {
            case 'select': {
                const opts: ComboboxOption[] = (field.options ?? []).map(o => ({ value: o, label: o }));
                return <Combobox id={fid} options={opts} selected={opts.find(o => o.value === value) ?? null} setSelected={(o) => o && setValue(String(o.value))} placeholder={field.placeholder} />;
            }
            case 'boolean':
                return (
                    <label className="flex items-center gap-tight text-sm text-content-default">
                        <Checkbox id={fid} checked={value === 'true'} onCheckedChange={(c) => setValue(c ? 'true' : 'false')} />
                        {field.placeholder ?? field.label}
                    </label>
                );
            case 'number':
                return <input id={fid} type="text" inputMode="decimal" value={value} onChange={e => setValue(e.target.value)} className="input w-full" placeholder={field.placeholder} />;
            case 'textarea':
                return <Textarea id={fid} value={value} onChange={e => setValue(e.target.value)} placeholder={field.placeholder} rows={6} className={cn('w-full', isSecret && 'font-mono')} />;
            default:
                return isSecret
                    ? <input id={fid} type={showSecrets ? 'text' : 'password'} value={value} onChange={e => setValue(e.target.value)} className="input w-full font-mono" placeholder={field.placeholder ?? '••••••••'} autoComplete="off" />
                    : <input id={fid} type="text" value={value} onChange={e => setValue(e.target.value)} className="input w-full" placeholder={field.placeholder} />;
        }
    };

    return (
            <div className="space-y-section animate-fadeIn">
                <BackAffordance />
                <div>
                    <PageBreadcrumbs
                        items={[
                            { label: t('crumb.dashboard'), href: tenantHref('/dashboard') },
                            { label: t('crumb.admin'), href: tenantHref('/admin') },
                            { label: t('crumb.integrations') },
                        ]}
                        className="mb-1"
                    />
                    <Heading level={1}>{t('integrations.title')}</Heading>
                    <div className="mt-3">
                        <IdentityCrossLinks current="integrations" />
                    </div>
                </div>

                {/* SP-1 — SharePoint connection (delegated consent, separate
                    from the generic config-field connections below). */}
                <SharePointCard />

                {/* Available-integrations catalog — every registered external
                    provider (AWS / GCP / Okta / Azure / HRIS / GitHub, …) shown
                    as a Connect card that opens the Add form pre-selected. */}
                {connectableProviders.length > 0 && (
                    <div>
                        <Heading level={2} className="mb-1">{t('integrations.availableTitle')}</Heading>
                        <p className="text-sm text-content-muted mb-3">{t('integrations.availableSubtitle')}</p>
                        {/* P3 — connectors grouped by category (Identity / Cloud / SCM /
                            HRIS / Document) instead of one flat grid. */}
                        <div className="space-y-section">
                        {CATEGORY_ORDER.map((cat) => {
                            const inCat = connectableProviders.filter((p) => (p.category ?? 'other') === cat);
                            if (inCat.length === 0) return null;
                            return (
                            <div key={cat}>
                                <Eyebrow>{t(`integrations.category.${cat}` as Parameters<typeof t>[0])}</Eyebrow>
                                <div className="grid gap-default sm:grid-cols-2 lg:grid-cols-3 mt-1">
                                {inCat.map((p) => (
                                <div key={p.id} className={cn(cardVariants(), 'flex flex-col gap-compact')}>
                                    <div>
                                        <Heading level={3}>{p.displayName}</Heading>
                                        <p className="text-xs text-content-subtle mt-0.5 line-clamp-2">{p.description}</p>
                                    </div>
                                    {p.supportedChecks.length > 0 && (
                                        <div className="flex flex-wrap gap-1">
                                            {p.supportedChecks.slice(0, 3).map((check) => (
                                                <StatusBadge variant="neutral" key={check}>{check}</StatusBadge>
                                            ))}
                                            {p.supportedChecks.length > 3 && (
                                                <span className="text-xs text-content-subtle self-center">+{p.supportedChecks.length - 3}</span>
                                            )}
                                        </div>
                                    )}
                                    <div className="mt-auto pt-2">
                                        <Button
                                            variant="secondary"
                                            size="sm"
                                            icon={<Link2 className="w-3.5 h-3.5" />}
                                            onClick={() => handleConnect(p.id)}
                                            id={`connect-${p.id}-btn`}
                                        >
                                            {t('integrations.connect')}
                                        </Button>
                                    </div>
                                </div>
                                ))}
                                </div>
                            </div>
                            );
                        })}
                        </div>
                    </div>
                )}

                {/* Message banner */}
                {message && (
                    <div className={`p-3 rounded-lg text-sm flex items-center gap-tight ${
                        message.type === 'success'
                            ? 'bg-bg-success border border-border-success text-content-success'
                            : 'bg-bg-error border border-border-error text-content-error'
                    }`}>
                        {message.type === 'success' ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                        {message.text}
                    </div>
                )}

                {/* Webhook endpoint info */}
                {webhookBaseUrl && (
                    <div className={cardVariants({ density: 'compact' })}>
                        <p className="text-xs text-content-muted mb-1">{t('integrations.webhookBaseUrl')}</p>
                        <code className="text-sm text-[var(--brand-default)] font-mono">{webhookBaseUrl}/&#123;provider&#125;</code>
                    </div>
                )}

                {/* Connections list. R13-PR6 — outer
                    `cardVariants({ density: 'none' })` wrapper
                    dropped so the DataTable primitive's own bordered
                    card is the only one (matches Controls list
                    visually). The "Configured Connections" heading +
                    Add button hoist above the table. */}
                <div>
                    <div className="flex justify-between items-center mb-3">
                        <Heading level={2}>{t('integrations.configuredConnections')}</Heading>
                        <div className="flex items-center gap-tight">
                            {internalProviders.length > 0 && !allInternalEnabled && (
                                <Button variant="secondary" size="sm" onClick={handleEnableInternal} id="enable-internal-checks-btn">
                                    {t('integrations.enableInternal')}
                                </Button>
                            )}
                            <Link href={tenantHref('/admin/integrations/identity-accounts')} className={buttonVariants({ variant: 'secondary', size: 'sm' })} id="identity-accounts-link">
                                {t('identityAccounts.linkLabel')}
                            </Link>
                            {/* The leaver-pass report is the only identity surface
                                here that is OWNER-only — it names which of a
                                customer's people the product would have disabled.
                                Gated at the LINK as well as at the page, so an
                                ADMIN is never offered a door that closes on them. */}
                            <RequirePermission resource="admin" action="tenant_lifecycle">
                                <Link href={tenantHref('/admin/identity-leaver-passes')} className={buttonVariants({ variant: 'secondary', size: 'sm' })} id="leaver-passes-link">
                                    {t('leaverPasses.linkLabel')}
                                </Link>
                                {/* The ladder itself. It shipped with a route and
                                    no door, so the only way to start the mandated
                                    seven-day dry run was a hand-made request from
                                    an OWNER session — which meant the observation
                                    period could not be BEGUN through the product
                                    at all. Same gate as its sibling: the control
                                    decides whether we may disable accounts in the
                                    customer's own directory. */}
                                <Link href={tenantHref('/admin/identity-write-policy')} className={buttonVariants({ variant: 'secondary', size: 'sm' })} id="write-policy-link">
                                    {t('writeLadder.linkLabel')}
                                </Link>
                            </RequirePermission>
                            <Button
                                variant="primary"
                                icon={<Plus className="-ml-0.5 -mr-2.5" />}
                                onClick={() => { resetForm(); setShowForm(true); }}
                                id="add-integration-btn"
                            >
                                {t('integrations.addButton')}
                            </Button>
                        </div>
                    </div>

                    {loading ? (
                        <div className="p-8 text-center text-content-subtle">
                            <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
                            <span className="sr-only">{t('integrations.fetching')}</span>
                        </div>
                    ) : connections.length === 0 ? (
                        <div className="p-8 text-center text-content-subtle">
                            {t('integrations.emptyConfigured')}
                        </div>
                    ) : (
                        (() => {
                            const connCols = createColumns<ConnectionDTO>([
                                { accessorKey: 'provider', header: t('integrations.colProvider'), cell: ({ getValue }) => <StatusBadge variant="info">{getValue()}</StatusBadge> },
                                { accessorKey: 'name', header: t('integrations.colName'), cell: ({ getValue }) => <span className="font-medium">{getValue()}</span> },
                                {
                                    id: 'status', header: t('integrations.colStatus'), accessorKey: 'isEnabled',
                                    cell: ({ row }) => <StatusBadge variant={row.original.isEnabled ? 'success' : 'error'}>{row.original.isEnabled ? t('integrations.statusActive') : t('integrations.statusDisabled')}</StatusBadge>,
                                },
                                { id: 'secrets', header: t('integrations.colSecrets'), cell: () => <span className="text-content-subtle font-mono">••••••••</span> },
                                {
                                    id: 'lastTest', header: t('integrations.colLastTest'), accessorKey: 'lastTestedAt',
                                    cell: ({ row }) => row.original.lastTestedAt ? (
                                        <span className="flex items-center gap-1 text-content-muted">
                                            {row.original.lastTestStatus === 'ok' ? <CheckCircle className="w-3.5 h-3.5 text-content-success" /> : <XCircle className="w-3.5 h-3.5 text-content-error" />}
                                            {formatDate(row.original.lastTestedAt)}
                                        </span>
                                    ) : <span className="text-content-subtle">—</span>,
                                },
                                {
                                    // "Tested OK" and "collected evidence" are
                                    // different facts, and only one of them
                                    // tells an admin the integration is doing
                                    // its job. They sit adjacent so the
                                    // difference is legible at a glance.
                                    id: 'lastCollected', header: t('integrations.colLastCollected'),
                                    accessorFn: (c: ConnectionDTO) => lastSuccessById[c.id] ?? '',
                                    cell: ({ row }) => {
                                        const at = lastSuccessById[row.original.id];
                                        if (at) return <span className="text-content-muted">{formatDate(at)}</span>;
                                        // An enabled connection that has never
                                        // collected is the case worth seeing:
                                        // it looks connected and is producing
                                        // nothing.
                                        return row.original.isEnabled
                                            ? <span className="text-content-warning">{t('integrations.neverCollected')}</span>
                                            : <span className="text-content-subtle">—</span>;
                                    },
                                },
                                { id: 'executions', header: t('integrations.colExecutions'), accessorFn: (c: ConnectionDTO) => c._count?.executions ?? 0, cell: ({ getValue }) => <span>{getValue()}</span> },
                                {
                                    id: 'actions', header: t('integrations.colActions'),
                                    cell: ({ row }) => (
                                        <div className="flex gap-1">
                                            <Tooltip content={t('integrations.syncNow')}>
                                                <Button variant="secondary" size="xs" onClick={() => handleSyncNow(row.original.id)} disabled={syncingId === row.original.id} aria-label={t('integrations.syncNow')} id={`sync-${row.original.id}-btn`}>
                                                    <RefreshCw className={cn('w-3.5 h-3.5', syncingId === row.original.id && 'animate-spin')} />
                                                </Button>
                                            </Tooltip>
                                            <Tooltip content={t('integrations.viewOutcomes')}>
                                                <Link href={tenantHref(`/admin/integrations/${row.original.id}`)} aria-label={t('integrations.viewOutcomes')} className={buttonVariants({ variant: 'secondary', size: 'xs' })}>
                                                    <Activity className="w-3.5 h-3.5" />
                                                </Link>
                                            </Tooltip>
                                            <Tooltip content={t('integrations.testConnection')}>
                                                <Button variant="secondary" size="xs" onClick={() => handleTest(row.original)} disabled={testing === row.original.id} aria-label={t('integrations.testConnection')}>
                                                    {testing === row.original.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
                                                </Button>
                                            </Tooltip>
                                            <Tooltip content={t('integrations.editConnection')}>
                                                <Button variant="secondary" size="xs" onClick={() => handleEdit(row.original)} aria-label={t('integrations.editConnection')}>
                                                    <Pencil className="w-3.5 h-3.5" />
                                                </Button>
                                            </Tooltip>
                                            <Tooltip content={t('integrations.disableIntegration')}>
                                                <Button variant="destructive" size="xs" onClick={() => handleDisable(row.original.id)} aria-label={t('integrations.disableIntegration')}>
                                                    <Trash2 className="w-3.5 h-3.5" />
                                                </Button>
                                            </Tooltip>
                                        </div>
                                    ),
                                },
                            ]);
                            return (
                                <DataTable
                                    data={connections}
                                    columns={connCols}
                                    getRowId={(c) => c.id}
                                    emptyState={t('integrations.emptyConfigured')}
                                    resourceName={(p) => p ? t('integrations.resourceConnections') : t('integrations.resourceConnection')}
                                    data-testid="integrations-table"
                                />
                            );
                        })()
                    )}
                </div>

                {/* GAP-3 — per-connection freshness (self-renders only when
                    there is at least one enabled connection). */}
                <ConnectionHealthPanel />

                {/* Add/Edit Form */}
                {showForm && (
                    <div className={cn(cardVariants(), 'space-y-default')}>
                        <Heading level={2}>
                            {editingId ? t('integrations.editIntegration') : t('integrations.addIntegration')}
                        </Heading>

                        {/* Provider select */}
                        <div>
                            <label className="block text-sm text-content-muted mb-1">{t('integrations.provider')}</label>
                            <Combobox
                                id="integration-provider-select"
                                selected={connectableProviders.map(p => ({ value: p.id, label: p.displayName })).find(o => o.value === formProvider) ?? null}
                                setSelected={(opt) => { setFormProvider(opt?.value ?? ''); setFormConfig({}); setFormSecrets({}); }}
                                // P2 — only credential-taking providers are selectable here; the
                                // internal (personnel/device/training) check providers are enabled
                                // via the "Enable internal checks" button, not this free-form form.
                                options={connectableProviders.map(p => ({ value: p.id, label: p.displayName }))}
                                placeholder={t('integrations.selectProvider')}
                                disabled={!!editingId}
                                matchTriggerWidth
                            />
                            {selectedProvider && (
                                <p className="text-xs text-content-subtle mt-1">{selectedProvider.description}</p>
                            )}
                        </div>

                        {/* Name */}
                        <div>
                            <label className="block text-sm text-content-muted mb-1">{t('integrations.connectionName')}</label>
                            <input
                                type="text"
                                value={formName}
                                onChange={e => setFormName(e.target.value)}
                                className="input w-full"
                                placeholder={t('integrations.namePlaceholder')}
                                id="integration-name-input"
                            />
                        </div>

                        {/* P2 — per-provider setup guidance (what it needs + where to get it). */}
                        {selectedProvider?.setupGuide && (
                            <div className="p-3 rounded-lg border border-border-info bg-bg-info text-sm text-content-info" data-testid="provider-setup-guide">
                                {selectedProvider.setupGuide}
                            </div>
                        )}

                        {/* Config fields */}
                        {selectedProvider && selectedProvider.configSchema.configFields.length > 0 && (
                            <div className="space-y-compact">
                                <Heading level={3}>{t('integrations.configuration')}</Heading>
                                {selectedProvider.configSchema.configFields.map(field => (
                                    <div key={field.key}>
                                        <label className="block text-xs text-content-muted mb-1">
                                            {field.label} {field.required && <RequiredMarker />}
                                        </label>
                                        {renderField(field, false)}
                                        {field.description && (
                                            <p className="text-xs text-content-subtle mt-0.5">{field.description}</p>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Secret fields */}
                        {selectedProvider && selectedProvider.configSchema.secretFields.length > 0 && (
                            <div className="space-y-compact">
                                <div className="flex items-center justify-between">
                                    <Heading level={3}>{t('integrations.secrets')}</Heading>
                                    <Button
                                        variant="secondary"
                                        size="xs"
                                        onClick={() => setShowSecrets(!showSecrets)}
                                    >
                                        {showSecrets ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                                        {showSecrets ? t('integrations.hide') : t('integrations.show')}
                                    </Button>
                                </div>
                                <div className="p-3 rounded border border-border-warning bg-bg-warning">
                                    <p className="text-xs text-content-warning">
                                        {t('integrations.secretsNotice')}
                                    </p>
                                </div>
                                {selectedProvider.configSchema.secretFields.map(field => (
                                    <div key={field.key}>
                                        <label className="block text-xs text-content-muted mb-1">
                                            {field.label} {field.required && <RequiredMarker />}
                                        </label>
                                        {renderField(field, true)}
                                        {field.description && (
                                            <p className="text-xs text-content-subtle mt-0.5">{field.description}</p>
                                        )}
                                        {/* P2 — edit mode: blank keeps the stored secret. */}
                                        {editingId && (
                                            <p className="text-xs text-content-subtle mt-0.5">{t('integrations.leaveBlankHint')}</p>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Supported checks */}
                        {selectedProvider && (
                            <div>
                                <Heading level={3} className="mb-1">{t('integrations.supportedChecks')}</Heading>
                                <div className="flex flex-wrap gap-1">
                                    {selectedProvider.supportedChecks.map(check => (
                                        <StatusBadge variant="neutral" key={check}>
                                            {selectedProvider.id}.{check}
                                        </StatusBadge>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Actions */}
                        <div className="flex gap-tight pt-2">
                            <Button
                                variant="primary"
                                onClick={handleSave}
                                disabled={saving || !formProvider || !formName}
                                loading={saving}
                                id="save-integration-btn"
                            >
                                {editingId ? t('integrations.updateConnection') : t('integrations.createConnection')}
                            </Button>
                            <Button variant="secondary" onClick={resetForm}>{t('integrations.cancel')}</Button>
                        </div>
                    </div>
                )}
            </div>
    );
}
