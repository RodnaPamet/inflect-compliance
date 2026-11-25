'use client';

/**
 * The Connect control's panel (#5937 step 4): what gets copied to a person's
 * calendar, and each provider's state with the one action it allows.
 *
 * Loaded on demand by `CalendarConnectAction` (`next/dynamic`), so none of it
 * — the modal, the confirm, the fetch — is in the calendar's First Load JS.
 *
 * ═══ THE PAGE DECIDES NOTHING ═══
 *
 * Whether a provider can be connected, and why not, is the server's answer
 * (`providers` on `GET /calendar/connections`, the rule the connect route
 * refuses with). So is a connection's state: only the server can tell a
 * person's own disconnect from a token the provider refused. The panel words
 * what it is told. A provider that cannot be connected gets its reason and no
 * button — for Outlook without the organisation's consent that reason names
 * who has to act, since a button would only fail.
 *
 * ═══ DISCONNECT IS CONFIRMED, NOT UNDONE ═══
 *
 * `docs/destructive-actions.md` puts an action whose effect is outside
 * Inflect out of the undo-toast pattern: a disconnect deletes events from the
 * person's Google or Outlook calendar and, for Google, revokes the grant at
 * Google. An Undo could not put either back, so the action sits behind a
 * `ConfirmDialog` that says what it deletes.
 */
import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { ShadedRow } from '@/components/ui/shaded-row';
import { LoadingSpinner } from '@/components/ui/icons';
import { useToast } from '@inflect/ui/components/ui/hooks/use-toast';
import { formatDate } from '@inflect/ui/lib/format-date';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import {
    PROVIDER_NAME_KEY,
    PROVIDER_ORDER,
    REFUSAL_KEY,
    STATE_LABEL_KEY,
    isConnectRefusal,
    type CalendarConnectRefusal,
    type CalendarConnectionView,
    type CalendarConnectionsResponse,
    type CalendarProviderId,
    type CalendarProviderView,
} from './connect-copy';
import { leaveForProvider } from './leave-for-provider';

const CONNECTIONS_PATH = '/calendar/connections';

type Translate = ReturnType<typeof useTranslations>;

export interface CalendarConnectPanelProps {
    open: boolean;
    setOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

/** Reads the refusal code off an error body (`details.reason`), if it is one. */
async function refusalOf(res: Response): Promise<CalendarConnectRefusal | null> {
    try {
        const body = (await res.json()) as { error?: { details?: { reason?: unknown } } };
        const reason = body?.error?.details?.reason;
        return isConnectRefusal(reason) ? reason : null;
    } catch {
        return null;
    }
}

export function CalendarConnectPanel({ open, setOpen }: CalendarConnectPanelProps) {
    const t = useTranslations('calendarConnect');
    const toast = useToast();
    const apiUrl = useTenantApiUrl();
    // Read only while the panel is open: a calendar visit that never opens
    // it costs no request.
    const query = useTenantSWR<CalendarConnectionsResponse>(open ? CONNECTIONS_PATH : null, {
        keepPreviousData: false,
    });

    const [starting, setStarting] = React.useState<CalendarProviderId | null>(null);
    const [startError, setStartError] = React.useState<{ provider: CalendarProviderId; refusal: CalendarConnectRefusal | null } | null>(null);
    const [confirmFor, setConfirmFor] = React.useState<CalendarProviderId | null>(null);

    const name = React.useCallback((p: CalendarProviderId) => t(PROVIDER_NAME_KEY[p]), [t]);

    const connect = async (provider: CalendarProviderId) => {
        setStarting(provider);
        setStartError(null);
        try {
            const res = await fetch(apiUrl(`/calendar/connect?provider=${provider}`), { method: 'POST' });
            if (res.ok) {
                const body = (await res.json()) as { authorizeUrl?: unknown };
                if (typeof body.authorizeUrl === 'string' && body.authorizeUrl) {
                    // The provider's page takes over; the callback brings the
                    // person back here with the outcome.
                    leaveForProvider(body.authorizeUrl);
                    return;
                }
            }
            const refusal = res.ok ? null : await refusalOf(res);
            setStartError({ provider, refusal });
            // A refusal means what the panel showed is out of date (the
            // consent was withdrawn since it was read): read it again.
            if (refusal) void query.mutate();
        } catch {
            setStartError({ provider, refusal: null });
        }
        setStarting(null);
    };

    const disconnect = async (provider: CalendarProviderId) => {
        let res: Response;
        try {
            res = await fetch(apiUrl(`${CONNECTIONS_PATH}?provider=${provider}`), { method: 'DELETE' });
        } catch {
            toast.error(t('disconnectError', { provider: name(provider) }));
            throw new Error('disconnect failed');
        }
        if (res.status === 204) {
            toast.success(t('disconnected', { provider: name(provider) }));
        } else if (res.status === 202) {
            const body = (await res.json().catch(() => ({}))) as { remaining?: unknown };
            const remaining = typeof body.remaining === 'number' ? body.remaining : 0;
            toast.info(t('disconnectingToast', { provider: name(provider), remaining }));
        } else {
            toast.error(t('disconnectError', { provider: name(provider) }));
            // Keeps the confirm open, so the person can try again.
            throw new Error('disconnect failed');
        }
        await query.mutate();
    };

    const data = query.data;
    const providers: CalendarProviderView[] = Array.isArray(data?.providers) ? data.providers : [];
    const connections: CalendarConnectionView[] = Array.isArray(data?.connections) ? data.connections : [];

    return (
        <>
            <Modal showModal={open} setShowModal={setOpen} size="sm" title={t('panelTitle')}>
                <Modal.Header title={t('panelTitle')} />
                <Modal.Body className="space-y-default" id="calendar-connect-panel">
                    <div className="space-y-compact">
                        <p>{t('intro')}</p>
                        <ul className="list-disc space-y-tight pl-5 text-content-muted">
                            <li>{t('pointOwn')}</li>
                            <li>{t('pointPrivate')}</li>
                            <li>{t('pointLanguage')}</li>
                            <li>{t('pointDisconnect')}</li>
                        </ul>
                    </div>

                    {query.error ? (
                        <InlineNotice variant="error" id="calendar-connect-load-error">
                            <span className="mr-2">{t('loadError')}</span>
                            <Button type="button" variant="secondary" size="sm" onClick={() => void query.mutate()}>
                                {t('retry')}
                            </Button>
                        </InlineNotice>
                    ) : !data ? (
                        <div className="flex justify-center py-4" aria-busy="true">
                            <LoadingSpinner />
                        </div>
                    ) : (
                        <ul className="space-y-default" aria-label={t('panelTitle')}>
                            {PROVIDER_ORDER.map((provider) => {
                                const view = providers.find((p) => p.provider === provider);
                                if (!view) return null;
                                return (
                                    <ProviderRow
                                        key={provider}
                                        t={t}
                                        providerName={name(provider)}
                                        view={view}
                                        connection={connections.find((c) => c.provider === provider) ?? null}
                                        starting={starting === provider}
                                        anyStarting={starting !== null}
                                        startError={startError?.provider === provider ? startError : null}
                                        onConnect={() => void connect(provider)}
                                        onDisconnect={() => setConfirmFor(provider)}
                                    />
                                );
                            })}
                        </ul>
                    )}
                </Modal.Body>
            </Modal>

            <ConfirmDialog
                showModal={confirmFor !== null}
                setShowModal={(next) => {
                    const isOpen = typeof next === 'function' ? next(confirmFor !== null) : next;
                    if (!isOpen) setConfirmFor(null);
                }}
                tone="danger"
                title={confirmFor ? t('confirmTitle', { provider: name(confirmFor) }) : ''}
                description={confirmFor ? t('confirmDescription', { provider: name(confirmFor) }) : undefined}
                confirmLabel={t('confirmLabel')}
                onConfirm={async () => {
                    if (confirmFor) await disconnect(confirmFor);
                }}
            />
        </>
    );
}

interface ProviderRowProps {
    t: Translate;
    providerName: string;
    view: CalendarProviderView;
    connection: CalendarConnectionView | null;
    starting: boolean;
    anyStarting: boolean;
    startError: { refusal: CalendarConnectRefusal | null } | null;
    onConnect: () => void;
    onDisconnect: () => void;
}

function ProviderRow({
    t,
    providerName,
    view,
    connection,
    starting,
    anyStarting,
    startError,
    onConnect,
    onDisconnect,
}: ProviderRowProps) {
    const state = connection?.state ?? null;
    const live = state === 'CONNECTED' || state === 'DISCONNECTING';
    const badgeVariant =
        state === 'CONNECTED' ? 'success' : state === 'DISCONNECTING' || state === 'STOPPED' ? 'warning' : 'neutral';
    const consentNote =
        view.provider === 'outlook-calendar' ? t('consentOutlook') : t('consentGoogle');
    const leftBehind =
        connection && !live && connection.undeletedEventCount > 0 ? connection.undeletedEventCount : 0;
    // The refusal the connect itself answered wins over the one read with
    // the panel: it is newer.
    const refusal = startError?.refusal ?? view.refusal;

    return (
        <ShadedRow
            as="li"
            className="space-y-compact"
            id={`calendar-connect-${view.provider}`}
            data-state={state ?? 'NONE'}
        >
            <div className="flex flex-wrap items-center justify-between gap-tight">
                <span className="font-medium text-content-emphasis">{providerName}</span>
                <StatusBadge variant={badgeVariant} icon={null}>
                    {t(state ? STATE_LABEL_KEY[state] : 'state.notConnected')}
                </StatusBadge>
            </div>

            {connection && live && (
                <div className="space-y-tight text-content-muted">
                    <p>{t('connectedSince', { date: formatDate(connection.connectedAt) })}</p>
                    <p>
                        {connection.lastPushedAt
                            ? t('lastPushed', { date: formatDate(connection.lastPushedAt) })
                            : t('notPushedYet')}
                    </p>
                </div>
            )}

            {state === 'DISCONNECTING' && connection && (
                <p className="text-content-warning">
                    {t('disconnectingDetail', { count: connection.undeletedEventCount })}
                </p>
            )}

            {state === 'CONNECTED' &&
                view.provider === 'outlook-calendar' &&
                (view.refusal === 'ADMIN_CONSENT_NOT_GRANTED' || view.refusal === 'ADMIN_CONSENT_WITHDRAWN') && (
                    <p className="text-content-warning">{t('consentGoneWhileConnected')}</p>
                )}

            {state === 'STOPPED' && <p className="text-content-warning">{t('stoppedDetail', { provider: providerName })}</p>}

            {leftBehind > 0 && <p className="text-content-muted">{t('leftBehind', { count: leftBehind })}</p>}

            {state === 'CONNECTED' ? (
                <div className="flex flex-wrap justify-end gap-tight">
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={onDisconnect}
                        aria-label={t('disconnectAria', { provider: providerName })}
                    >
                        {t('disconnect')}
                    </Button>
                </div>
            ) : state === 'DISCONNECTING' ? null : refusal ? (
                <p className="text-content-muted" id={`calendar-connect-${view.provider}-refusal`}>
                    {t(REFUSAL_KEY[refusal], { provider: providerName })}
                </p>
            ) : (
                <div className="space-y-tight">
                    <p className="text-xs text-content-muted">{consentNote}</p>
                    <div className="flex flex-wrap justify-end gap-tight">
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            loading={starting}
                            disabled={anyStarting && !starting}
                            onClick={onConnect}
                        >
                            {state === 'STOPPED'
                                ? t('reconnect', { provider: providerName })
                                : t('connect', { provider: providerName })}
                        </Button>
                    </div>
                    {startError && !startError.refusal && (
                        <p className="text-content-error" role="alert">
                            {t('connectError', { provider: providerName })}
                        </p>
                    )}
                </div>
            )}
        </ShadedRow>
    );
}
