'use client';
/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

import { formatDate } from '@/lib/format-date';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { CloudCog, Trash2, Copy, Check, AlertTriangle, Clock, ExternalLink } from 'lucide-react';
import { useToast } from '@/components/ui/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons/nucleo';
import { useCopyToClipboard } from '@/components/ui/hooks';
import { CopyButton } from '@/components/ui/copy-button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { Card, cardVariants } from '@/components/ui/card';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { IdentityCrossLinks } from '@/components/admin/IdentityCrossLinks';

interface ScimToken {
    id: string;
    label: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
    createdAt: string;
}

interface ScimState {
    tokens: ScimToken[];
    scimEndpoint: string;
    isEnabled: boolean;
}

export default function ScimAdminPage() {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const [state, setState] = useState<ScimState | null>(null);
    const [loading, setLoading] = useState(true);
    const [generating, setGenerating] = useState(false);
    const [newTokenPlaintext, setNewTokenPlaintext] = useState<string | null>(null);
    const [newLabel, setNewLabel] = useState('');
    const [showForm, setShowForm] = useState(false);
    const { copy, copied } = useCopyToClipboard({ timeout: 2500 });
    const toast = useToast();
    const [error, setError] = useState<string | null>(null);
    const [tokenIdToRevoke, setTokenIdToRevoke] = useState<string | null>(null);

    const fetchTokens = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/admin/scim'));
            if (res.ok) {
                setState(await res.json());
            } else if (res.status === 401 || res.status === 403) {
                setError(t('scim.errNoPermission'));
            } else {
                setError(t('scim.errLoadStatus', { status: res.status }));
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : t('scim.errLoad'));
        } finally {
            setLoading(false);
        }
    }, [apiUrl, t]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchTokens(); }, [fetchTokens]);

    const generateToken = async () => {
        setGenerating(true);
        setError(null);
        try {
            const res = await fetch(apiUrl('/admin/scim'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ label: newLabel || 'SCIM Token' }),
            });
            if (!res.ok) throw new Error(t('scim.errGenerate'));
            const data = await res.json();
            setNewTokenPlaintext(data.plaintext);
            setShowForm(false);
            setNewLabel('');
            fetchTokens();
        } catch (e) {
            setError(e instanceof Error ? e.message : t('scim.errGeneric'));
        } finally {
            setGenerating(false);
        }
    };

    const revokeToken = (tokenId: string) => setTokenIdToRevoke(tokenId);

    const performRevoke = async (tokenId: string) => {
        try {
            await fetch(apiUrl('/admin/scim'), {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tokenId }),
            });
            fetchTokens();
        } catch { /* ignore */ }
    };

    const copyToken = async () => {
        if (!newTokenPlaintext) return;
        const ok = await copy(newTokenPlaintext);
        if (ok) {
            toast.success(t('scim.copyToastOk'));
        } else {
            toast.error(t('scim.copyToastFail'));
        }
    };

    const activeTokens = state?.tokens.filter(t => !t.revokedAt) || [];
    const revokedTokens = state?.tokens.filter(t => t.revokedAt) || [];

    return (
        <div className="space-y-section animate-fadeIn max-w-4xl">
            <BackAffordance />
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <PageBreadcrumbs
                        items={[
                            { label: t('crumb.dashboard'), href: tenantHref('/dashboard') },
                            { label: t('crumb.admin'), href: tenantHref('/admin') },
                            { label: t('scim.crumbSelf') },
                        ]}
                        className="mb-1"
                    />
                    <Heading level={1} className="flex items-center gap-tight">
                        <CloudCog className="w-6 h-6 text-[var(--brand-default)]" />
                        {t('scim.title')}
                    </Heading>
                    <p className="text-sm text-content-muted mt-1">
                        {t('scim.subtitle')}
                    </p>
                    <div className="mt-3">
                        <IdentityCrossLinks current="scim" />
                    </div>
                </div>
                <div className={`px-3 py-1 rounded-full text-xs font-medium ${
                    activeTokens.length > 0
                        ? 'bg-bg-success text-content-success border border-border-success'
                        : 'bg-bg-elevated/50 text-content-muted border border-border-emphasis'
                }`}>
                    {activeTokens.length > 0 ? t('scim.enabled') : t('scim.notConfigured')}
                </div>
            </div>

            {/* Endpoint Info — render the slot eagerly so #scim-endpoint-url
                is queryable before the GET /admin/scim fetch resolves. */}
            <div className={cardVariants({ density: 'compact' })}>
                <Heading level={3} className="mb-2">{t('scim.endpointHeading')}</Heading>
                <div className="flex items-center gap-tight bg-bg-default/50 rounded px-3 py-2">
                    <code
                        className="text-xs text-[var(--brand-muted)] flex-1 select-all min-h-[1.25rem] inline-block"
                        id="scim-endpoint-url"
                    >
                        {state?.scimEndpoint ?? (loading ? t('scim.loadingEndpoint') : '—')}
                    </code>
                    <CopyButton
                        value={state?.scimEndpoint ?? ''}
                        label={t('scim.copyEndpoint')}
                        successMessage={t('scim.copyEndpointOk')}
                        size="sm"
                        disabled={!state?.scimEndpoint}
                    />
                    <ExternalLink className="w-3.5 h-3.5 text-content-subtle" />
                </div>
                <p className="text-xs text-content-subtle mt-1">
                    {t('scim.endpointHint')}
                </p>
            </div>

            {/* New Token Alert - Only shown once */}
            {newTokenPlaintext && (
                <InlineNotice
                    variant="warning"
                    icon={AlertTriangle}
                    id="new-token-alert"
                    title={t('scim.newTokenTitle')}
                    className="flex-col items-stretch p-4"
                >
                    <p className="text-xs text-content-warning">
                        {t('scim.newTokenBody')}
                    </p>
                    <div className="flex items-center gap-tight mt-3 bg-bg-page/60 rounded px-3 py-2">
                        <code className="text-xs text-content-emphasis flex-1 break-all select-all" id="scim-token-value">
                            {newTokenPlaintext}
                        </code>
                        <Button variant="secondary" size="sm" onClick={copyToken} className="shrink-0" id="copy-token-btn">
                            {copied ? <Check className="w-3.5 h-3.5 text-content-success" /> : <Copy className="w-3.5 h-3.5" />}
                            {copied ? t('scim.copied') : t('scim.copy')}
                        </Button>
                    </div>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setNewTokenPlaintext(null)}
                        className="mt-3 w-full"
                    >
                        {t('scim.dismissCopied')}
                    </Button>
                </InlineNotice>
            )}

            {/* Token List */}
            <div className={cardVariants({ density: 'none' })}>
                <div className="flex items-center justify-between p-4 border-b border-border-default/50">
                    <Heading level={3}>{t('scim.tokensHeading')}</Heading>
                    <Button
                        variant="primary"
                        icon={<Plus className="-ml-0.5 -mr-2.5" />}
                        onClick={() => setShowForm(true)}
                        id="generate-token-btn"
                        disabled={generating}
                    >
                        {t('scim.tokenBtn')}
                    </Button>
                </div>

                {/* Generate form */}
                {showForm && (
                    <div className="p-4 border-b border-border-default/50 bg-bg-default/30">
                        <div className="flex gap-tight">
                            <input
                                type="text"
                                value={newLabel}
                                onChange={e => setNewLabel(e.target.value)}
                                placeholder={t('scim.tokenLabelPlaceholder')}
                                className="input flex-1"
                                id="token-label-input"
                                autoFocus
                            />
                            <Button variant="primary" size="sm" onClick={generateToken} disabled={generating} loading={generating}>
                                {generating ? t('scim.generating') : t('scim.create')}
                            </Button>
                            <Button variant="secondary" size="sm" onClick={() => setShowForm(false)}>
                                {t('scim.cancel')}
                            </Button>
                        </div>
                    </div>
                )}

                {error && (
                    <div className="p-3 text-xs text-content-error bg-bg-error border-b border-border-error">
                        {error}
                    </div>
                )}

                {loading ? (
                    <div className="p-8 text-center text-content-subtle text-sm"><span className="animate-pulse">{t('scim.fetching')}</span></div>
                ) : activeTokens.length === 0 && !showForm ? (
                    <div className="p-8 text-center">
                        <CloudCog className="w-8 h-8 text-content-subtle mx-auto mb-2" />
                        <p className="text-sm text-content-muted">{t('scim.noActive')}</p>
                        <p className="text-xs text-content-subtle mt-1">
                            {t('scim.emptyTokensHint')}
                        </p>
                    </div>
                ) : (
                    <div className="divide-y divide-border-default/50">
                        {activeTokens.map(token => (
                            <div key={token.id} className="flex items-center justify-between p-4">
                                <div>
                                    <div className="flex items-center gap-tight">
                                        <span className="text-sm font-medium text-content-emphasis">{token.label}</span>
                                        <StatusBadge variant="success" size="sm">{t('scim.active')}</StatusBadge>
                                    </div>
                                    <div className="flex items-center gap-compact mt-1">
                                        <span className="text-xs text-content-subtle">
                                            {t('scim.created', { date: formatDate(token.createdAt) })}
                                        </span>
                                        {token.lastUsedAt && (
                                            <span className="text-xs text-content-muted flex items-center gap-1">
                                                <Clock className="w-3.5 h-3.5" />
                                                {t('scim.lastUsed', { date: formatDate(token.lastUsedAt) })}
                                            </span>
                                        )}
                                    </div>
                                </div>
                                <Button
                                    variant="destructive"
                                    size="sm"
                                    onClick={() => revokeToken(token.id)}
                                >
                                    <Trash2 className="w-3.5 h-3.5" />
                                    {t('scim.revoke')}
                                </Button>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Revoked tokens */}
            {revokedTokens.length > 0 && (
                <details className={cardVariants({ density: 'none' })}>
                    <summary className="p-4 cursor-pointer text-sm text-content-muted hover:text-content-default">
                        {t('scim.revokedCount', { count: revokedTokens.length })}
                    </summary>
                    <div className="divide-y divide-border-default/50 border-t border-border-default/50">
                        {revokedTokens.map(token => (
                            <div key={token.id} className="flex items-center justify-between p-4 opacity-50">
                                <div>
                                    <span className="text-sm text-content-muted">{token.label}</span>
                                    <StatusBadge variant="error" size="sm" className="ml-2">{t('scim.revoked')}</StatusBadge>
                                    <div className="text-xs text-content-subtle mt-1">
                                        {t('scim.revokedOn', { date: formatDate(token.revokedAt!) })}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </details>
            )}

            {/* Setup guide */}
            <Card>
                <Heading level={3} className="mb-3">{t('scim.setupHeading')}</Heading>
                <ol className="space-y-tight text-xs text-content-muted list-decimal list-inside">
                    <li>{t('scim.setup1')}</li>
                    <li>{t('scim.setup2')}</li>
                    <li>{t.rich('scim.setup3', { b: (c) => <strong>{c}</strong> })}</li>
                    <li>{t.rich('scim.setup4', { b: (c) => <strong>{c}</strong> })}</li>
                    <li>{t.rich('scim.setupActions', { i: (c) => <em>{c}</em> })}</li>
                    <li>{t('scim.setup5')}</li>
                </ol>
                <div className="mt-4 p-3 bg-bg-default/50 rounded text-xs text-content-subtle">
                    {t.rich('scim.roleMapBody', {
                        b: (c) => <strong className="text-content-muted">{c}</strong>,
                        s: (c) => <strong>{c}</strong>,
                    })}
                </div>
            </Card>
            <ConfirmDialog
                showModal={tokenIdToRevoke !== null}
                setShowModal={(open) => {
                    if (typeof open === 'function') {
                        const next = open(tokenIdToRevoke !== null);
                        if (!next) setTokenIdToRevoke(null);
                    } else if (!open) {
                        setTokenIdToRevoke(null);
                    }
                }}
                tone="danger"
                title={t('scim.revokeTitle')}
                description={t('scim.revokeDesc')}
                confirmLabel={t('scim.revokeConfirm')}
                onConfirm={async () => {
                    if (tokenIdToRevoke) await performRevoke(tokenIdToRevoke);
                }}
            />
        </div>
    );
}
