'use client';

/* TODO(swr-migration): fetch-on-mount + setState pattern (matches the
 * sibling admin/sso page). Migrate to useTenantSWR with that page. */

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { useTenantApiUrl, usePermissions } from '@/lib/tenant-context-provider';
import { apiErrorMessage } from '@/lib/api-error';
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
    // Setting the provider up, and changing its directory or client ID, is
    // Owner-tier (src/app-layer/usecases/entra-provider.ts). The server refuses
    // it either way; this keeps an Admin from typing what they cannot save.
    const canChangeDirectory = usePermissions().admin.owner_management;
    const [config, setConfig] = useState<EntraConfig>(EMPTY);
    const [configured, setConfigured] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/sso/entra'));
            if (!res.ok) return;
            const data = await res.json();
            if (data?.config) {
                setConfig({ ...EMPTY, ...data.config });
                setConfigured(true);
            }
        } catch {
            /* read-only load; ignore */
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
                setError(apiErrorMessage(body, t('entra.saveFailedGuids')));
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

    return (
        <div className="space-y-section">
            <BackAffordance />
            <PageBreadcrumbs items={[{ label: t('crumb.admin') }, { label: t('entra.crumbSelf') }]} />
            <div className="flex items-center gap-default">
                <Heading level={1}>{t('entra.title')}</Heading>
                {configured && (
                    <span className="inline-flex items-center gap-tight text-sm text-content-muted">
                        {t('entra.configured')}
                    </span>
                )}
            </div>
            <IdentityCrossLinks current="entra" />

            {/* Step 1 + 2 — setup instructions the tenant admin performs in Entra */}
            <Card className="space-y-default p-6">
                <Heading level={3}>{t('entra.step1Title')}</Heading>
                <ol className="list-decimal space-y-tight pl-5 text-sm text-content-muted">
                    <li>
                        Create an App Registration in the Entra portal; set the redirect URI to{' '}
                        <code>{`{IC_URL}`}/api/auth/callback/microsoft-entra-id</code>.
                    </li>
                    <li>
                        In <strong>Token configuration</strong>, add a <strong>groups</strong> claim set to
                        <strong> Security groups</strong> (manifest{' '}
                        <code>&quot;groupMembershipClaims&quot;: &quot;SecurityGroup&quot;</code>). IC cannot
                        set this for you — without it, no group claims reach IC.
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
                <FormField label={t('entra.appClientId')}>
                    <Input
                        id="clientId"
                        disabled={!canChangeDirectory}
                        placeholder="00000000-0000-0000-0000-000000000000"
                        value={config.clientId}
                        onChange={(e) => setConfig((c) => ({ ...c, clientId: e.target.value }))}
                    />
                </FormField>
                <FormField label={t('entra.allowedDomains')}>
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
                        disabled={saving || (!configured && !canChangeDirectory)}
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
