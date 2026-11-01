'use client';

/* TODO(swr-migration): fetch-on-mount + setState pattern (matches the
 * sibling admin/sso page). Migrate to useTenantSWR with that page. */

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { useTenantApiUrl, useTenantHref, usePermissions } from '@/lib/tenant-context-provider';
import { apiErrorMessage, validationIssueFields } from '@/lib/api-error';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { IdentityCrossLinks } from '@/components/admin/IdentityCrossLinks';
import { GroupMappingsSection } from './GroupMappingsSection';

interface EntraConfig {
    aadTenantId: string;
    clientId: string;
    groupClaimMode: 'securityGroup' | 'applicationRole';
    enforceGroupGate: boolean;
    allowedDomains?: string[];
}

/** What the GET says about the Microsoft app this deployment signs in with. */
interface SignInApp {
    clientId: string | null;
    redirectUri: string | null;
}

const EMPTY: EntraConfig = {
    aadTenantId: '',
    clientId: '',
    groupClaimMode: 'securityGroup',
    enforceGroupGate: false,
    allowedDomains: [],
};

export default function EntraProviderWizard() {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    // Setting the provider up, and changing its directory or client ID, is
    // Owner-tier (src/app-layer/usecases/entra-provider.ts). The server refuses
    // it either way; this keeps an Admin from typing what they cannot save.
    const canChangeDirectory = usePermissions().admin.owner_management;
    const [config, setConfig] = useState<EntraConfig>(EMPTY);
    const [configured, setConfigured] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // A failed read is not "not configured" (#4869): saving over a provider
    // the page could not read would replace it blind, so Save waits.
    const [loadError, setLoadError] = useState(false);
    const [signInApp, setSignInApp] = useState<SignInApp | null>(null);

    const load = useCallback(async () => {
        setLoadError(false);
        try {
            const res = await fetch(apiUrl('/sso/entra'));
            if (!res.ok) {
                setLoadError(true);
                return;
            }
            const data = await res.json();
            setSignInApp(data?.signInApp ?? null);
            if (data?.config) {
                setConfig({ ...EMPTY, ...data.config });
                setConfigured(true);
            }
        } catch {
            setLoadError(true);
        }
    }, [apiUrl]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { void load(); }, [load]);

    const save = useCallback(async () => {
        setSaving(true);
        setError(null);
        setSaved(false);
        try {
            const res = await fetch(apiUrl('/sso/entra'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...config,
                    allowedDomains: (config.allowedDomains ?? []).filter(Boolean),
                }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                const paths = validationIssueFields(body);
                setError(
                    paths.includes('aadTenantId') || paths.includes('clientId')
                        ? t('entra.saveFailedGuids')
                        : paths.length > 0
                          ? t('entra.saveFailedInvalid')
                          : apiErrorMessage(body, t('entra.saveFailed')),
                );
                return;
            }
            setConfigured(true);
            setSaved(true);
        } catch {
            setError(t('entra.saveFailedNetwork'));
        } finally {
            setSaving(false);
        }
    }, [apiUrl, config, t]);

    const signInClientId = signInApp?.clientId ?? null;
    const redirectUri = signInApp?.redirectUri ?? null;
    const clientIdIsNotSignInApp =
        !!signInClientId &&
        config.clientId.trim() !== '' &&
        config.clientId.trim().toLowerCase() !== signInClientId.toLowerCase();

    return (
        <div className="space-y-section">
            <BackAffordance />
            <PageBreadcrumbs
                items={[
                    { label: t('crumb.dashboard'), href: tenantHref('/dashboard') },
                    { label: t('crumb.admin'), href: tenantHref('/admin') },
                    { label: t('entra.crumbSelf') },
                ]}
            />
            <div className="flex items-center gap-default">
                <Heading level={1}>{t('entra.title')}</Heading>
                {configured && (
                    <span className="inline-flex items-center gap-tight text-sm text-content-muted">
                        {t('entra.configured')}
                    </span>
                )}
            </div>
            <IdentityCrossLinks current="entra" />

            {loadError && (
                <InlineNotice variant="error" id="entra-load-error">
                    {t('entra.loadFailed')}
                </InlineNotice>
            )}

            {/* Step 1 — the Microsoft app people sign in through (#4869).
                On the shared deployment that is Inflect's own app, so an
                administrator consents to it rather than creating one; on a
                deployment the customer runs, it is their registration. */}
            <Card className="space-y-default p-6">
                <Heading level={3}>{t('entra.step1Title')}</Heading>
                <p className="text-sm text-content-muted">{t('entra.signInApp.consent')}</p>
                {signInClientId && (
                    <p className="text-sm text-content-muted">
                        {t('entra.signInApp.appIdLabel')}{' '}
                        <code id="entra-sign-in-app-id">{signInClientId}</code>
                    </p>
                )}
                <p className="text-sm text-content-muted">{t('entra.signInApp.groups')}</p>
                <p className="text-sm font-medium text-content-emphasis">{t('entra.signInApp.selfHostedTitle')}</p>
                <ol className="list-decimal space-y-tight pl-5 text-sm text-content-muted">
                    <li>
                        {t('entra.signInApp.selfHostedRedirect')}{' '}
                        <code id="entra-redirect-uri">{redirectUri ?? '/api/auth/callback/microsoft-entra-id'}</code>
                    </li>
                    <li>
                        {t('entra.signInApp.selfHostedGroups')}{' '}
                        <code>&quot;groupMembershipClaims&quot;: &quot;SecurityGroup&quot;</code>
                    </li>
                </ol>
                <a
                    className="inline-flex items-center gap-tight text-sm text-content-link"
                    href="https://entra.microsoft.com"
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    {t('entra.openPortal')}
                </a>
            </Card>

            {/* Step 3 — provider config form */}
            <Card className="space-y-default p-6">
                <Heading level={3}>{t('entra.step2Title')}</Heading>
                {error && <InlineNotice variant="error">{error}</InlineNotice>}
                {saved && <InlineNotice variant="success">{t('entra.saved')}</InlineNotice>}
                {!canChangeDirectory && (
                    <InlineNotice variant="info" id="entra-directory-owner-only">
                        {configured ? t('entra.directoryOwnerOnly') : t('entra.setupOwnerOnly')}
                    </InlineNotice>
                )}

                <FormField label={t('entra.directoryId')} hint={t('entra.directoryIdHint')}>
                    <Input
                        id="aadTenantId"
                        disabled={!canChangeDirectory}
                        placeholder="00000000-0000-0000-0000-000000000000"
                        value={config.aadTenantId}
                        onChange={(e) => setConfig((c) => ({ ...c, aadTenantId: e.target.value }))}
                    />
                </FormField>
                <FormField label={t('entra.appClientId')} hint={t('entra.appClientIdHint')}>
                    <Input
                        id="clientId"
                        disabled={!canChangeDirectory}
                        placeholder="00000000-0000-0000-0000-000000000000"
                        value={config.clientId}
                        onChange={(e) => setConfig((c) => ({ ...c, clientId: e.target.value }))}
                    />
                </FormField>
                {clientIdIsNotSignInApp && (
                    <InlineNotice variant="info" id="entra-client-id-not-sign-in-app">
                        {t('entra.clientIdNotSignInApp')}
                    </InlineNotice>
                )}
                <FormField label={t('entra.allowedDomains')} hint={t('entra.allowedDomainsHint')}>
                    <Input
                        id="domains"
                        placeholder="contoso.com, fabrikam.com"
                        value={(config.allowedDomains ?? []).join(', ')}
                        onChange={(e) =>
                            setConfig((c) => ({
                                ...c,
                                allowedDomains: e.target.value.split(',').map((s) => s.trim()),
                            }))
                        }
                    />
                </FormField>
                {/* Group claim mode is fixed to Security groups — Application
                    Roles aren't supported yet (the resolver reads the `groups`
                    claim only); the schema keeps the value for back-compat. */}
                <FormField
                    label={t('entra.enforceGate')}
                    hint={t('entra.enforceGateHint')}
                >
                    <ToggleGroup
                        selected={config.enforceGroupGate ? 'on' : 'off'}
                        selectAction={(v) => setConfig((c) => ({ ...c, enforceGroupGate: v === 'on' }))}
                        options={[
                            { value: 'off', label: t('entra.off') },
                            { value: 'on', label: t('entra.on') },
                        ]}
                    />
                </FormField>

                <div className="flex justify-end pt-default">
                    <Button
                        variant="primary"
                        onClick={save}
                        disabled={saving || loadError || (!configured && !canChangeDirectory)}
                        id="entra-save-btn"
                    >
                        {saving ? t('entra.saving') : t('entra.save')}
                    </Button>
                </div>
            </Card>

            {/* Step 3 — group → role mappings (EI-2) */}
            <GroupMappingsSection apiUrl={apiUrl} />
        </div>
    );
}
