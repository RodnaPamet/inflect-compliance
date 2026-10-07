'use client';

/**
 * Asset quick-look rail content.
 *
 * A single click on an asset name opens this in an `<AsidePanel>` — the
 * same docked right-rail the Controls + Tasks lists use (co-resident with
 * the table, not a blocking overlay). This component owns only the panel
 * CONTENT; `AssetsClient` owns the `<AsidePanel>` chrome. A "Full view"
 * button enters the full `/assets/[id]` page (tabs + edit surface).
 *
 * The row object is passed in directly (the list already carries every
 * field shown here), so the panel renders instantly with no fetch.
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { buttonVariants } from '@/components/ui/button-variants';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { ownerDisplayName } from '@/lib/owner-display';
import { formatDate } from '@inflect/ui/lib/format-date';
import { AssetCriticalityBadge } from './_form/AssetCriticalityFields';

export interface AssetPanelRow {
    id: string;
    key?: string | null;
    name: string;
    type?: string | null;
    status?: string | null;
    /** Legacy free-text owner — import-only fallback, distinct from the assignee. */
    owner?: string | null;
    ownerUserId?: string | null;
    /** Resolved assignee (the one Owner concept). */
    ownerUser?: { id: string; name: string | null; email: string | null } | null;
    classification?: string | null;
    confidentiality?: number | null;
    integrity?: number | null;
    availability?: number | null;
    /** Per-asset OPEN-vuln rollup (CVE + scanner) the list column shows. */
    openVulnCount?: number | null;
    maxVulnSeverity?: string | null;
    /** Context fields — surfaced here so the quick-look previews the same
     *  signals the full page carries, without a full-page open. */
    location?: string | null;
    dataResidency?: string | null;
    externalRef?: string | null;
    dependencies?: string | null;
    businessProcesses?: string | null;
    retention?: string | null;
    retentionUntil?: string | null;
}

/** OPEN-vuln severity → badge tint (mirrors the list column). */
function vulnSeverityVariant(sev: string | null | undefined): StatusBadgeVariant {
    const s = (sev ?? '').toUpperCase();
    if (s === 'CRITICAL' || s === 'HIGH') return 'error';
    if (s === 'MEDIUM') return 'warning';
    if (s === 'LOW') return 'success';
    return 'neutral';
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex items-start justify-between gap-default border-b border-border-subtle py-2.5 last:border-0">
            <span className="text-xs uppercase tracking-wider text-content-subtle">{label}</span>
            <span className="text-sm text-content-default text-right">{children}</span>
        </div>
    );
}

export function AssetDetailPanel({
    asset,
    tenantHref,
}: {
    asset: AssetPanelRow;
    tenantHref: (path: string) => string;
}) {
    const t = useTranslations('assets');
    const statusVariant: StatusBadgeVariant =
        asset.status === 'RETIRED' ? 'neutral' : 'success';
    const subtitle = [asset.key, asset.type?.replace(/_/g, ' ')]
        .filter(Boolean)
        .join(' · ');

    return (
        <div className="flex h-full flex-col">
            {subtitle && (
                <p className="mb-1 text-xs text-content-subtle">{subtitle}</p>
            )}
            <div className="flex justify-center py-2">
                <AssetCriticalityBadge
                    confidentiality={asset.confidentiality ?? 3}
                    integrity={asset.integrity ?? 3}
                    availability={asset.availability ?? 3}
                />
            </div>
            <div className="mt-2">
                <Row label={t('detail.status')}>
                    <StatusBadge variant={statusVariant} size="sm">
                        {asset.status || 'ACTIVE'}
                    </StatusBadge>
                </Row>
                <Row label={t('detail.type')}>
                    {asset.type ? asset.type.replace(/_/g, ' ') : '—'}
                </Row>
                <Row label={t('detail.owner')}>
                    {ownerDisplayName(asset.ownerUser?.name, asset.ownerUser?.email) ??
                        (asset.owner
                            ? `${asset.owner} (${t('list.ownerImported')})`
                            : '—')}
                </Row>
                <Row label={t('detail.classification')}>{asset.classification || '—'}</Row>
                <Row label={t('detail.confidentiality')}>{asset.confidentiality ?? '—'}</Row>
                <Row label={t('detail.integrity')}>{asset.integrity ?? '—'}</Row>
                <Row label={t('detail.availability')}>{asset.availability ?? '—'}</Row>
                {/* Open-vuln signal — the same rollup (CVE + scanner) the list
                    column tints, previewed without a full-page open. */}
                <Row label={t('colHeaders.vulnerabilities')}>
                    {asset.openVulnCount && asset.openVulnCount > 0 ? (
                        <StatusBadge variant={vulnSeverityVariant(asset.maxVulnSeverity)} size="sm">
                            {asset.maxVulnSeverity
                                ? `${asset.openVulnCount} · ${asset.maxVulnSeverity}`
                                : String(asset.openVulnCount)}
                        </StatusBadge>
                    ) : (
                        <span className="text-content-muted">—</span>
                    )}
                </Row>
                {/* Key context fields — rendered only when populated to keep the
                    quick-look concise. Dependency / business-process are free-text
                    notes (structured process-map linkage lives on the full page). */}
                {asset.location && <Row label={t('detail.location')}>{asset.location}</Row>}
                {asset.externalRef && <Row label={t('detail.externalRef')}>{asset.externalRef}</Row>}
                {asset.dataResidency && <Row label={t('detail.dataResidency')}>{asset.dataResidency}</Row>}
                {asset.retentionUntil && <Row label={t('detail.retentionUntil')}>{formatDate(asset.retentionUntil)}</Row>}
                {asset.dependencies && <Row label={t('detail.dependencies')}>{asset.dependencies}</Row>}
                {asset.businessProcesses && <Row label={t('detail.businessProcesses')}>{asset.businessProcesses}</Row>}
                {asset.retention && <Row label={t('detail.retention')}>{asset.retention}</Row>}
            </div>
            <div className="mt-auto flex justify-end pt-4">
                <Link
                    href={tenantHref(`/assets/${asset.id}`)}
                    id="asset-panel-full-view"
                    className={buttonVariants({ variant: 'primary', size: 'sm' })}
                >
                    {t('detail.fullView')}
                </Link>
            </div>
        </div>
    );
}
