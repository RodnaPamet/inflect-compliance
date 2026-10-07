import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import {
    ShieldCheck,
    Globe,
    Timer2,
    Sitemap,
    DatabaseKey,
    UserFocus,
} from '@inflect/ui/components/ui/icons/nucleo';

import { getTenantCtx } from '@/app-layer/context';
import { getPrivacyPosture } from '@/app-layer/usecases/privacy-posture';
import { Card } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';

export const dynamic = 'force-dynamic';

/**
 * Privacy & data protection — Server Component, READ-ONLY by design.
 *
 * This page reports the tenant's actual data-protection posture. It
 * deliberately offers no controls: every item below is either configured on
 * another surface (evidence retention, vendor sub-processors) or is not
 * tenant-configurable at all (sweep windows, residency region).
 *
 * The honesty rules this page exists to hold — each corresponds to a flag on
 * `PrivacyPosture`, so the copy cannot drift from what the backend does:
 *
 *   • Residency is labelled DECLARATIVE. `Tenant.region` records a
 *     commitment; production is single-region. Printing "EU_WEST_1" without
 *     that qualifier would read as an enforcement guarantee.
 *   • Retention windows are shown as PLATFORM defaults, not tenant settings,
 *     because that is what they are.
 *   • DSAR gets an explicit "not enabled" notice instead of a request queue.
 *     The model exists but both jobs throw and are unregistered — an intake
 *     form here would imply a working GDPR Art.15/17 pipeline. On a
 *     compliance product that is the one mistake worth engineering against.
 */
export default async function AdminPrivacyPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const resolved = await params;
    const ctx = await getTenantCtx(resolved);
    const posture = await getPrivacyPosture(ctx);
    const t = await getTranslations('admin');

    const tenantHref = (path: string) => `/t/${resolved.tenantSlug}${path}`;
    const iconCls = 'w-4 h-4 text-content-muted';
    const yes = t('privacy.yes');
    const no = t('privacy.no');

    return (
        <div className="space-y-section animate-fadeIn" id="admin-privacy-page">
            <div className="space-y-default">
                <PageBreadcrumbs
                    items={[
                        { label: t('crumb.dashboard'), href: tenantHref('/dashboard') },
                        { label: t('title'), href: tenantHref('/admin') },
                        { label: t('privacy.title') },
                    ]}
                />
                {/* Resolves its own destination from the pathname — `/admin/privacy`
                    is registered in SUBPAGES, so this lands on `/admin`. */}
                <BackAffordance />
                <Heading level={1}>{t('privacy.title')}</Heading>
                <p className="text-sm text-content-muted max-w-2xl">{t('privacy.subtitle')}</p>
            </div>

            {/* ── Encryption ── */}
            <Card className="space-y-default" id="privacy-encryption-card">
                <div className="flex items-center gap-compact">
                    <ShieldCheck className={iconCls} />
                    <Heading level={2}>{t('privacy.encryption.title')}</Heading>
                </div>
                <dl className="space-y-tight text-sm">
                    <div className="flex items-center justify-between gap-default">
                        <dt className="text-content-muted">{t('privacy.encryption.perTenantDek')}</dt>
                        <dd>
                            <StatusBadge variant={posture.encryption.perTenantDek ? 'success' : 'warning'}>
                                {posture.encryption.perTenantDek ? t('privacy.encryption.active') : t('privacy.encryption.globalKeyOnly')}
                            </StatusBadge>
                        </dd>
                    </div>
                    <div className="flex items-center justify-between gap-default">
                        <dt className="text-content-muted">{t('privacy.encryption.rotation')}</dt>
                        <dd>
                            <StatusBadge variant={posture.encryption.rotationInFlight ? 'info' : 'neutral'}>
                                {posture.encryption.rotationInFlight ? t('privacy.encryption.rotationInFlight') : t('privacy.encryption.rotationIdle')}
                            </StatusBadge>
                        </dd>
                    </div>
                </dl>
                <p className="text-xs text-content-muted">{t('privacy.encryption.note')}</p>
            </Card>

            {/* ── Data residency ── */}
            <Card className="space-y-default" id="privacy-residency-card">
                <div className="flex items-center gap-compact">
                    <Globe className={iconCls} />
                    <Heading level={2}>{t('privacy.residency.title')}</Heading>
                </div>
                <dl className="space-y-tight text-sm">
                    <div className="flex items-center justify-between gap-default">
                        <dt className="text-content-muted">{t('privacy.residency.region')}</dt>
                        <dd className="font-medium">{posture.residency.region}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-default">
                        <dt className="text-content-muted">{t('privacy.residency.infrastructure')}</dt>
                        <dd>
                            <StatusBadge variant={posture.residency.provisioned ? 'success' : 'warning'}>
                                {posture.residency.provisioned ? t('privacy.residency.provisioned') : t('privacy.residency.notProvisioned')}
                            </StatusBadge>
                        </dd>
                    </div>
                </dl>
                {/* The load-bearing caveat — see the file header. */}
                <InlineNotice variant="info">{t('privacy.residency.declarativeNotice')}</InlineNotice>
            </Card>

            {/* ── Retention ── */}
            <Card className="space-y-default" id="privacy-retention-card">
                <div className="flex items-center gap-compact">
                    <Timer2 className={iconCls} />
                    <Heading level={2}>{t('privacy.retention.title')}</Heading>
                </div>
                <dl className="space-y-tight text-sm">
                    <div className="flex items-center justify-between gap-default">
                        <dt className="text-content-muted">{t('privacy.retention.softDelete')}</dt>
                        <dd className="font-medium">{t('privacy.retention.days', { count: posture.retention.softDeleteGraceDays })}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-default">
                        <dt className="text-content-muted">{t('privacy.retention.evidencePurge')}</dt>
                        <dd className="font-medium">{t('privacy.retention.days', { count: posture.retention.evidencePurgeDays })}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-default">
                        <dt className="text-content-muted">{t('privacy.retention.evidenceWithRule')}</dt>
                        <dd className="font-medium">{posture.retention.evidenceWithRetentionRule}</dd>
                    </div>
                </dl>
                <p className="text-xs text-content-muted">
                    {posture.retention.tenantConfigurable
                        ? t('privacy.retention.configurableNote')
                        : t('privacy.retention.platformDefaultNote')}
                </p>
            </Card>

            {/* ── Sub-processors ── */}
            <Card className="space-y-default" id="privacy-subprocessors-card">
                <div className="flex items-center gap-compact">
                    <Sitemap className={iconCls} />
                    <Heading level={2}>{t('privacy.subProcessors.title')}</Heading>
                </div>
                <dl className="space-y-tight text-sm">
                    <div className="flex items-center justify-between gap-default">
                        <dt className="text-content-muted">{t('privacy.subProcessors.flaggedVendors')}</dt>
                        <dd className="font-medium">{posture.subProcessors.flaggedVendorCount}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-default">
                        <dt className="text-content-muted">{t('privacy.subProcessors.relationships')}</dt>
                        <dd className="font-medium">{posture.subProcessors.relationshipCount}</dd>
                    </div>
                </dl>
                <p className="text-xs text-content-muted">{t('privacy.subProcessors.note')}</p>
            </Card>

            {/* ── Audit streaming ── */}
            <Card className="space-y-default" id="privacy-audit-stream-card">
                <div className="flex items-center gap-compact">
                    <DatabaseKey className={iconCls} />
                    <Heading level={2}>{t('privacy.auditStream.title')}</Heading>
                </div>
                <div className="flex items-center justify-between gap-default text-sm">
                    <span className="text-content-muted">{t('privacy.auditStream.destination')}</span>
                    <StatusBadge variant={posture.auditStream.configured ? 'success' : 'neutral'}>
                        {posture.auditStream.configured ? yes : no}
                    </StatusBadge>
                </div>
                <p className="text-xs text-content-muted">{t('privacy.auditStream.note')}</p>
            </Card>

            {/* ── DSAR ── Intake and fulfilment are reported SEPARATELY: the
                 register records requests, but nothing here exports or erases.
                 A single "DSAR: enabled" line would imply a pipeline that does
                 not exist. ── */}
            <Card className="space-y-default" id="privacy-dsar-card">
                <div className="flex items-center gap-compact">
                    <UserFocus className={iconCls} />
                    <Heading level={2}>{t('privacy.dsar.title')}</Heading>
                </div>
                <dl className="space-y-tight text-sm">
                    <div className="flex items-center justify-between gap-default">
                        <dt className="text-content-muted">{t('privacy.dsar.register')}</dt>
                        <dd>
                            <StatusBadge variant={posture.dsar.intakeEnabled ? 'success' : 'neutral'}>
                                {posture.dsar.intakeEnabled ? t('privacy.dsar.registerOn') : t('privacy.dsar.registerOff')}
                            </StatusBadge>
                        </dd>
                    </div>
                    <div className="flex items-center justify-between gap-default">
                        <dt className="text-content-muted">{t('privacy.dsar.fulfilment')}</dt>
                        <dd>
                            <StatusBadge variant={posture.dsar.automatedFulfilment ? 'success' : 'warning'}>
                                {posture.dsar.automatedFulfilment ? t('privacy.dsar.fulfilmentAuto') : t('privacy.dsar.fulfilmentManual')}
                            </StatusBadge>
                        </dd>
                    </div>
                </dl>
                {!posture.dsar.automatedFulfilment && (
                    <InlineNotice variant="warning" title={t('privacy.dsar.manualTitle')}>
                        {t('privacy.dsar.manualBody')}
                    </InlineNotice>
                )}
                {posture.dsar.intakeEnabled && (
                    <Link
                        href={tenantHref('/admin/dsar-requests')}
                        className="text-sm text-content-accent hover:underline"
                        id="privacy-dsar-register-link"
                    >
                        {t('privacy.dsar.openRegister')}
                    </Link>
                )}
            </Card>
        </div>
    );
}
