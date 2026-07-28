'use client';

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Card, cardVariants } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { ShieldCheck, Save, AlertTriangle, LogOut, Users, UserX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InfoTooltip } from '@/components/ui/tooltip';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { cn } from '@/lib/cn';

type MfaPolicy = 'DISABLED' | 'OPTIONAL' | 'REQUIRED';

interface SecuritySettings {
    mfaPolicy: MfaPolicy;
    sessionMaxAgeMinutes: number | null;
}

const POLICY_VALUES: MfaPolicy[] = ['DISABLED', 'OPTIONAL', 'REQUIRED'];

export default function AdminSecurityPage() {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const [settings, setSettings] = useState<SecuritySettings>({ mfaPolicy: 'DISABLED', sessionMaxAgeMinutes: null });
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const [revoking, setRevoking] = useState(false);
    const [revokeUserId, setRevokeUserId] = useState('');

    const fetchSettings = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/security/mfa/policy'));
            if (res.ok) {
                const data = await res.json();
                setSettings(data);
            }
        } catch {
            setError(t('security.failedLoadSettings'));
        } finally {
            setLoading(false);
        }
    }, [apiUrl, t]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchSettings(); }, [fetchSettings]);

    const handleSave = async () => {
        setSaving(true);
        setError(null);
        setSuccess(null);
        try {
            const res = await fetch(apiUrl('/security/mfa/policy'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings),
            });
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || t('security.failedSave'));
            }
            const updated = await res.json();
            setSettings(updated);
            setSuccess(t('security.settingsSaved'));
            setTimeout(() => setSuccess(null), 3000);
        } catch (err) {
            setError(err instanceof Error ? err.message : t('security.failedSaveSettings'));
        } finally {
            setSaving(false);
        }
    };

    const handleRevokeMySessions = async () => {
        if (!confirm(t('security.revokeMyConfirm'))) return;
        setRevoking(true);
        setError(null);
        try {
            const res = await fetch(apiUrl('/security/sessions/revoke-current'), { method: 'POST' });
            if (res.ok) {
                setSuccess(t('security.mySessionsRevoked'));
                setTimeout(() => window.location.href = '/login', 2000);
            } else {
                throw new Error(t('security.failedRevokeSessions'));
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : t('security.revocationFailed'));
        } finally {
            setRevoking(false);
        }
    };

    const handleRevokeAllTenant = async () => {
        if (!confirm(t('security.revokeAllConfirm'))) return;
        setRevoking(true);
        setError(null);
        try {
            const res = await fetch(apiUrl('/security/sessions/revoke-all'), { method: 'POST' });
            const data = await res.json();
            if (res.ok) {
                setSuccess(t('security.allRevoked', { count: data.usersAffected }));
            } else {
                throw new Error(data.error || t('security.failedRevoke'));
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : t('security.bulkRevocationFailed'));
        } finally {
            setRevoking(false);
        }
    };

    const handleRevokeUser = async () => {
        if (!revokeUserId.trim()) return;
        if (!confirm(t('security.revokeUserConfirm', { id: revokeUserId }))) return;
        setRevoking(true);
        setError(null);
        try {
            const res = await fetch(apiUrl('/security/sessions/revoke-user'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetUserId: revokeUserId.trim() }),
            });
            const data = await res.json();
            if (res.ok) {
                setSuccess(t('security.userSessionsRevoked'));
                setRevokeUserId('');
                setTimeout(() => setSuccess(null), 3000);
            } else {
                throw new Error(data.error || t('security.failedRevokeUser'));
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : t('security.userRevocationFailed'));
        } finally {
            setRevoking(false);
        }
    };

    if (loading) {
        return (
            <div className="space-y-section animate-fadeIn">
                <BackAffordance />
                <PageBreadcrumbs
                    items={[
                        { label: t('crumb.dashboard'), href: tenantHref('/dashboard') },
                        { label: t('crumb.admin'), href: tenantHref('/admin') },
                        { label: t('security.crumbSelf') },
                    ]}
                    className="mb-1"
                />
                <Heading level={2} className="flex items-center gap-tight">
                    <ShieldCheck className="w-6 h-6 text-[var(--brand-default)]" />
                    {t('security.loadingTitle')}
                </Heading>
                <Card>
                    <div className="animate-pulse space-y-default">
                        <div className="h-4 bg-bg-elevated rounded w-1/3" />
                        <div className="h-10 bg-bg-elevated rounded w-full" />
                        <div className="h-10 bg-bg-elevated rounded w-full" />
                        <div className="h-10 bg-bg-elevated rounded w-full" />
                    </div>
                </Card>
            </div>
        );
    }

    return (
        <div className="space-y-section animate-fadeIn">
            <div>
                <PageBreadcrumbs
                    items={[
                        { label: t('crumb.dashboard'), href: tenantHref('/dashboard') },
                        { label: t('crumb.admin'), href: tenantHref('/admin') },
                        { label: t('security.crumbSelf') },
                    ]}
                    className="mb-1"
                />
                <Heading level={1} className="flex items-center gap-tight">
                    <ShieldCheck className="w-6 h-6 text-[var(--brand-default)]" />
                    {t('security.title')}
                </Heading>
            </div>

            {error && (
                <InlineNotice variant="error" icon={AlertTriangle}>{error}</InlineNotice>
            )}

            {success && (
                <InlineNotice variant="success">{success}</InlineNotice>
            )}

            {/* MFA Policy Section */}
            <div className={cn(cardVariants(), 'space-y-default')}>
                <div>
                    <div className="flex items-center gap-tight">
                        <Heading level={2}>{t('security.mfaPolicyTitle')}</Heading>
                        <InfoTooltip
                            aria-label={t('security.mfaPolicyTooltipAria')}
                            iconClassName="h-4 w-4"
                            content={t('security.mfaPolicyTooltip')}
                        />
                    </div>
                    <p className="text-sm text-content-muted mt-1">
                        {t('security.mfaPolicyDesc')}
                    </p>
                </div>

                <div className="space-y-compact">
                    {POLICY_VALUES.map((value) => (
                        <label
                            key={value}
                            className={`flex items-start gap-compact p-4 rounded-lg border cursor-pointer transition-all ${
                                settings.mfaPolicy === value
                                    ? 'border-[var(--brand-default)]/60 bg-[var(--brand-subtle)]'
                                    : 'border-border-default hover:border-border-emphasis'
                            }`}
                        >
                            <input
                                type="radio"
                                name="mfaPolicy"
                                value={value}
                                checked={settings.mfaPolicy === value}
                                onChange={() => setSettings(s => ({ ...s, mfaPolicy: value }))}
                                className="mt-1 accent-[var(--brand-default)]"
                            />
                            <div>
                                <span className={`text-sm font-medium ${
                                    settings.mfaPolicy === value ? 'text-[var(--brand-muted)]' : 'text-content-emphasis'
                                }`}>
                                    {t(`security.policy.${value}.label`)}
                                    {value === 'REQUIRED' && (
                                        <StatusBadge variant="warning" className="ml-2">{t('security.strictBadge')}</StatusBadge>
                                    )}
                                </span>
                                <p className="text-xs text-content-muted mt-1">{t(`security.policy.${value}.description`)}</p>
                            </div>
                        </label>
                    ))}
                </div>

                {settings.mfaPolicy === 'REQUIRED' && (
                    <InlineNotice variant="warning" title={t('security.beforeRequiredTitle')}>
                        <ul className="text-xs text-content-warning list-disc pl-4 space-y-1">
                            <li>{t('security.beforeRequired1')}</li>
                            <li>{t('security.beforeRequired2')}</li>
                            <li>{t('security.beforeRequired3')}</li>
                        </ul>
                    </InlineNotice>
                )}
            </div>

            {/* Session Settings */}
            <div className={cn(cardVariants(), 'space-y-default')}>
                <div>
                    <Heading level={2} className="mb-1">{t('security.sessionSettingsTitle')}</Heading>
                    <p className="text-sm text-content-muted">
                        {t('security.sessionSettingsDesc')}
                    </p>
                </div>

                <div>
                    <div className="mb-1 flex items-center gap-1.5">
                        <label className="block text-sm text-content-default">{t('security.maxSessionAgeLabel')}</label>
                        <InfoTooltip
                            aria-label={t('security.maxSessionAgeTooltipAria')}
                            iconClassName="h-3.5 w-3.5"
                            content={t('security.maxSessionAgeTooltip')}
                        />
                    </div>
                    <input
                        type="number"
                        min={5}
                        max={43200}
                        placeholder={t('security.maxSessionAgePlaceholder')}
                        value={settings.sessionMaxAgeMinutes ?? ''}
                        onChange={(e) => {
                            const val = e.target.value ? parseInt(e.target.value, 10) : null;
                            setSettings(s => ({ ...s, sessionMaxAgeMinutes: val }));
                        }}
                        className="input w-full max-w-xs"
                    />
                    <p className="text-xs text-content-subtle mt-1">{t('security.maxSessionAgeHint')}</p>
                </div>
            </div>

            {/* Save Button */}
            <div className="flex justify-end">
                <Button
                    variant="primary"
                    onClick={handleSave}
                    disabled={saving}
                    loading={saving}
                    id="security-save-btn"
                >
                    <Save className="w-4 h-4" />
                    {saving ? t('security.saving') : t('security.saveSettings')}
                </Button>
            </div>

            {/* ──── Session Management ──── */}
            <div className={cn(cardVariants(), 'space-y-default')}>
                <div>
                    <Heading level={2} className="mb-1">{t('security.sessionMgmtTitle')}</Heading>
                    <p className="text-sm text-content-muted">
                        {t('security.sessionMgmtDesc')}
                    </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-compact">
                    {/* Revoke my sessions */}
                    <button
                        onClick={handleRevokeMySessions}
                        disabled={revoking}
                        className="p-4 border border-border-default rounded-lg hover:border-[var(--brand-default)]/50 transition text-left flex items-start gap-compact group"
                        id="revoke-my-sessions-btn"
                    >
                        <LogOut className="w-5 h-5 text-content-muted group-hover:text-[var(--brand-default)] transition mt-0.5 shrink-0" />
                        <div>
                            <span className="text-sm font-medium text-content-emphasis">{t('security.signOutOthers')}</span>
                            <p className="text-xs text-content-subtle mt-1">{t('security.signOutOthersDesc')}</p>
                        </div>
                    </button>

                    {/* Revoke all tenant sessions */}
                    <button
                        onClick={handleRevokeAllTenant}
                        disabled={revoking}
                        className="p-4 border border-border-error rounded-lg hover:border-border-error transition text-left flex items-start gap-compact group"
                        id="revoke-all-sessions-btn"
                    >
                        <Users className="w-5 h-5 text-content-error transition mt-0.5 shrink-0" />
                        <div>
                            <span className="text-sm font-medium text-content-error">{t('security.revokeAll')}</span>
                            <p className="text-xs text-content-subtle mt-1">{t('security.revokeAllDesc')}</p>
                        </div>
                    </button>
                </div>

                {/* Revoke specific user */}
                <div className="border-t border-border-default/50 pt-4">
                    <label className="block text-sm text-content-default mb-2">{t('security.revokeSpecificLabel')}</label>
                    <div className="flex gap-tight">
                        <input
                            type="text"
                            placeholder={t('security.userIdPlaceholder')}
                            value={revokeUserId}
                            onChange={(e) => setRevokeUserId(e.target.value)}
                            className="input flex-1"
                            id="revoke-user-id-input"
                        />
                        <Button
                            variant="destructive"
                            onClick={handleRevokeUser}
                            disabled={revoking || !revokeUserId.trim()}
                            id="revoke-user-btn"
                        >
                            <UserX className="w-4 h-4" />
                            {t('security.revoke')}
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
}
