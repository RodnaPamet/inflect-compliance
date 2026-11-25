'use client';

/* TODO(swr-migration): fetch-on-mount + setState, matching the parent
 * integrations page and its other cards. Migrate together to useTenantSWR. */

/**
 * Admin → Integrations: the Microsoft organisation-wide authorisation that
 * lets people in the workspace push their own deadlines to Outlook (#5937
 * step 3, docs/calendar-push-design.md).
 *
 * The consent model is decided: an administrator of the customer's Microsoft
 * organisation consents ONCE, for everyone (`/adminconsent`), and each person
 * then signs in for their own token. This card is where that happens. It
 * shows whether the workspace has granted, when, by whom and in which
 * directory; offers "Authorise for your organisation" (the browser follows the
 * returned URL to Microsoft) and "Revoke authorisation"; and states, beside
 * the button, that Microsoft grants everything the app registration declares
 * and that running it again may cancel other organisation-wide grants (design
 * point 3).
 *
 * ═══ WHERE THE CALLBACK LANDS ═══
 *
 * The admin-consent callback always returns here with `?calendar=<outcome>`
 * from the closed `CALENDAR_ADMIN_CONSENT_OUTCOMES`. The card shows one
 * message per outcome and removes the parameter from the URL, so a reload or a
 * shared link does not repeat a stale result. The message shows to every
 * viewer, because a callback can land somebody who has just LOST the
 * permission (`not_permitted`) and they are owed the reason.
 *
 * ═══ OFFERED WHERE THE SERVER TAKES IT ═══
 *
 * All three routes are `admin.manage`, with no usecase floor beyond it, so the
 * state and both controls are offered on exactly that gate
 * (`useOffersAdminApiWrite`). A viewer without it sees the outcome message
 * and nothing else: the read is refused to them too.
 *
 * ═══ REVOKING IS CONFIRMED, NOT UNDONE ═══
 *
 * Revoking stops every person's Outlook pushes at once, and nothing in
 * Inflect puts it back: re-authorising is another Microsoft sign-in by a
 * directory administrator. An undo toast would claim a reversibility the act
 * does not have (docs/destructive-actions.md, "When NOT to use this
 * pattern"), so it is a danger-toned confirmation.
 */

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { formatDate } from '@inflect/ui/lib/format-date';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { apiErrorMessage } from '@/lib/api-error';
import { useOffersAdminApiWrite } from '@/lib/auth/use-offers-admin-api-write';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import {
    isCalendarAdminConsentOutcome,
    type CalendarAdminConsentOutcome,
} from '@/lib/calendar-admin-consent-outcomes';

type Outcome = CalendarAdminConsentOutcome;

const OUTCOME_VARIANT: Record<Outcome, 'success' | 'warning' | 'error'> = {
    consent_granted: 'success',
    consent_declined: 'warning',
    not_directory_admin: 'warning',
    app_not_in_directory: 'error',
    provider_error: 'error',
    flow_invalid: 'warning',
    not_permitted: 'error',
    consent_failed: 'error',
};

const OUTCOME_PARAM = 'calendar';
const PROVIDER = 'outlook-calendar';

interface ConsentRow {
    provider: string;
    granted: boolean;
    grantedAt: string | null;
    revokedAt: string | null;
    externalTenantId: string | null;
    grantedBy: { name: string | null; email: string | null } | null;
}

interface ConsentView {
    consent: ConsentRow | null;
    microsoftClientConfigured: boolean;
}

type Notice = { variant: 'success' | 'error'; text: string } | null;

function readOutcome(value: string | null): Outcome | null {
    return isCalendarAdminConsentOutcome(value) ? value : null;
}

export function CalendarConsentCard() {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();
    const searchParams = useSearchParams();
    const canManage = useOffersAdminApiWrite({ key: 'admin.manage' });

    // Read once: the parameter is removed from the URL below, and the message
    // must outlive that.
    const [outcome] = useState<Outcome | null>(() => readOutcome(searchParams?.get(OUTCOME_PARAM) ?? null));
    const [view, setView] = useState<ConsentView | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    /** Which request is in flight; the page is leaving while `authorise` is. */
    const [pending, setPending] = useState<'authorise' | 'revoke' | null>(null);
    const busy = pending !== null;
    const [notice, setNotice] = useState<Notice>(null);
    const [confirmRevoke, setConfirmRevoke] = useState(false);

    useEffect(() => {
        const raw = searchParams?.get(OUTCOME_PARAM);
        if (raw === null || raw === undefined) return;
        try {
            const url = new URL(window.location.href);
            url.searchParams.delete(OUTCOME_PARAM);
            window.history.replaceState(window.history.state, '', url.toString());
        } catch {
            // A URL we cannot rewrite leaves the parameter; the message is
            // still right.
        }
    }, [searchParams]);

    const load = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/admin/calendar/consent'));
            const data = (await res.json().catch(() => null)) as {
                consents?: ConsentRow[];
                microsoftClientConfigured?: boolean;
            } | null;
            if (!res.ok || !data) {
                setLoadError(apiErrorMessage(data, t('calendarConsent.loadFailed')));
                return;
            }
            setLoadError(null);
            setView({
                consent: data.consents?.find((c) => c.provider === PROVIDER) ?? null,
                microsoftClientConfigured: data.microsoftClientConfigured === true,
            });
        } catch {
            setLoadError(t('calendarConsent.loadFailed'));
        }
    }, [apiUrl, t]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (canManage) void load();
    }, [canManage, load]);

    const authorise = async () => {
        setPending('authorise');
        setNotice(null);
        try {
            const res = await fetch(apiUrl(`/admin/calendar/consent?provider=${PROVIDER}`), { method: 'POST' });
            const data = (await res.json().catch(() => null)) as { consentUrl?: unknown } | null;
            if (!res.ok || typeof data?.consentUrl !== 'string') {
                setNotice({ variant: 'error', text: apiErrorMessage(data, t('calendarConsent.authoriseFailed')) });
                await load();
                setPending(null);
                return;
            }
            // Hand off to Microsoft. The card stays busy: the page is leaving.
            window.location.assign(data.consentUrl);
        } catch {
            setNotice({ variant: 'error', text: t('calendarConsent.authoriseFailed') });
            setPending(null);
        }
    };

    const revoke = async () => {
        setPending('revoke');
        setNotice(null);
        try {
            const res = await fetch(apiUrl(`/admin/calendar/consent?provider=${PROVIDER}`), { method: 'DELETE' });
            if (!res.ok) {
                const data: unknown = await res.json().catch(() => null);
                setNotice({ variant: 'error', text: apiErrorMessage(data, t('calendarConsent.revokeFailed')) });
                return;
            }
            setNotice({ variant: 'success', text: t('calendarConsent.revoked') });
            await load();
        } catch {
            setNotice({ variant: 'error', text: t('calendarConsent.revokeFailed') });
        } finally {
            setPending(null);
        }
    };

    const consent = view?.consent ?? null;
    const granted = consent?.granted === true;
    const everGranted = Boolean(consent?.grantedAt);
    const status = granted
        ? { variant: 'success' as const, label: t('calendarConsent.statusGranted') }
        : consent?.revokedAt
          ? { variant: 'neutral' as const, label: t('calendarConsent.statusRevoked') }
          : { variant: 'neutral' as const, label: t('calendarConsent.statusNotGranted') };
    const grantorName = consent?.grantedBy?.name || consent?.grantedBy?.email || null;

    return (
        <Card className="space-y-default p-6" id="calendar-consent-card">
            <Heading level={2}>{t('calendarConsent.title')}</Heading>
            <p className="text-sm text-content-muted">{t('calendarConsent.intro')}</p>

            {outcome && (
                <InlineNotice variant={OUTCOME_VARIANT[outcome]} data-testid="calendar-consent-result">
                    {t(`calendarConsent.outcome.${outcome}`)}
                </InlineNotice>
            )}

            {notice && (
                <InlineNotice variant={notice.variant} data-testid="calendar-consent-notice">
                    {notice.text}
                </InlineNotice>
            )}

            {canManage && loadError && (
                <InlineNotice variant="error" data-testid="calendar-consent-load-error">
                    {loadError}
                </InlineNotice>
            )}

            {canManage && !view && !loadError && (
                <p className="text-sm text-content-muted">{t('calendarConsent.loading')}</p>
            )}

            {canManage && view && (
                <div className="space-y-default" data-testid="calendar-consent-state">
                    <div className="flex flex-wrap items-center gap-tight">
                        <StatusBadge variant={status.variant} data-testid="calendar-consent-status">
                            {status.label}
                        </StatusBadge>
                    </div>

                    {everGranted ? (
                        <ul className="space-y-tight text-sm text-content-default">
                            <li>{t('calendarConsent.grantedAt', { date: formatDate(consent?.grantedAt ?? null) })}</li>
                            <li>
                                {grantorName
                                    ? t('calendarConsent.grantedBy', { name: grantorName })
                                    : t('calendarConsent.grantedByUnknown')}
                            </li>
                            <li className="break-all">
                                {consent?.externalTenantId
                                    ? t('calendarConsent.directory', { id: consent.externalTenantId })
                                    : t('calendarConsent.directoryUnknown')}
                            </li>
                            {consent?.revokedAt && (
                                <li>{t('calendarConsent.revokedAt', { date: formatDate(consent.revokedAt) })}</li>
                            )}
                        </ul>
                    ) : (
                        <p className="text-sm text-content-default">{t('calendarConsent.neverGranted')}</p>
                    )}

                    {view.microsoftClientConfigured ? (
                        <div className="space-y-tight">
                            <p className="text-sm text-content-muted" data-testid="calendar-consent-scope-note">
                                {t('calendarConsent.scopeNote')}
                            </p>
                            <div className="flex flex-wrap gap-tight">
                                <Button
                                    variant="secondary"
                                    onClick={() => void authorise()}
                                    disabled={busy}
                                    id="calendar-consent-authorise"
                                >
                                    {pending === 'authorise'
                                        ? t('calendarConsent.authorising')
                                        : granted
                                          ? t('calendarConsent.authoriseAgain')
                                          : t('calendarConsent.authorise')}
                                </Button>
                                {granted && (
                                    <Button
                                        variant="destructive"
                                        onClick={() => setConfirmRevoke(true)}
                                        disabled={busy}
                                        id="calendar-consent-revoke"
                                    >
                                        {t('calendarConsent.revoke')}
                                    </Button>
                                )}
                            </div>
                        </div>
                    ) : (
                        <>
                            <InlineNotice variant="info" data-testid="calendar-consent-not-configured">
                                {t('calendarConsent.notConfigured')}
                            </InlineNotice>
                            {/* A grant recorded before the registration went
                                away can still be revoked; revoking needs no
                                Microsoft round trip. */}
                            {granted && (
                                <div className="flex flex-wrap gap-tight">
                                    <Button
                                        variant="destructive"
                                        onClick={() => setConfirmRevoke(true)}
                                        disabled={busy}
                                        id="calendar-consent-revoke"
                                    >
                                        {t('calendarConsent.revoke')}
                                    </Button>
                                </div>
                            )}
                        </>
                    )}
                </div>
            )}

            <ConfirmDialog
                showModal={confirmRevoke}
                setShowModal={setConfirmRevoke}
                tone="danger"
                title={t('calendarConsent.revokeTitle')}
                description={t('calendarConsent.revokeDescription')}
                confirmLabel={t('calendarConsent.revokeConfirm')}
                onConfirm={revoke}
            />
        </Card>
    );
}
