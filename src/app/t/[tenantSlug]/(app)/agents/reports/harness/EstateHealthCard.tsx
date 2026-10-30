'use client';

/**
 * PER-ESTATE SCHEDULE HEALTH on the harness tab (#3678, step 4a): for each
 * declared estate, the last complete scan and, for each of its sources, the
 * last scan that read it in full — with the source's owner — and whether the
 * estate is FRESH or STALE against its cadence.
 *
 * The health is the server's. The rules are `computeEstateHealth`'s; this
 * renders what it decided and adds none of its own. In particular a STALE
 * estate is never softened here: "no complete scan among those read" and "the
 * last complete scan is too old" are both STALE, and the text says which.
 *
 * No estate declared is said in words, not left as an empty card: until an
 * estate exists, no scan is held to any schedule, which is a gap rather than a
 * clean state.
 *
 * DECLARING, EDITING AND REMOVING (#3807) are offered only when `manage` is
 * given, which the page does for a holder of `admin.agent_registry`, the key
 * the estate routes take. A view-key reader sees the health and no control
 * that would be refused. Removing waits out the undo window before the DELETE
 * is sent, and the stale-estate finding stays open after it, as the usecase
 * says.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Plus } from '@inflect/ui/components/ui/icons/nucleo';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useToast, useToastWithUndo } from '@/components/ui/hooks';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { formatDateTime } from '@inflect/ui/lib/format-date';
import { apiErrorMessage } from '@/lib/api-error';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import type {
    EstateHealthRow,
    EstateHealthStatus,
    EstateSourceHealth,
    HarnessEstateHealthView,
} from '@/lib/agentic/harness-estate-health';

import { EstateFormModal, type EstateScannerOption } from './EstateFormModal';
import { COMPLETENESS_VARIANT } from './ScannerSection';
import { sourceKindLabel } from './source-kind-label';

const STATUS_VARIANT: Readonly<Record<EstateHealthStatus, StatusBadgeVariant>> = {
    FRESH: 'success',
    STALE: 'error',
};

function SourceLine({ estateId, source }: { estateId: string; source: EstateSourceHealth }) {
    const t = useTranslations('agents');
    const owner = source.owner.name ?? t('harness.estates.ownerUnnamed');
    const latest = source.latest;
    return (
        <li
            className="flex flex-wrap items-center gap-compact text-xs"
            data-testid={`harness-estate-source-${estateId}-${source.kind}`}
        >
            <span>{sourceKindLabel(t, source.kind)}</span>
            <StatusBadge variant={STATUS_VARIANT[source.status]} size="sm">
                {t(`harness.estates.status.${source.status}`)}
            </StatusBadge>
            <span>
                {t('harness.estates.sourceOwner', { name: owner })}
                {!source.owner.active && (
                    <span className="text-content-error" data-testid={`harness-estate-owner-departed-${estateId}-${source.kind}`}>
                        {' '}({t('harness.estates.ownerDeparted')})
                    </span>
                )}
            </span>
            <span className="text-content-muted">
                {source.lastComplete
                    ? t('harness.estates.sourceLastComplete', { at: formatDateTime(source.lastComplete.at) })
                    : t('harness.estates.sourceNeverComplete')}
            </span>
            {latest && latest.state !== 'COMPLETE' && (
                <span className="text-content-warning">
                    {t('harness.estates.latestState', {
                        state: t(`harness.estates.sourceState.${latest.state}`, {
                            reason: latest.reason ? t(`harness.incompleteReason.${latest.reason}`) : '',
                        }),
                    })}
                </span>
            )}
        </li>
    );
}

interface EstateActions {
    onEdit: (row: EstateHealthRow) => void;
    onRemove: (row: EstateHealthRow) => void;
}

function EstateBlock({ row, window, actions }: { row: EstateHealthRow; window: number; actions: EstateActions | null }) {
    const t = useTranslations('agents');
    return (
        <section className="space-y-compact border-t border-border-subtle pt-default" data-testid={`harness-estate-${row.id}`}>
            <div className="flex flex-wrap items-center gap-compact">
                <Heading level={3}>{row.name}</Heading>
                <StatusBadge variant={STATUS_VARIANT[row.status]} data-testid={`harness-estate-status-${row.id}`}>
                    {t(`harness.estates.status.${row.status}`)}
                </StatusBadge>
                <span className="text-xs text-content-muted">
                    {t('harness.estates.cadence', { cadence: row.cadenceHours, stale: row.staleAfterHours })}
                </span>
                <span className="text-xs text-content-muted">
                    {t('harness.estates.scanner', { name: row.scannerName ?? row.scannerAgentId })}
                </span>
                {actions && (
                    <span className="ml-auto flex items-center gap-tight">
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => actions.onEdit(row)}
                            data-testid={`harness-estate-edit-${row.id}`}
                        >
                            {t('harness.estates.edit')}
                        </Button>
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => actions.onRemove(row)}
                            data-testid={`harness-estate-remove-${row.id}`}
                        >
                            {t('harness.estates.remove')}
                        </Button>
                    </span>
                )}
            </div>
            {!row.scannerLive && (
                <InlineNotice variant="error" icon={null} data-testid={`harness-estate-scanner-retired-${row.id}`}>
                    {t('harness.estates.scannerRetired')}
                </InlineNotice>
            )}
            <p className="text-xs" data-testid={`harness-estate-last-complete-${row.id}`}>
                {row.lastComplete
                    ? t('harness.estates.lastComplete', { at: formatDateTime(row.lastComplete.at), scanRef: row.lastComplete.scanRef })
                    : t('harness.estates.lastCompleteMissing', { window })}
            </p>
            <p className="flex flex-wrap items-center gap-compact text-xs">
                {row.latest ? (
                    <>
                        <span>
                            {t('harness.estates.latest', {
                                at: formatDateTime(row.latest.at),
                                completeness: t(`harness.completeness.${row.latest.completeness}`),
                            })}
                        </span>
                        <StatusBadge variant={COMPLETENESS_VARIANT[row.latest.completeness]} size="sm">
                            {t(`harness.completeness.${row.latest.completeness}`)}
                        </StatusBadge>
                    </>
                ) : (
                    <span>{t('harness.estates.latestMissing', { window })}</span>
                )}
            </p>
            <ul className="space-y-tight">
                {row.sources.map((s) => (
                    <SourceLine key={s.kind} estateId={row.id} source={s} />
                ))}
            </ul>
            {row.undeclaredSources.length > 0 && (
                <InlineNotice variant="warning" icon={null} data-testid={`harness-estate-undeclared-${row.id}`}>
                    {t('harness.estates.undeclared', {
                        kinds: row.undeclaredSources.map((k) => sourceKindLabel(t, k)).join(', '),
                    })}
                </InlineNotice>
            )}
        </section>
    );
}

export function EstateHealthCard({
    view,
    manage = null,
}: {
    view: HarnessEstateHealthView;
    /**
     * Present for a holder of `admin.agent_registry` (#3807): the live register
     * rows a new estate's scanner may be chosen from. `null` renders no control.
     */
    manage?: { readonly scanners: readonly EstateScannerOption[] } | null;
}) {
    const t = useTranslations('agents');
    const apiUrl = useTenantApiUrl();
    const router = useRouter();
    const toast = useToast();
    const triggerUndo = useToastWithUndo();

    const [form, setForm] = useState<{ estate: EstateHealthRow | null } | null>(null);
    const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());

    const rows = view.estates.rows.filter((r) => !hidden.has(r.id));
    // One estate per scanner: a scanner already covering one is not offered.
    const covered = new Set(view.estates.rows.map((r) => r.scannerAgentId));
    const freeScanners = (manage?.scanners ?? []).filter((s) => !covered.has(s.id));

    const unhide = (id: string) =>
        setHidden((h) => {
            const next = new Set(h);
            next.delete(id);
            return next;
        });

    const remove = (row: EstateHealthRow) => {
        setHidden((h) => new Set(h).add(row.id));
        triggerUndo({
            message: t('harness.estates.removing', { name: row.name }),
            undoMessage: t('harness.estates.undo'),
            action: async () => {
                const res = await fetch(apiUrl(`/admin/agents/harness-estates/${row.id}`), { method: 'DELETE' });
                if (!res.ok) {
                    const body = await res.json().catch(() => null);
                    throw new Error(apiErrorMessage(body, t('harness.estates.removeFailed')));
                }
            },
            undoAction: () => unhide(row.id),
            onCommit: () => router.refresh(),
            onError: (err) => {
                unhide(row.id);
                toast.error(err instanceof Error ? err.message : t('harness.estates.removeFailed'));
            },
        });
    };

    const actions: EstateActions | null = manage ? { onEdit: (row) => setForm({ estate: row }), onRemove: remove } : null;

    return (
        <Card data-testid="harness-estates" className="space-y-default">
            <div className="flex flex-wrap items-center justify-between gap-compact">
                <Heading level={2}>{t('harness.estates.heading')}</Heading>
                {manage && (
                    // Secondary: a card action inside a tab; the dialog carries the one primary.
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        icon={<Plus />}
                        onClick={() => setForm({ estate: null })}
                        data-testid="harness-estate-declare-button"
                    >
                        {t('harness.estates.declare')}
                    </Button>
                )}
            </div>
            <p className="text-xs text-content-muted">{t('harness.estates.intro')}</p>
            {rows.length === 0 ? (
                <InlineNotice variant="warning" data-testid="harness-estates-none">
                    {t('harness.estates.none')}
                </InlineNotice>
            ) : (
                rows.map((row) => <EstateBlock key={row.id} row={row} window={view.scanWindow} actions={actions} />)
            )}
            {view.windowTruncated && (
                <InlineNotice variant="info" icon={null} data-testid="harness-estates-window-truncated">
                    {t('harness.estates.windowTruncated', { window: view.scanWindow })}
                </InlineNotice>
            )}
            {view.estates.truncated && (
                <InlineNotice variant="warning" icon={null} data-testid="harness-estates-truncated">
                    {t('harness.estates.estatesTruncated')}
                </InlineNotice>
            )}
            {form && manage && (
                <EstateFormModal estate={form.estate} scanners={freeScanners} onClose={() => setForm(null)} />
            )}
        </Card>
    );
}
