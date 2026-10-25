'use client';

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { apiErrorMessage } from '@/lib/api-error';
import { Card, cardVariants } from '@/components/ui/card';
import { useTenantApiUrl, useTenantHref, usePermissions } from '@/lib/tenant-context-provider';
import { Shield, ExternalLink, Trash2, Save, Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { InfoTooltip } from '@/components/ui/tooltip';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { IdentityCrossLinks } from '@/components/admin/IdentityCrossLinks';
import { cn } from '@inflect/ui/lib/cn';

interface SsoProvider {
    id: string;
    type: 'SAML' | 'OIDC';
    name: string;
    isEnabled: boolean;
    isEnforced: boolean;
    emailDomains: string[];
    configJson: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
}

type Tab = 'OIDC' | 'SAML';

// Hoisted to module scope to satisfy react-hooks/static-components.
// Was previously declared inside `SsoAdminPage` and closed over
// `existingProvider`; now takes it as a prop.
function ProviderStatusBadge({
    existingProvider,
    loadFailed,
}: {
    existingProvider: SsoProvider | null | undefined;
    loadFailed: boolean;
}) {
    const t = useTranslations('admin');
    // UNKNOWN BEFORE NOT-CONFIGURED. A failed read leaves `existingProvider`
    // undefined, which is indistinguishable from a workspace that has no
    // provider — so the badge reported "Not Configured" about a workspace it had
    // learned nothing about. Setting the error beside it was not enough: the
    // badge is the thing an administrator reads first, and it was still making a
    // claim. Asked before the absence check because absence is what a failure
    // looks like from here.
    if (loadFailed) {
        return <StatusBadge variant="neutral">{t('sso.statusUnknown')}</StatusBadge>;
    }
    if (!existingProvider) {
        return <StatusBadge variant="neutral">{t('sso.notConfigured')}</StatusBadge>;
    }
    // ENABLED IS ASKED FIRST. `isEnforced` was checked above `isEnabled`, so a
    // provider that is enforced-but-disabled read "Enforced" — and enforcement
    // applies only to an enabled provider (`lib/auth/sso-enforcement.ts`), so
    // the badge claimed local login was closed when it was open. The two flags
    // are stored independently, which is what makes that state reachable.
    if (existingProvider.isEnforced && existingProvider.isEnabled) {
        return <StatusBadge variant="warning">{t('sso.enforced')}</StatusBadge>;
    }
    if (existingProvider.isEnabled) {
        return <StatusBadge variant="info">{t('sso.enabled')}</StatusBadge>;
    }
    return <StatusBadge variant="error">{t('sso.disabled')}</StatusBadge>;
}

export default function SsoAdminPage() {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    // Setting up a provider, and changing whom it trusts, is Owner-tier
    // (src/lib/auth/sso-trust-fields.ts). The server refuses it either way;
    // this keeps an Admin from filling in fields they cannot save.
    const canChangeTrust = usePermissions().admin.owner_management;
    const [providers, setProviders] = useState<SsoProvider[]>([]);
    const [tab, setTab] = useState<Tab>('OIDC');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    /**
     * The last load did not tell us what exists (#4116).
     *
     * Held separately from `error` because it gates the SAVE: an error can be
     * left over from a failed delete, but only an unknown provider list makes a
     * create-vs-update decision unsafe.
     */
    const [loadFailed, setLoadFailed] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

    // ── Form state ──
    const [formName, setFormName] = useState('');
    const [formEmailDomains, setFormEmailDomains] = useState('');
    const [formEnabled, setFormEnabled] = useState(false);
    const [formEnforced, setFormEnforced] = useState(false);
    const [showSecret, setShowSecret] = useState(false);

    // OIDC fields
    const [oidcIssuer, setOidcIssuer] = useState('');
    const [oidcClientId, setOidcClientId] = useState('');
    const [oidcClientSecret, setOidcClientSecret] = useState('');
    const [oidcScopes, setOidcScopes] = useState('openid email profile');

    // SAML fields
    const [samlEntityId, setSamlEntityId] = useState('');
    const [samlSsoUrl, setSamlSsoUrl] = useState('');
    const [samlCertificate, setSamlCertificate] = useState('');
    const [samlNameIdFormat, setSamlNameIdFormat] = useState('');

    /**
     * The translator, reachable from a stable callback.
     *
     * `fetchProviders` is a `useCallback` whose identity feeds
     * `useEffect(…, [fetchProviders])`, so adding `t` to its dependency array
     * would give it a new identity on every render that `t` is not referentially
     * stable for — and the effect calls `fetchProviders`, which calls
     * `setState`, which renders again. That is an infinite refetch, and it is
     * the same defect as #4194 one layer along: an unstable identity feeding an
     * effect that re-subscribes.
     *
     * A ref holds the CURRENT translator behind an identity that never changes,
     * so the callback can use it and still depend only on `apiUrl`.
     */
    const tRef = useRef(t);
    useEffect(() => {
        tRef.current = t;
    }, [t]);

    const fetchProviders = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/sso'));
            if (!res.ok) {
                // A FAILED LOAD IS NOT "NOT CONFIGURED". This swallowed every
                // non-ok response and every throw — the comment said "silently
                // fail" — so a 403 or a 500 left `providers` empty and the page
                // rendered the not-configured badge over a blank form. The
                // dangerous part is the next click: `handleSave` sends
                // `id: existingProvider?.id`, which is `undefined` when the load
                // failed, so the server CREATES a second configuration for a
                // workspace that already had one.
                const body = await res.json().catch(() => ({}));
                setError(apiErrorMessage(body, tRef.current('sso.loadFailed')));
                setLoadFailed(true);
                return;
            }
            const data = await res.json();
            setProviders(data);
            setLoadFailed(false);
        } catch (err) {
            setError(apiErrorMessage(err, tRef.current('sso.loadFailed')));
            setLoadFailed(true);
        } finally {
            setLoading(false);
        }
    }, [apiUrl]);

    // The `react-hooks/set-state-in-effect` suppression that stood here is
    // gone, and its absence is load-bearing rather than tidying: every
    // `setState` in `fetchProviders` now sits behind an `await`, so the rule no
    // longer has anything to report and ESLint flagged the directive as unused.
    // A suppression kept past its cause is a finding the lint ceiling still
    // counts and nobody re-reads.
    useEffect(() => { fetchProviders(); }, [fetchProviders]);

    // ── Load existing provider into form ──
    const existingProvider = providers.find((p) => p.type === tab);

    useEffect(() => {
        if (existingProvider) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setFormName(existingProvider.name);
            setFormEmailDomains(existingProvider.emailDomains.join(', '));
            setFormEnabled(existingProvider.isEnabled);
            setFormEnforced(existingProvider.isEnforced);
            const config = existingProvider.configJson;
            if (existingProvider.type === 'OIDC') {
                setOidcIssuer((config.issuer as string) || '');
                setOidcClientId((config.clientId as string) || '');
                setOidcClientSecret((config.clientSecret as string) || '');
                setOidcScopes(Array.isArray(config.scopes)
                    ? (config.scopes as string[]).join(' ')
                    : 'openid email profile');
            } else {
                setSamlEntityId((config.entityId as string) || '');
                setSamlSsoUrl((config.ssoUrl as string) || '');
                setSamlCertificate((config.certificate as string) || '');
                setSamlNameIdFormat((config.nameIdFormat as string) || '');
            }
        } else {
            resetForm();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tab, existingProvider?.id]);

    function resetForm() {
        setFormName('');
        setFormEmailDomains('');
        setFormEnabled(false);
        setFormEnforced(false);
        setOidcIssuer('');
        setOidcClientId('');
        setOidcClientSecret('');
        setOidcScopes('openid email profile');
        setSamlEntityId('');
        setSamlSsoUrl('');
        setSamlCertificate('');
        setSamlNameIdFormat('');
    }

    // ── Save handler ──
    async function handleSave() {
        setError(null);
        setSuccess(null);
        // REFUSED WHILE THE LIST IS UNKNOWN. The body carries
        // `id: existingProvider?.id` to choose create vs update, so saving after
        // a failed load silently creates a SECOND configuration. Refusing is the
        // fail-closed direction: a reload costs a click, a duplicate identity
        // provider is a workspace with two answers to who it trusts for sign-in.
        if (loadFailed) {
            setError(t('sso.loadFailedSaveBlocked'));
            return;
        }
        setSaving(true);

        const emailDomains = formEmailDomains
            .split(/[,\s]+/)
            .map((d) => d.trim().toLowerCase())
            .filter(Boolean);

        const config = tab === 'OIDC'
            ? {
                issuer: oidcIssuer,
                clientId: oidcClientId,
                // Sent as shown: the mask, if untouched, tells the server to
                // keep the stored secret (SSO_SECRET_MASK).
                clientSecret: oidcClientSecret,
                scopes: oidcScopes.split(/\s+/).filter(Boolean),
            }
            : {
                entityId: samlEntityId,
                ssoUrl: samlSsoUrl,
                certificate: samlCertificate,
                ...(samlNameIdFormat && { nameIdFormat: samlNameIdFormat }),
            };

        try {
            const res = await fetch(apiUrl('/sso'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: existingProvider?.id,
                    name: formName || `${tab} Provider`,
                    type: tab,
                    isEnabled: formEnabled,
                    isEnforced: formEnforced,
                    emailDomains,
                    config,
                }),
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: t('sso.unknownError') }));
                setError(apiErrorMessage(err, t('sso.saveFailed')));
                return;
            }

            setSuccess(t('sso.savedOk'));
            await fetchProviders();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setSaving(false);
        }
    }

    // ── Delete handler ──
    function handleDelete() {
        if (!existingProvider) return;
        setShowDeleteConfirm(true);
    }

    async function performDelete() {
        if (!existingProvider) return;
        setError(null);
        try {
            const res = await fetch(apiUrl('/sso'), {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: existingProvider.id }),
            });
            if (!res.ok) {
                // Only a THROWN error was reported, and a refused delete is a
                // non-ok response rather than a throw — so a 403 left the
                // configuration in place and said nothing at all.
                const body = await res.json().catch(() => ({}));
                setError(apiErrorMessage(body, t('sso.deleteFailed')));
                return;
            }
            resetForm();
            await fetchProviders();
            setSuccess(t('sso.deletedOk'));
        } catch (err) {
            setError(apiErrorMessage(err, t('sso.deleteFailed')));
        }
    }

    // StatusBadge hoisted to module scope (above) — see comment there.

    function testLoginUrl() {
        if (!existingProvider) return null;
        const tenantSlug = window.location.pathname.split('/')[2];
        const protocol = tab.toLowerCase();
        return `/api/auth/sso/${protocol}/start?tenant=${tenantSlug}&provider=${existingProvider.id}&returnTo=${window.location.pathname}`;
    }

    if (loading) {
        return (
            <div className="space-y-section animate-fadeIn">
                <BackAffordance />
                <PageBreadcrumbs
                    items={[
                        { label: t('crumb.dashboard'), href: tenantHref('/dashboard') },
                        { label: t('crumb.admin'), href: tenantHref('/admin') },
                        { label: t('sso.crumbSelf') },
                    ]}
                    className="mb-1"
                />
                <Heading level={2}>{t('sso.loading')}</Heading>
                <Card className="space-y-default">
                    <div className="h-4 bg-bg-elevated/60 rounded w-1/3 animate-pulse" />
                    <div className="h-4 bg-bg-elevated/60 rounded w-2/3 animate-pulse" />
                    <div className="h-4 bg-bg-elevated/60 rounded w-1/2 animate-pulse" />
                </Card>
            </div>
        );
    }

    return (
        <div className="space-y-section animate-fadeIn">
            {/* Header */}
            <div>
                <PageBreadcrumbs
                    items={[
                        { label: t('crumb.dashboard'), href: tenantHref('/dashboard') },
                        { label: t('crumb.admin'), href: tenantHref('/admin') },
                        { label: t('sso.crumbSelf') },
                    ]}
                    className="mb-1"
                />
                <Heading level={1} className="flex items-center gap-tight">
                    <Shield className="w-6 h-6 text-[var(--brand-default)]" />
                    {t('sso.title')}
                </Heading>
                <p className="text-sm text-content-muted mt-1">
                    {t('sso.subtitle')}
                </p>
                <div className="mt-3">
                    <IdentityCrossLinks current="sso" />
                </div>
            </div>

            {/* Protocol tabs — Epic 60 ToggleGroup. `id` on each option
                preserves `#sso-tab-oidc` / `#sso-tab-saml` DOM anchors
                for any future E2E selector use. */}
            <div className="flex items-center gap-tight">
                <ToggleGroup
                    ariaLabel={t('sso.protocolAria')}
                    options={[
                        { value: 'OIDC', label: 'OIDC', id: 'sso-tab-oidc' },
                        { value: 'SAML', label: 'SAML 2.0', id: 'sso-tab-saml' },
                    ]}
                    selected={tab}
                    selectAction={(v) => setTab(v as 'OIDC' | 'SAML')}
                />
                <div className="ml-auto">
                    <ProviderStatusBadge existingProvider={existingProvider} loadFailed={loadFailed} />
                </div>
            </div>

            {/* Messages */}
            {error && (
                <InlineNotice variant="error" id="sso-error">{error}</InlineNotice>
            )}
            {success && (
                <InlineNotice variant="success" id="sso-success">{success}</InlineNotice>
            )}

            {/* Config form */}
            <div className={cardVariants()}>
                <Heading level={2} className="mb-4">{t('sso.configHeading', { tab })}</Heading>

                {!canChangeTrust && (
                    <InlineNotice variant="info" className="mb-4" id="sso-trust-owner-only">
                        {existingProvider ? t('sso.trustOwnerOnly') : t('sso.setupOwnerOnly')}
                    </InlineNotice>
                )}
                {canChangeTrust && existingProvider && (
                    <p className="text-xs text-content-subtle mb-4" id="sso-trust-change-hint">
                        {t('sso.trustChangeUnlinks')}
                    </p>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-default">
                    {/* Provider name */}
                    <div>
                        <label className="text-xs text-content-muted uppercase tracking-wider mb-1 block">
                            {t('sso.providerName')}
                        </label>
                        <input
                            id="sso-name"
                            value={formName}
                            onChange={(e) => setFormName(e.target.value)}
                            placeholder={tab === 'OIDC' ? t('sso.providerNameOidc') : t('sso.providerNameSaml')}
                            className="input w-full"
                        />
                    </div>

                    {/* Email domains */}
                    <div>
                        <label className="text-xs text-content-muted uppercase tracking-wider mb-1 block">
                            {t('sso.emailDomains')}
                        </label>
                        <input
                            id="sso-domains"
                            disabled={!canChangeTrust}
                            value={formEmailDomains}
                            onChange={(e) => setFormEmailDomains(e.target.value)}
                            placeholder="acme.com, acme.io"
                            className="input w-full"
                        />
                        <span className="text-xs text-content-subtle mt-0.5">{t('sso.commaSeparated')}</span>
                    </div>
                </div>

                {/* Protocol-specific fields */}
                {tab === 'OIDC' ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-default mt-4">
                        <div>
                            <label className="text-xs text-content-muted uppercase tracking-wider mb-1 block">{t('sso.issuerUrl')}</label>
                            <input
                                id="sso-oidc-issuer"
                                disabled={!canChangeTrust}
                                value={oidcIssuer}
                                onChange={(e) => setOidcIssuer(e.target.value)}
                                placeholder="https://login.example.com"
                                className="input w-full"
                            />
                        </div>
                        <div>
                            <label className="text-xs text-content-muted uppercase tracking-wider mb-1 block">{t('sso.clientId')}</label>
                            <input
                                id="sso-oidc-client-id"
                                disabled={!canChangeTrust}
                                value={oidcClientId}
                                onChange={(e) => setOidcClientId(e.target.value)}
                                placeholder="client-id-from-idp"
                                className="input w-full"
                            />
                        </div>
                        <div>
                            <label className="text-xs text-content-muted uppercase tracking-wider mb-1 block">{t('sso.clientSecret')}</label>
                            <div className="relative">
                                <input
                                    id="sso-oidc-client-secret"
                                    type={showSecret ? 'text' : 'password'}
                                    value={oidcClientSecret}
                                    onChange={(e) => setOidcClientSecret(e.target.value)}
                                    placeholder="client-secret"
                                    className="input w-full pr-10"
                                />
                                <button
                                    type="button"
                                    // An icon-only control with no text child
                                    // reaches a screen reader as "button".
                                    aria-label={showSecret ? t('sso.hideSecret') : t('sso.showSecret')}
                                    onClick={() => setShowSecret(!showSecret)}
                                    className="absolute right-3 top-1/2 -translate-y-1/2 text-content-muted hover:text-content-emphasis"
                                >
                                    {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                </button>
                            </div>
                        </div>
                        <div>
                            <label className="text-xs text-content-muted uppercase tracking-wider mb-1 block">{t('sso.scopes')}</label>
                            <input
                                id="sso-oidc-scopes"
                                value={oidcScopes}
                                onChange={(e) => setOidcScopes(e.target.value)}
                                placeholder="openid email profile"
                                className="input w-full"
                            />
                        </div>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-default mt-4">
                        <div>
                            <label className="text-xs text-content-muted uppercase tracking-wider mb-1 block">{t('sso.entityId')}</label>
                            <input
                                id="sso-saml-entity-id"
                                disabled={!canChangeTrust}
                                value={samlEntityId}
                                onChange={(e) => setSamlEntityId(e.target.value)}
                                placeholder="https://idp.example.com"
                                className="input w-full"
                            />
                        </div>
                        <div>
                            <label className="text-xs text-content-muted uppercase tracking-wider mb-1 block">{t('sso.ssoUrl')}</label>
                            <input
                                id="sso-saml-sso-url"
                                disabled={!canChangeTrust}
                                value={samlSsoUrl}
                                onChange={(e) => setSamlSsoUrl(e.target.value)}
                                placeholder="https://idp.example.com/saml/sso"
                                className="input w-full"
                            />
                        </div>
                        <div className="md:col-span-2">
                            <label className="text-xs text-content-muted uppercase tracking-wider mb-1 block">{t('sso.certificate')}</label>
                            <textarea
                                id="sso-saml-certificate"
                                disabled={!canChangeTrust}
                                value={samlCertificate}
                                onChange={(e) => setSamlCertificate(e.target.value)}
                                placeholder="MIICzjCCAb..."
                                rows={3}
                                className="input w-full font-mono text-xs"
                            />
                        </div>
                        <div>
                            <div className="mb-1 flex items-center gap-1.5">
                                <label className="text-xs text-content-muted uppercase tracking-wider">{t('sso.nameIdFormat')}</label>
                                <InfoTooltip
                                    aria-label={t('sso.nameIdAria')}
                                    iconClassName="h-3.5 w-3.5"
                                    content={t('sso.nameIdTooltip')}
                                />
                            </div>
                            <input
                                id="sso-saml-nameid"
                                value={samlNameIdFormat}
                                onChange={(e) => setSamlNameIdFormat(e.target.value)}
                                placeholder="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"
                                className="input w-full text-xs"
                            />
                        </div>
                        <div>
                            <label className="text-xs text-content-muted uppercase tracking-wider mb-1 block">{t('sso.acsUrl')}</label>
                            <input
                                readOnly
                                value={typeof window !== 'undefined'
                                    ? `${window.location.origin}/api/auth/sso/saml/callback`
                                    : '/api/auth/sso/saml/callback'}
                                className="input w-full text-xs text-content-subtle cursor-not-allowed"
                            />
                        </div>
                    </div>
                )}

                {/* Toggles */}
                <div className="flex items-center gap-section mt-6 pt-4 border-t border-border-default/50">
                    <label className="flex items-center gap-tight cursor-pointer">
                        <input
                            type="checkbox"
                            checked={formEnabled}
                            onChange={(e) => setFormEnabled(e.target.checked)}
                            className="accent-[var(--brand-default)]"
                            id="sso-enabled"
                        />
                        <span className="text-sm text-content-emphasis">{t('sso.enableSso')}</span>
                    </label>
                    <label className="flex items-center gap-tight cursor-pointer">
                        <input
                            type="checkbox"
                            checked={formEnforced}
                            onChange={(e) => setFormEnforced(e.target.checked)}
                            className="accent-amber-500"
                            id="sso-enforced"
                        />
                        <span className="text-sm text-content-emphasis">{t('sso.enforceSso')}</span>
                        <span className="text-xs text-content-subtle">{t('sso.enforceHint')}</span>
                        <InfoTooltip
                            aria-label={t('sso.enforceAria')}
                            iconClassName="h-3.5 w-3.5"
                            content={t('sso.enforceTooltip')}
                        />
                    </label>
                </div>

                {formEnforced && (
                    <InlineNotice variant="warning" className="mt-3">
                        {t('sso.enforcedNotice')}
                    </InlineNotice>
                )}

                {/* Actions */}
                <div className="flex items-center gap-tight mt-6">
                    <Button
                        variant="primary"
                        onClick={handleSave}
                        // `loadFailed` gates it too: the body chooses create vs
                        // update from `existingProvider`, which a failed load
                        // leaves undefined, so a save would add a SECOND
                        // configuration. Disabled here and refused in the
                        // handler — the handler check is what holds if a future
                        // caller reaches `handleSave` another way.
                        disabled={saving || loadFailed || (!existingProvider && !canChangeTrust)}
                        loading={saving}
                        id="sso-save-btn"
                    >
                        <Save className="w-3.5 h-3.5" />
                        {saving ? t('sso.saving') : t('sso.saveConfig')}
                    </Button>

                    {existingProvider && existingProvider.isEnabled && (
                        <a
                            href={testLoginUrl() || '#'}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={buttonVariants({ variant: 'secondary' })}
                            id="sso-test-btn"
                        >
                            <ExternalLink className="w-3.5 h-3.5" />
                            {t('sso.testLogin')}
                        </a>
                    )}

                    {existingProvider && (
                        <Button
                            variant="destructive"
                            onClick={handleDelete}
                            className="ml-auto"
                            id="sso-delete-btn"
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                            {t('sso.delete')}
                        </Button>
                    )}
                </div>
            </div>

            {/* Info card */}
            <div className={cn(cardVariants({ density: 'compact' }), 'border border-border-default/50')}>
                <Heading level={3} className="mb-2">{t('sso.howTitle')}</Heading>
                <ul className="text-xs text-content-muted space-y-1.5">
                    <li>• {t('sso.how1')}</li>
                    <li>• {t('sso.how2')}</li>
                    <li>• {t('sso.how3')}</li>
                    <li>• {t('sso.how4')}</li>
                </ul>
            </div>
            <ConfirmDialog
                showModal={showDeleteConfirm}
                setShowModal={setShowDeleteConfirm}
                tone="danger"
                title={t('sso.deleteTitle')}
                description={t('sso.deleteDesc')}
                confirmLabel={t('sso.deleteConfirm')}
                onConfirm={performDelete}
            />
        </div>
    );
}
