'use client';

/**
 * Policy Acknowledgements tab (Prompt-1.3).
 *
 * Three surfaces in one panel:
 *   • the current user's own acknowledge button (when the policy is PUBLISHED);
 *   • an admin roster — required vs acknowledged, % complete, timestamps;
 *   • an admin "Request acknowledgement" action (audience: all members / a role).
 *
 * All copy is localized under `policies.ack.*`. Self-contained data fetching
 * against the attestation API added in Prompt-1.1/1.2.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTenantApiUrl, useTenantContext } from '@/lib/tenant-context-provider';
import { Button } from '@/components/ui/button';
import { ProgressBar } from '@/components/ui/progress-bar';
import { StatusBadge } from '@/components/ui/status-badge';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { UserCombobox } from '@/components/ui/user-combobox';
import { Heading } from '@/components/ui/typography';
import { formatDate, formatDateTime } from '@/lib/format-date';

type AckStatus = 'ACKNOWLEDGED' | 'ACKNOWLEDGED_SUPERSEDED' | 'OUTSTANDING';

interface RosterEntry {
    userId: string;
    name: string | null;
    email: string | null;
    required: boolean;
    acknowledgedAt: string | null;
    status: AckStatus;
    /** When an ACKNOWLEDGED_SUPERSEDED entry acked the now-stale version. */
    supersededAckAt: string | null;
    assignedById: string | null;
    assignedByName: string | null;
    assignedAt: string | null;
}
interface Attestation {
    userId: string;
    name: string | null;
    email: string | null;
    acknowledgedAt: string | null;
}
interface Roster {
    policyVersionId: string | null;
    assignedCount: number;
    acknowledgedCount: number;
    pctComplete: number;
    entries: RosterEntry[];
    /** Who attested the CURRENT version — the auditor "who attested" view. */
    attestations: Attestation[];
}

const ROLE_VALUES = ['OWNER', 'ADMIN', 'EDITOR', 'READER', 'AUDITOR'] as const;

export function PolicyAcknowledgementsPanel({
    policyId,
    canAdmin,
    isPublished,
    refreshToken = 0,
    currentVersionNumber = null,
}: {
    policyId: string;
    canAdmin: boolean;
    isPublished: boolean;
    /**
     * Bumped by the parent after publish / rollback.
     *
     * Both of those call `carryForwardAckCampaign`, which deliberately
     * RE-OPENS everyone's acknowledgement against the new version — the
     * whole point being that people must re-read what changed. This panel's
     * fetch effect depended only on stable values, so a mounted panel kept
     * rendering "You acknowledged this policy" and a stale percent-complete
     * bar after the campaign underneath it had been reset. The most
     * dangerous possible staleness: it tells someone they are compliant
     * when the system has just recorded that they are not.
     */
    refreshToken?: number;
    /**
     * Which version the roster describes. Assignments are version-scoped
     * (keyed on `currentVersionId`), so an unlabelled roster silently
     * changes meaning when the policy is republished.
     */
    currentVersionNumber?: number | null;
}) {
    const t = useTranslations('policies');
    const apiUrl = useTenantApiUrl();
    const { tenantSlug } = useTenantContext();

    const [ownAttested, setOwnAttested] = useState<boolean | null>(null);
    const [ownAt, setOwnAt] = useState<string | null>(null);
    const [attesting, setAttesting] = useState(false);
    const [roster, setRoster] = useState<Roster | null>(null);
    const [requestOpen, setRequestOpen] = useState(false);
    const [audienceType, setAudienceType] = useState<'all' | 'role' | 'users'>('all');
    const [role, setRole] = useState<(typeof ROLE_VALUES)[number]>('READER');
    const [userIds, setUserIds] = useState<string[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

    const loadOwn = useCallback(async () => {
        const res = await fetch(apiUrl(`/policies/${policyId}/attestation`));
        if (res.ok) {
            const data = (await res.json()) as { attested: boolean; attestation: { acknowledgedAt: string } | null };
            setOwnAttested(data.attested);
            setOwnAt(data.attestation?.acknowledgedAt ?? null);
        }
    }, [apiUrl, policyId]);

    const loadRoster = useCallback(async () => {
        if (!canAdmin) return;
        const res = await fetch(apiUrl(`/policies/${policyId}/attestations`));
        if (res.ok) setRoster((await res.json()) as Roster);
    }, [apiUrl, policyId, canAdmin]);

    useEffect(() => {
        void loadOwn();
        void loadRoster();
        // `refreshToken` is in the deps precisely because the other
        // dependencies are all stable — see the prop's note.
    }, [loadOwn, loadRoster, refreshToken]);

    const acknowledge = async () => {
        setAttesting(true);
        setMessage(null);
        try {
            const res = await fetch(apiUrl(`/policies/${policyId}/attest`), { method: 'POST' });
            if (!res.ok) throw new Error(await res.text());
            await loadOwn();
            await loadRoster();
            setMessage({ kind: 'ok', text: t('ack.acknowledgedToast') });
        } catch {
            setMessage({ kind: 'err', text: t('ack.acknowledgeFailed') });
        } finally {
            setAttesting(false);
        }
    };

    const submitRequest = async () => {
        setSubmitting(true);
        setMessage(null);
        try {
            const audience =
                audienceType === 'all'
                    ? { type: 'all' }
                    : audienceType === 'role'
                        ? { type: 'role', role }
                        : { type: 'users', userIds };
            const res = await fetch(apiUrl(`/policies/${policyId}/acknowledgement-requests`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ audience }),
            });
            if (!res.ok) throw new Error(await res.text());
            const data = (await res.json()) as { assignedCount: number };
            setRequestOpen(false);
            await loadRoster();
            setMessage({ kind: 'ok', text: t('ack.requestedToast', { count: data.assignedCount }) });
        } catch {
            setMessage({ kind: 'err', text: t('ack.requestFailed') });
        } finally {
            setSubmitting(false);
        }
    };

    const roleOptions: ComboboxOption[] = ROLE_VALUES.map((r) => ({ value: r, label: t(`ack.role.${r}`) }));
    const audienceOptions: ComboboxOption[] = [
        { value: 'all', label: t('ack.audienceAll') },
        { value: 'role', label: t('ack.audienceRole') },
        { value: 'users', label: t('ack.audienceUsers') },
    ];

    return (
        <div className="space-y-section" id="policy-acknowledgements">
            {message && (
                <p className={message.kind === 'ok' ? 'text-sm text-content-success' : 'text-sm text-content-error'}>
                    {message.text}
                </p>
            )}

            {/* Own acknowledgement */}
            <div className="rounded-lg border border-border-subtle p-4 space-y-default">
                <Heading level={3} className="text-sm font-semibold text-content-emphasis">{t('ack.yourStatusTitle')}</Heading>
                {!isPublished ? (
                    // The admin roster below may still show a campaign — it
                    // describes the last PUBLISHED version. Saying only
                    // "nothing to acknowledge" above live-looking numbers read
                    // as a contradiction; name the reason instead.
                    <p className="text-sm text-content-muted">
                        {t('ack.notPublished')}
                        {canAdmin && roster && roster.assignedCount > 0
                            ? ` ${t('ack.notPublishedRosterHint')}`
                            : ''}
                    </p>
                ) : ownAttested ? (
                    <p className="text-sm text-content-default">
                        {t('ack.youAcknowledged', { date: ownAt ? formatDate(ownAt) : '' })}
                    </p>
                ) : (
                    <div className="flex items-center gap-default">
                        <p className="text-sm text-content-muted flex-1">{t('ack.youOutstanding')}</p>
                        <Button onClick={acknowledge} disabled={attesting} data-testid="policy-acknowledge-button">
                            {attesting ? t('ack.acknowledging') : t('ack.acknowledge')}
                        </Button>
                    </div>
                )}
            </div>

            {/* Admin roster */}
            {canAdmin && (
                <div className="rounded-lg border border-border-subtle p-4 space-y-default">
                    <div className="flex items-center justify-between">
                        <Heading level={3} className="text-sm font-semibold text-content-emphasis">{t('ack.rosterTitle')}</Heading>
                        {isPublished && (
                            <Button variant="secondary" size="sm" onClick={() => setRequestOpen(true)} data-testid="policy-request-ack-button">
                                {t('ack.requestAck')}
                            </Button>
                        )}
                    </div>

                    {roster && roster.assignedCount > 0 ? (
                        <>
                            <div className="space-y-tight">
                                {/* Which version this roster is FOR. Assignments are
                                    version-scoped, so the same numbers mean something
                                    different after a republish — and on a DRAFT policy
                                    they describe the last published version, not the
                                    draft being edited. */}
                                <p className="text-xs text-content-subtle" data-testid="ack-roster-version">
                                    {currentVersionNumber != null
                                        ? t('ack.rosterForVersion', { version: currentVersionNumber })
                                        : t('ack.rosterForCurrentVersion')}
                                    {!isPublished && ` · ${t('ack.rosterNotLive')}`}
                                </p>
                                <div className="flex items-center justify-between text-xs text-content-muted">
                                    <span>{t('ack.percentComplete', { pct: roster.pctComplete })}</span>
                                    <span>{t('ack.completedOf', { done: roster.acknowledgedCount, total: roster.assignedCount })}</span>
                                </div>
                                <ProgressBar value={roster.pctComplete} />
                            </div>
                            <ul className="divide-y divide-border-subtle">
                                {roster.entries.map((e) => (
                                    <li key={e.userId} className="flex items-start justify-between gap-default py-2 text-sm">
                                        <span className="min-w-0">
                                            <span className="block truncate text-content-default">
                                                {e.name || e.email || e.userId}
                                                {!e.required && <span className="ml-2 text-xs text-content-muted">{t('ack.voluntary')}</span>}
                                            </span>
                                            {e.assignedByName && e.assignedAt && (
                                                <span className="block text-xs text-content-muted">
                                                    {t('ack.requestedByOn', { name: e.assignedByName, date: formatDate(e.assignedAt) })}
                                                </span>
                                            )}
                                        </span>
                                        <span className="shrink-0">
                                            {e.status === 'ACKNOWLEDGED' ? (
                                                <StatusBadge variant="success">
                                                    {e.acknowledgedAt ? formatDate(e.acknowledgedAt) : t('ack.statusAcknowledged')}
                                                </StatusBadge>
                                            ) : e.status === 'ACKNOWLEDGED_SUPERSEDED' ? (
                                                <StatusBadge variant="warning">{t('ack.statusSuperseded')}</StatusBadge>
                                            ) : (
                                                <StatusBadge variant="error">{t('ack.statusOutstanding')}</StatusBadge>
                                            )}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </>
                    ) : (
                        <p className="text-sm text-content-muted">{t('ack.noneRequired')}</p>
                    )}

                    {/* Auditor "who attested the current version" log — newest first. */}
                    <div className="space-y-tight pt-default border-t border-border-subtle">
                        <Heading level={3} className="text-xs font-semibold text-content-emphasis">{t('ack.attestationsTitle')}</Heading>
                        {roster && roster.attestations.length > 0 ? (
                            <ul className="divide-y divide-border-subtle">
                                {[...roster.attestations]
                                    .sort((a, b) => (b.acknowledgedAt ?? '').localeCompare(a.acknowledgedAt ?? ''))
                                    .map((a) => (
                                        <li key={a.userId} className="flex items-center justify-between gap-default py-1.5 text-sm">
                                            <span className="min-w-0 truncate text-content-default">{a.name || a.email || a.userId}</span>
                                            {a.acknowledgedAt && (
                                                <span className="shrink-0 text-xs text-content-muted">
                                                    {t('ack.attestedOn', { date: formatDateTime(a.acknowledgedAt) })}
                                                </span>
                                            )}
                                        </li>
                                    ))}
                            </ul>
                        ) : (
                            <p className="text-sm text-content-muted">{t('ack.noAttestations')}</p>
                        )}
                    </div>
                </div>
            )}

            {requestOpen && (
                <Modal showModal={requestOpen} setShowModal={setRequestOpen}>
                    <Modal.Header title={t('ack.requestTitle')} />
                    <Modal.Body>
                        <div className="space-y-default">
                            <FormField label={t('ack.audienceLabel')}>
                                <Combobox
                                    hideSearch
                                    id="policy-ack-audience"
                                    selected={audienceOptions.find((o) => o.value === audienceType) ?? null}
                                    setSelected={(o) => setAudienceType((o?.value as 'all' | 'role' | 'users') ?? 'all')}
                                    options={audienceOptions}
                                    matchTriggerWidth
                                />
                            </FormField>
                            {audienceType === 'role' && (
                                <FormField label={t('ack.roleLabel')}>
                                    <Combobox
                                        hideSearch
                                        id="policy-ack-role"
                                        selected={roleOptions.find((o) => o.value === role) ?? null}
                                        setSelected={(o) => setRole((o?.value as (typeof ROLE_VALUES)[number]) ?? 'READER')}
                                        options={roleOptions}
                                        matchTriggerWidth
                                    />
                                </FormField>
                            )}
                            {audienceType === 'users' && (
                                <FormField label={t('ack.usersLabel')}>
                                    <UserCombobox
                                        tenantSlug={tenantSlug}
                                        multiple
                                        selectedIds={userIds}
                                        onChange={(ids) => setUserIds(ids)}
                                        id="policy-ack-users"
                                        forceDropdown
                                        matchTriggerWidth
                                    />
                                </FormField>
                            )}
                        </div>
                    </Modal.Body>
                    <Modal.Footer>
                        <Button variant="secondary" onClick={() => setRequestOpen(false)}>{t('ack.cancel')}</Button>
                        <Button onClick={submitRequest} disabled={submitting || (audienceType === 'users' && userIds.length === 0)} data-testid="policy-ack-request-submit">
                            {submitting ? t('ack.requesting') : t('ack.requestConfirm')}
                        </Button>
                    </Modal.Footer>
                </Modal>
            )}
        </div>
    );
}
