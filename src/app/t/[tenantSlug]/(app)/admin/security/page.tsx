'use client';

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

import { useState, useEffect, useCallback, type Dispatch, type SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import { Card, cardVariants } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { useTenantApiUrl, useTenantHref, useTenantContext, usePermissions } from '@/lib/tenant-context-provider';
import { AgentEnforcementCard } from './AgentEnforcementCard';
import { ApiKeyRotationCard } from './ApiKeyRotationCard';
import { ShieldCheck, Save, AlertTriangle, LogOut, Users, UserX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InfoTooltip } from '@/components/ui/tooltip';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { cn } from '@inflect/ui/lib/cn';
import { apiErrorMessage } from '@/lib/api-error';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { UserCombobox, type Member } from '@/components/ui/user-combobox';
import { FormField } from '@/components/ui/form-field';

type MfaPolicy = 'DISABLED' | 'OPTIONAL' | 'REQUIRED';

interface SecuritySettings {
    mfaPolicy: MfaPolicy;
    sessionMaxAgeMinutes: number | null;
}

const POLICY_VALUES: MfaPolicy[] = ['DISABLED', 'OPTIONAL', 'REQUIRED'];

/** Which destructive session action the confirm dialog is open for. */
type PendingRevoke = 'others' | 'all' | 'member' | null;

/** A member's name for the confirm and the success message, never their id alone. */
function memberName(member: Member): string {
    return member.name?.trim() || member.email?.trim() || `User ${member.id.slice(0, 8)}`;
}

export default function AdminSecurityPage() {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const { tenantSlug, userId: currentUserId } = useTenantContext();
    // Only an Owner signs out an Owner or an AI admin (owner decision,
    // 2026-10-25); the picker cannot see roles, so the server refuses and the
    // field says so up front.
    const canRevokeOwnerManaged = usePermissions().admin.owner_management;
    /**
     * What is STORED, or null until it loads. Null after a failed load too, and
     * that is the point (#4117): the page used to start from Disabled and an
     * empty session age and keep them when the read failed, so it showed the
     * defaults as if they were the saved settings, and Save wrote them over the
     * real ones.
     */
    const [settings, setSettings] = useState<SecuritySettings | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const [revoking, setRevoking] = useState(false);
    const [pendingRevoke, setPendingRevoke] = useState<PendingRevoke>(null);
    const [revokeTarget, setRevokeTarget] = useState<Member | null>(null);

    const fetchSettings = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/security/mfa/policy'));
            const data = await res.json().catch(() => null);
            if (!res.ok || !data) {
                setLoadError(apiErrorMessage(data, t('security.failedLoadSettings')));
                return;
            }
            setSettings(data);
        } catch {
            setLoadError(t('security.failedLoadSettings'));
        } finally {
            setLoading(false);
        }
    }, [apiUrl, t]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchSettings(); }, [fetchSettings]);

    const handleSave = async () => {
        if (!settings) return;
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
                throw new Error(apiErrorMessage(data, t('security.failedSave')));
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

    /** Sends the sign-in page after a revocation that also ended this session. */
    const leaveForSignIn = () => setTimeout(() => { window.location.href = '/login'; }, 2000);

    const handleRevokeMySessions = async () => {
        setRevoking(true);
        setError(null);
        setSuccess(null);
        try {
            const res = await fetch(apiUrl('/security/sessions/revoke-current'), { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(apiErrorMessage(data, t('security.failedRevokeSessions')));
            }
            // The server keeps the session making the request. Only when it could
            // not tell that session apart from the others did it revoke them all,
            // and only then is there a sign-in page to go to.
            if (data.currentSessionKept === true) {
                setSuccess(t('security.otherSessionsRevoked'));
                setTimeout(() => setSuccess(null), 3000);
            } else {
                setSuccess(t('security.mySessionsRevoked'));
                leaveForSignIn();
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : t('security.revocationFailed'));
        } finally {
            setRevoking(false);
        }
    };

    const handleRevokeAllTenant = async () => {
        setRevoking(true);
        setError(null);
        setSuccess(null);
        try {
            const res = await fetch(apiUrl('/security/sessions/revoke-all'), { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(apiErrorMessage(data, t('security.failedRevoke')));
            }
            if (data.currentSessionKept === false) {
                setSuccess(t('security.allRevokedIncludingYou', { count: data.usersAffected }));
                leaveForSignIn();
            } else {
                setSuccess(t('security.allRevoked', { count: data.usersAffected }));
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : t('security.bulkRevocationFailed'));
        } finally {
            setRevoking(false);
        }
    };

    const handleRevokeUser = async () => {
        const target = revokeTarget;
        if (!target) return;
        setRevoking(true);
        setError(null);
        setSuccess(null);
        try {
            const res = await fetch(apiUrl('/security/sessions/revoke-user'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetUserId: target.id }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                setSuccess(t('security.userSessionsRevoked', { name: memberName(target) }));
                setRevokeTarget(null);
                setTimeout(() => setSuccess(null), 3000);
            } else {
                throw new Error(apiErrorMessage(data, t('security.failedRevokeUser')));
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : t('security.userRevocationFailed'));
        } finally {
            setRevoking(false);
        }
    };

    /** Each confirm dialog is open only while its own action is pending. */
    const dialogState = (which: Exclude<PendingRevoke, null>) => ({
        showModal: pendingRevoke === which,
        setShowModal: ((open: boolean | ((prev: boolean) => boolean)) => {
            const next = typeof open === 'function' ? open(pendingRevoke === which) : open;
            setPendingRevoke(next ? which : null);
        }) as Dispatch<SetStateAction<boolean>>,
    });

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

            {loadError && (
                <InlineNotice
                    variant="error"
                    icon={AlertTriangle}
                    title={loadError}
                    data-testid="security-settings-load-error"
                >
                    {t('security.saveBlockedUntilLoaded')}
                </InlineNotice>
            )}

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
                                settings?.mfaPolicy === value
                                    ? 'border-[var(--brand-default)]/60 bg-[var(--brand-subtle)]'
                                    : 'border-border-default hover:border-border-emphasis'
                            }`}
                        >
                            <input
                                type="radio"
                                name="mfaPolicy"
                                value={value}
                                checked={settings?.mfaPolicy === value}
                                disabled={!settings}
                                onChange={() => setSettings(s => (s ? { ...s, mfaPolicy: value } : s))}
                                className="mt-1 accent-[var(--brand-default)]"
                            />
                            <div>
                                <span className={`text-sm font-medium ${
                                    settings?.mfaPolicy === value ? 'text-[var(--brand-muted)]' : 'text-content-emphasis'
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

                {settings?.mfaPolicy === 'REQUIRED' && (
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
                        value={settings?.sessionMaxAgeMinutes ?? ''}
                        disabled={!settings}
                        onChange={(e) => {
                            const val = e.target.value ? parseInt(e.target.value, 10) : null;
                            setSettings(s => (s ? { ...s, sessionMaxAgeMinutes: val } : s));
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
                    disabled={saving || !settings}
                    loading={saving}
                    id="security-save-btn"
                >
                    <Save className="w-4 h-4" />
                    {saving ? t('security.saving') : t('security.saveSettings')}
                </Button>
            </div>

            {/* ──── Agent-registration enforcement (#2443) ──── */}
            <AgentEnforcementCard tenantSlug={tenantSlug} />

            {/* ──── API-key rotation age for credential hygiene (#3708) ──── */}
            <ApiKeyRotationCard />

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
                        onClick={() => setPendingRevoke('others')}
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
                        onClick={() => setPendingRevoke('all')}
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

                {/* Revoke one member's sessions — picked by name from this
                    workspace's members, never typed as an id no screen shows. You
                    are left out: "Sign Out Other Sessions" is your own action, and
                    revoking yourself here would sign this session out too. */}
                <div className="border-t border-border-default/50 pt-4">
                    <div className="flex gap-tight items-end">
                        <div className="flex-1 min-w-0">
                            <FormField
                                label={t('security.revokeSpecificLabel')}
                                description={canRevokeOwnerManaged ? undefined : t('security.revokeOwnerOnlyHint')}
                            >
                                <UserCombobox
                                    id="revoke-user-picker"
                                    tenantSlug={tenantSlug}
                                    selectedId={revokeTarget?.id ?? null}
                                    onChange={(_id, member) => setRevokeTarget(member)}
                                    filter={(member) => member.id !== currentUserId}
                                    placeholder={t('security.pickMemberPlaceholder')}
                                    disabled={revoking}
                                />
                            </FormField>
                        </div>
                        <Button
                            variant="destructive"
                            onClick={() => setPendingRevoke('member')}
                            disabled={revoking || !revokeTarget}
                            id="revoke-user-btn"
                        >
                            <UserX className="w-4 h-4" />
                            {t('security.revoke')}
                        </Button>
                    </div>
                </div>
            </div>

            <ConfirmDialog
                {...dialogState('others')}
                tone="danger"
                confirmLabel={t('security.signOutOthersConfirmLabel')}
                title={t('security.signOutOthersConfirmTitle')}
                description={t('security.signOutOthersConfirmBody')}
                onConfirm={handleRevokeMySessions}
            />
            <ConfirmDialog
                {...dialogState('all')}
                tone="danger"
                confirmLabel={t('security.revokeAllConfirmLabel')}
                title={t('security.revokeAllConfirmTitle')}
                description={t('security.revokeAllConfirmBody')}
                onConfirm={handleRevokeAllTenant}
            />
            <ConfirmDialog
                {...dialogState('member')}
                tone="danger"
                confirmLabel={t('security.revokeUserConfirmLabel')}
                title={t('security.revokeUserConfirmTitle', { name: revokeTarget ? memberName(revokeTarget) : '' })}
                description={t('security.revokeUserConfirmBody', { name: revokeTarget ? memberName(revokeTarget) : '' })}
                onConfirm={handleRevokeUser}
            />
        </div>
    );
}
