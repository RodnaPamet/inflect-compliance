'use client';
/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

import { formatDate } from '@inflect/ui/lib/format-date';
import { buildConnectionBody } from '@/lib/integrations/config-form-values';
import { LABELLED_CHECKS } from '@/lib/integrations/check-labels';
import { LABELLED_PROVIDERS } from '@/lib/integrations/provider-labels';
import { summariseSync, type SyncConnectionResponse } from '@/lib/integrations/sync-outcome';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { apiErrorMessage } from '@/lib/api-error';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { useOffersAdminApiWrite } from '@/lib/auth/use-offers-admin-api-write';
import { Trash2, CheckCircle, XCircle, Loader2, Link2, Eye, EyeOff, RefreshCw, Activity, Pencil, KeyRound } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Plus } from '@inflect/ui/components/ui/icons/nucleo';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { RequiredMarker } from '@/components/ui/required-marker';
import { Tooltip } from '@/components/ui/tooltip';
import { DataTable, createColumns } from '@/components/ui/table';
import { StatusBadge } from '@/components/ui/status-badge';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading, Eyebrow } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { IdentityCrossLinks } from '@/components/admin/IdentityCrossLinks';
import { RequirePermission } from '@/components/require-permission';
import { cardVariants } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button-variants';
import { cn } from '@inflect/ui/lib/cn';
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
const CATEGORY_ORDER = ['identity', 'legacy', 'cloud', 'scm', 'hris', 'document', 'other'] as const;

/**
 * Providers whose connections a card above the table owns, kept out of
 * Configured Connections (#4466).
 *
 * The table's controls are generic: Test connection and Update Connection go
 * through the provider `registry`, which has no SharePoint provider —
 * SharePoint is registered only as an `integrationRegistry` bundle — so both
 * failed "Unknown provider: sharepoint" on its row. Disable did work, and then
 * stranded the connection: the SharePoint card's Test, Sites and Disconnect all
 * refuse a disabled row, and its Connect stays hidden while a row exists. The
 * SharePoint card is where that connection is connected, tested, scoped and
 * disconnected, so its row is listed there and nowhere else. The health panel
 * still lists it, because sync freshness is a question about every connection.
 */
const CARD_OWNED_PROVIDERS: ReadonlySet<string> = new Set(['sharepoint']);

/** The `?mcp=` outcomes the Entra consent callback redirects back with. */
const CONSENT_OUTCOMES = ['connected', 'declined', 'error'] as const;
type ConsentOutcome = (typeof CONSENT_OUTCOMES)[number];
const CONSENT_NOTICE_VARIANT: Record<ConsentOutcome, 'success' | 'warning' | 'error'> = {
    connected: 'success',
    declined: 'warning',
    error: 'error',
};

export default function AdminIntegrationsPage() {
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const t = useTranslations('admin');
    // Every request here passes the edge (an Owner or Admin MEMBERSHIP) and
    // the routes' `admin.manage`. Saving, enabling, disabling, removing and
    // authorizing a connection also pass the usecases' `canAdmin` — the coarse
    // tier of a custom role's base — while listing, testing and syncing do not
    // (#4466 finding 9). Each control is offered where its request would be
    // accepted, and nowhere else.
    const canConfigure = useOffersAdminApiWrite({ key: 'admin.manage', floor: 'canAdmin' });
    const canOperate = useOffersAdminApiWrite({ key: 'admin.manage' });
    const searchParams = useSearchParams();
    // The consent callback (`/api/integrations/mcp-server/callback`) always
    // returns here with `?mcp=connected|declined|error`. Nothing read it, so a
    // failed exchange and a success looked the same (#4466).
    const consentParam = searchParams?.get('mcp') ?? null;
    const consentOutcome =
        CONSENT_OUTCOMES.find((o) => o === consentParam) ?? null;

    const [connections, setConnections] = useState<ConnectionDTO[]>([]);
    const [providers, setProviders] = useState<ProviderInfo[]>([]);
    const [webhookBaseUrl, setWebhookBaseUrl] = useState('');
    const [loading, setLoading] = useState(true);
    /**
     * Why the connection list could not be read, or null. A refusal or a
     * server error used to fall through to `data.connections ?? []` and render
     * "No integrations configured" with an empty catalogue, so a custom role
     * without the settings permission read the workspace as unconnected
     * (#4466).
     */
    const [loadError, setLoadError] = useState<string | null>(null);
    const [showForm, setShowForm] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    /** The edited connection's `isEnabled` — an edit never changes it (#4466). */
    const [editingEnabled, setEditingEnabled] = useState<boolean | undefined>(undefined);
    const [formProvider, setFormProvider] = useState('');
    const [authorizing, setAuthorizing] = useState<string | null>(null);
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
    const [message, setMessage] = useState<{ type: 'success' | 'warning' | 'error'; text: string } | null>(null);

    const fetchConnections = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(apiUrl('/admin/integrations'));
            const data = await res.json().catch(() => null);
            if (!res.ok) {
                setLoadError(apiErrorMessage(data, t('integrations.loadFailed')));
                setLoading(false);
                return;
            }
            setLoadError(null);
            setConnections(data?.connections ?? []);
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
            setProviders(data?.availableProviders ?? []);
            setWebhookBaseUrl(data?.webhookBaseUrl ?? '');
        } catch {
            setLoadError(t('integrations.loadFailed'));
        }
        setLoading(false);
    }, [apiUrl, t]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchConnections(); }, [fetchConnections]);

    const resetForm = () => {
        setShowForm(false);
        setEditingId(null);
        setEditingEnabled(undefined);
        setFormProvider('');
        setFormName('');
        setFormConfig({});
        setFormSecrets({});
        setShowSecrets(false);
    };

    /** Open the Add form pre-selected to a catalog provider ("Connect" card). */
    const handleConnect = (providerId: string) => {
        setEditingId(null);
        setEditingEnabled(undefined);
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

    /**
     * A provider's name, translated, everywhere this page shows one: both
     * tables (which used to print the id — `aws-posture`, `mcp-server`), the
     * catalogue cards and the form's provider picker (#4466). The server's
     * `displayName` is English and two of them name the protocol, so it is only
     * the fallback for an id this build has no label for; the id is the last
     * resort.
     */
    const serverNames = useMemo(
        () => new Map(providers.map((p) => [p.id, p.displayName] as const)),
        [providers],
    );
    const providerLabel = useCallback(
        (id: string) =>
            LABELLED_PROVIDERS.has(id)
                ? t(`integrations.providerLabels.${id}` as Parameters<typeof t>[0])
                : serverNames.get(id) ?? id,
        [serverNames, t],
    );

    /** A check's label when the catalogues carry one, its id otherwise. */
    const checkLabel = (check: string) =>
        LABELLED_CHECKS.has(check)
            ? t(`integrations.checkLabels.${check}` as Parameters<typeof t>[0])
            : check;

    /** The table lists every connection except the ones a card above owns. */
    const listedConnections = connections.filter((c) => !CARD_OWNED_PROVIDERS.has(c.provider));

    const handleSave = async () => {
        if (!formProvider || !formName) {
            setMessage({ type: 'error', text: t('integrations.providerNameRequired') });
            return;
        }
        setSaving(true);
        setMessage(null);
        try {
            // Both decisions this body encodes — omitting `secrets` unless one
            // was typed, and sending declared booleans as booleans — live in
            // `buildConnectionBody`, where they are unit-tested. They were
            // untestable here: see #4008 for the eight mocks a page-level test
            // needed before still timing out.
            const body = buildConnectionBody({
                provider: formProvider,
                name: formName,
                config: formConfig,
                secrets: formSecrets,
                editingId,
                // An edit keeps the connection's enabled state; without it the
                // server reads the edit as an enable (#4466).
                editingIsEnabled: editingEnabled,
                configFields:
                    providers.find(p => p.id === formProvider)?.configSchema.configFields ?? [],
            });

            const res = await fetch(apiUrl('/admin/integrations'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            if (!res.ok) {
                const err = await res.json();
                // `err.error` is an OBJECT — `{ code, message, requestId }` from
                // toApiErrorResponse — and `message.text` is a string. Assigning it
                // raw renders "[object Object]" at best, and React error #31 into
                // the page error boundary at worst. apiErrorMessage exists for
                // exactly this and its docblock says to always route through it;
                // this site predated the convention.
                //
                // It matters here beyond tidiness: the refusal this PR adds names
                // WHICH connection already holds the tenant's HRIS slot, and that
                // sentence is the whole operator-facing value of a config-time
                // refusal over a silent dispatcher collapse. Unrouted, the operator
                // sees a shrug.
                setMessage({ type: 'error', text: apiErrorMessage(err, t('integrations.saveFailed')) });
            } else {
                const data = await res.json();
                // The response's `warning` is an English sentence from the
                // route, and was appended verbatim in every locale (#4466). It
                // only ever said the secrets were stored, which `secretStatus`
                // says as a value, so the words are ours.
                setMessage({
                    type: 'success',
                    text: editingId
                        ? t('integrations.connectionUpdated')
                        : data.secretStatus === 'configured'
                            ? t('integrations.connectionCreatedWithSecrets')
                            : t('integrations.connectionCreated'),
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
        setEditingEnabled(conn.isEnabled);
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

    /**
     * Send the admin to Entra to authorize this MCP connection.
     *
     * A full-page navigation, not a popup: the state cookie the callback
     * verifies is `SameSite=Lax`, which survives a top-level redirect and is
     * exactly what a popup would put at risk.
     */
    const handleAuthorize = async (conn: ConnectionDTO) => {
        setAuthorizing(conn.id);
        setMessage(null);
        try {
            const res = await fetch(apiUrl(`/admin/integrations/${conn.id}/mcp-consent`), {
                method: 'POST',
            });
            const data = await res.json();
            if (!res.ok || !data.authorizeUrl) {
                // The server's reason is shown: it is our own text — "set the
                // tenant ID, client ID and client secret first" — and it names
                // what to fix. Through apiErrorMessage, because `data.error` is
                // the envelope OBJECT `{ code, message, requestId }`: rendered
                // as-is it threw "Objects are not valid as a React child" and
                // took the page down on exactly the refusal meant to help (#4466).
                setMessage({ type: 'error', text: apiErrorMessage(data, t('integrations.authorizeFailed')) });
                setAuthorizing(null);
                return;
            }
            window.location.href = data.authorizeUrl as string;
        } catch {
            setMessage({ type: 'error', text: t('integrations.authorizeFailed') });
            setAuthorizing(null);
        }
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
                    : t('integrations.testFailed', { error: apiErrorMessage(data, t('integrations.unknownError')) }),
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
            const data = await res.json().catch(() => null);
            if (!res.ok) {
                setMessage({ type: 'error', text: apiErrorMessage(data, t('integrations.syncFailed')) });
                return;
            }
            // A 200 can carry a directory or HR read that failed, stopped
            // early or never started — `summariseSync` decides the colour and
            // the sentences from all of it, not from the check counts alone.
            const summary = summariseSync((data ?? {}) as SyncConnectionResponse);
            setMessage({
                type: summary.tone,
                text: summary.parts
                    .map((p) => t(`integrations.syncResult.${p.key}` as Parameters<typeof t>[0], p.values))
                    .join(' '),
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

    /**
     * The body that turns an existing connection back on: its own name and
     * stored config, plus `isEnabled: true`. The stored config is sent rather
     * than omitted so the update's audit row reports the connection's real
     * security flags — an update without `configJson` records none, which reads
     * in the trail as flags having been switched off.
     */
    const enableBody = (conn: ConnectionDTO) => ({
        id: conn.id,
        provider: conn.provider,
        name: conn.name,
        ...(conn.configJson ? { configJson: conn.configJson } : {}),
        isEnabled: true,
    });

    const handleEnableInternal = async () => {
        setMessage(null);
        try {
            for (const ip of internalProviders) {
                const own = connections.filter((c) => c.provider === ip.id);
                if (own.some((c) => c.isEnabled)) continue;
                // A check that EXISTS but is disabled is turned back on, not
                // skipped (#4466). The button shows because this provider has
                // no enabled connection, so skipping it left the button doing
                // nothing, saying it had worked, and still showing.
                const existing = own[0];
                const res = await fetch(apiUrl('/admin/integrations'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(
                        existing
                            ? enableBody(existing)
                            : { provider: ip.id, name: ip.displayName, configJson: {} },
                    ),
                });
                if (!res.ok) {
                    const body = await res.json().catch(() => null);
                    setMessage({ type: 'error', text: apiErrorMessage(body, t('integrations.internalEnableFailed')) });
                    await fetchConnections();
                    return;
                }
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
            const res = await fetch(apiUrl('/admin/integrations'), {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ connectionId }),
            });
            // A refusal used to read "Connection disabled" — only a network
            // throw reached the red branch (#4466).
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                setMessage({ type: 'error', text: apiErrorMessage(body, t('integrations.disableFailed')) });
                return;
            }
            setMessage({ type: 'success', text: t('integrations.connectionDisabled') });
            await fetchConnections();
        } catch {
            setMessage({ type: 'error', text: t('integrations.disableFailed') });
        }
    };

    /**
     * Turn a disabled connection back on. Saving the edit form used to do this
     * as a side effect — the body never carried `isEnabled`, and the server
     * reads its absence as `true` — which was also the only way back. The form
     * now keeps the state it was opened with, so enabling is its own action,
     * in the place Disable was.
     */
    const handleEnable = async (conn: ConnectionDTO) => {
        setMessage(null);
        try {
            const res = await fetch(apiUrl('/admin/integrations'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(enableBody(conn)),
            });
            if (!res.ok) {
                // e.g. the one-enabled-HRIS refusal, which names the
                // connection holding the slot.
                const body = await res.json().catch(() => null);
                setMessage({ type: 'error', text: apiErrorMessage(body, t('integrations.enableFailed')) });
                return;
            }
            setMessage({ type: 'success', text: t('integrations.connectionEnabled') });
            await fetchConnections();
        } catch {
            setMessage({ type: 'error', text: t('integrations.enableFailed') });
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

                {/* Where the Entra consent for a tool server connection ended.
                    Top of the page, because the callback lands the admin here. */}
                {consentOutcome && (
                    <InlineNotice variant={CONSENT_NOTICE_VARIANT[consentOutcome]} data-testid="consent-result">
                        {t(`integrations.consentResult.${consentOutcome}`)}
                    </InlineNotice>
                )}

                {/* SP-1 — SharePoint connection (delegated consent, separate
                    from the generic config-field connections below). */}
                <SharePointCard />

                {/* The agent engine setting used to be a card here. It moved to
                    AI features (owner decision 2026-10-25, #4139), so the
                    column has one control. The link stays because this is
                    where people learned to look for it. */}
                <p className="text-sm text-content-muted" data-testid="agent-engines-moved">
                    {t('integrations.agentEnginesMoved')}{' '}
                    <Link href={tenantHref('/admin/ai-features#agent-engines')} className="text-content-link">
                        {t('integrations.agentEnginesLink')}
                    </Link>
                </p>

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
                                        <Heading level={3}>{providerLabel(p.id)}</Heading>
                                        <p className="text-xs text-content-subtle mt-0.5 line-clamp-2">{p.description}</p>
                                    </div>
                                    {p.supportedChecks.length > 0 && (
                                        <div className="flex flex-wrap gap-1">
                                            {p.supportedChecks.slice(0, 3).map((check) => (
                                                <StatusBadge variant="neutral" key={check}>{checkLabel(check)}</StatusBadge>
                                            ))}
                                            {p.supportedChecks.length > 3 && (
                                                <span className="text-xs text-content-subtle self-center">+{p.supportedChecks.length - 3}</span>
                                            )}
                                        </div>
                                    )}
                                    {canConfigure && (
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
                                    )}
                                </div>
                                ))}
                                </div>
                            </div>
                            );
                        })}
                        </div>
                    </div>
                )}

                {!canConfigure && (
                    <InlineNotice variant="info" data-testid="integrations-manage-refused">
                        {t('integrations.manageRefusedNotice')}
                    </InlineNotice>
                )}

                {/* Message banner — the last action's result. */}
                {message && (
                    <InlineNotice variant={message.type} data-testid="integrations-message">
                        {message.text}
                    </InlineNotice>
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
                            {canConfigure && internalProviders.length > 0 && !allInternalEnabled && (
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
                            {canConfigure && (
                                <Button
                                    variant="primary"
                                    icon={<Plus className="-ml-0.5 -mr-2.5" />}
                                    onClick={() => { resetForm(); setShowForm(true); }}
                                    id="add-integration-btn"
                                >
                                    {t('integrations.addButton')}
                                </Button>
                            )}
                        </div>
                    </div>

                    {/* ── LOADING AND EMPTY BELONG TO THE TABLE (#4482) ──────────
                        Both were ad-hoc `p-8` divs rendered INSTEAD of the
                        table. The loading one is ~105px tall and the loaded
                        table is several times that, so the section GREW when
                        the fetch resolved and everything below it moved down —
                        measured as CLS 0.155 on this route, the only one of
                        three sampled that was outside "good", and the only one
                        reporting three LCP candidates.

                        `DataTable` owns both states: `loading` draws an
                        `absolute inset-0` overlay that adds no height, and a
                        zero-row table carries a `min-h-[400px]` floor
                        (`table.tsx`), so the box is reserved before the data
                        arrives. The GUIDE says this outright — "use `loading`
                        prop instead of `SkeletonTableRow`" and "do NOT create
                        ad-hoc loading/empty states".

                        `loadError` stays a branch of its own: an unreadable
                        list is not an empty one, and `DataTable`'s `error`
                        replaces the table rather than overlaying it, which is
                        right for an error and wrong for a load.

                        The `sr-only` announcement below is KEPT, deliberately.
                        It was inside the spinner div, so deleting that removed
                        it — a screen reader then had no signal that the table
                        was loading at all. It is also what
                        `tests/rendered/admin-integrations-page` waits on
                        (`renderPage` waits for "Fetching integrations" to
                        disappear), and without it that wait resolved instantly
                        and five tests queried rows that had not arrived. An
                        `sr-only` span is position-absolute and clipped, so it
                        costs no layout height and does not reintroduce the
                        shift. */}
                    {loading && <span className="sr-only">{t('integrations.fetching')}</span>}
                    {loadError ? (
                        <InlineNotice variant="error" data-testid="integrations-load-error">
                            {loadError}
                        </InlineNotice>
                    ) : (
                        (() => {
                            const connCols = createColumns<ConnectionDTO>([
                                { accessorKey: 'provider', header: t('integrations.colProvider'), cell: ({ getValue }) => <StatusBadge variant="info">{providerLabel(String(getValue()))}</StatusBadge> },
                                { accessorKey: 'name', header: t('integrations.colName'), cell: ({ getValue }) => <span className="font-medium">{getValue()}</span> },
                                {
                                    id: 'status', header: t('integrations.colStatus'), accessorKey: 'isEnabled',
                                    cell: ({ row }) => <StatusBadge variant={row.original.isEnabled ? 'success' : 'error'}>{row.original.isEnabled ? t('integrations.statusActive') : t('integrations.statusDisabled')}</StatusBadge>,
                                },
                                // No Secrets column: it rendered the same eight
                                // dots on every row, internal checks with no
                                // secret included, off an API `hasSecret` that
                                // was a constant `true` (#4466; the flag is
                                // real since #4581, the column stays gone).
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
                                            {/* Not offered on a disabled connection, which the
                                                sync refuses ("not found or disabled") — the row's
                                                Enable action is the way back (#4466). */}
                                            {canOperate && row.original.isEnabled && (
                                                <Tooltip content={t('integrations.syncNow')}>
                                                    <Button variant="secondary" size="xs" onClick={() => handleSyncNow(row.original.id)} disabled={syncingId === row.original.id} aria-label={t('integrations.syncNow')} id={`sync-${row.original.id}-btn`}>
                                                        <RefreshCw className={cn('w-3.5 h-3.5', syncingId === row.original.id && 'animate-spin')} />
                                                    </Button>
                                                </Tooltip>
                                            )}
                                            <Tooltip content={t('integrations.viewOutcomes')}>
                                                <Link href={tenantHref(`/admin/integrations/${row.original.id}`)} aria-label={t('integrations.viewOutcomes')} className={buttonVariants({ variant: 'secondary', size: 'xs' })}>
                                                    <Activity className="w-3.5 h-3.5" />
                                                </Link>
                                            </Tooltip>
                                            {canOperate && (
                                                <Tooltip content={t('integrations.testConnection')}>
                                                    <Button variant="secondary" size="xs" onClick={() => handleTest(row.original)} disabled={testing === row.original.id} aria-label={t('integrations.testConnection')}>
                                                        {testing === row.original.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
                                                    </Button>
                                                </Tooltip>
                                            )}
                                            {canConfigure && row.original.provider === 'mcp-server' && (
                                                <Tooltip content={t('integrations.authorizeEntra')}>
                                                    <Button variant="secondary" size="xs" onClick={() => handleAuthorize(row.original)} disabled={authorizing === row.original.id} aria-label={t('integrations.authorizeEntra')}>
                                                        {authorizing === row.original.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
                                                    </Button>
                                                </Tooltip>
                                            )}
                                            {canConfigure && (
                                                <Tooltip content={t('integrations.editConnection')}>
                                                    <Button variant="secondary" size="xs" onClick={() => handleEdit(row.original)} aria-label={t('integrations.editConnection')}>
                                                        <Pencil className="w-3.5 h-3.5" />
                                                    </Button>
                                                </Tooltip>
                                            )}
                                            {!canConfigure ? null : row.original.isEnabled ? (
                                                <Tooltip content={t('integrations.disableIntegration')}>
                                                    <Button variant="destructive" size="xs" onClick={() => handleDisable(row.original.id)} aria-label={t('integrations.disableIntegration')}>
                                                        <Trash2 className="w-3.5 h-3.5" />
                                                    </Button>
                                                </Tooltip>
                                            ) : (
                                                <Tooltip content={t('integrations.enableIntegration')}>
                                                    <Button variant="secondary" size="xs" onClick={() => handleEnable(row.original)} aria-label={t('integrations.enableIntegration')} id={`enable-${row.original.id}-btn`}>
                                                        <CheckCircle className="w-3.5 h-3.5" />
                                                    </Button>
                                                </Tooltip>
                                            )}
                                        </div>
                                    ),
                                },
                            ]);
                            return (
                                <DataTable
                                    data={listedConnections}
                                    columns={connCols}
                                    loading={loading}
                                    getRowId={(c) => c.id}
                                    // Every action is per row; nothing acts on a selection.
                                    selectionEnabled={false}
                                    emptyState={t(canConfigure ? 'integrations.emptyConfigured' : 'integrations.emptyConfiguredReadOnly')}
                                    resourceName={(p) => p ? t('integrations.resourceConnections') : t('integrations.resourceConnection')}
                                    data-testid="integrations-table"
                                />
                            );
                        })()
                    )}
                </div>

                {/* GAP-3 — per-connection freshness (self-renders only when
                    there is at least one enabled connection). */}
                <ConnectionHealthPanel providerLabel={providerLabel} />

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
                                selected={connectableProviders.map(p => ({ value: p.id, label: providerLabel(p.id) })).find(o => o.value === formProvider) ?? null}
                                setSelected={(opt) => { setFormProvider(opt?.value ?? ''); setFormConfig({}); setFormSecrets({}); }}
                                // P2 — only credential-taking providers are selectable here; the
                                // internal (personnel/device/training) check providers are enabled
                                // via the "Enable internal checks" button, not this free-form form.
                                // The picker names providers as the catalogue does (#4466).
                                options={connectableProviders.map(p => ({ value: p.id, label: providerLabel(p.id) }))}
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
                                            {checkLabel(check)}
                                        </StatusBadge>
                                    ))}
                                </div>
                                {/* The automation keys, as keys: a control is wired to a
                                    check by typing one into its Automation key field, so
                                    this is the one place the code is the useful form. */}
                                {selectedProvider.supportedChecks.length > 0 && (
                                    <p className="text-xs text-content-subtle mt-1" data-testid="automation-keys">
                                        {t('integrations.automationKeysHint')}{' '}
                                        {selectedProvider.supportedChecks.map((check, i) => (
                                            <span key={check}>
                                                {i > 0 && ', '}
                                                <code className="font-mono">{selectedProvider.id}.{check}</code>
                                            </span>
                                        ))}
                                    </p>
                                )}
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
