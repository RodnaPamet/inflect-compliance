'use client';

import { Lock, ArrowUpRight } from 'lucide-react';
import { useTenantContext, useTenantHref } from '@/lib/tenant-context-provider';
import { hasFeature, FEATURE_LABELS, getRequiredPlan } from '@/lib/entitlements';
import type { FeatureKey } from '@/lib/entitlements';
import Link from 'next/link';
import { Tooltip } from '@/components/ui/tooltip';
import { useTranslations } from 'next-intl';

/**
 * Client-side gate for premium features.
 *
 * If the tenant's plan includes the feature, renders children normally.
 * Otherwise, shows a lock icon with upgrade prompt or hides entirely.
 *
 * Usage:
 *   <UpgradeGate feature="PDF_EXPORTS">
 *     <PdfExportButton ... />
 *   </UpgradeGate>
 *
 *   <UpgradeGate feature="AUDIT_PACK_SHARING" mode="hide">
 *     <button>Share</button>
 *   </UpgradeGate>
 */
export function UpgradeGate({
    feature,
    children,
    mode = 'lock',
}: {
    feature: FeatureKey;
    children: React.ReactNode;
    /** 'lock' shows upgrade prompt, 'hide' hides entirely */
    mode?: 'lock' | 'hide';
}) {
    const { plan } = useTenantContext();
    const tenantHref = useTenantHref();

    // No billing configured → all features available (ungated)
    if (!plan || hasFeature(plan, feature)) {
        return <>{children}</>;
    }

    if (mode === 'hide') {
        return null;
    }

    const requiredPlan = getRequiredPlan(feature);
    const t = useTranslations('billing.upgradeGate');
    // FEATURE_LABELS is English-only. Prefer a localized label keyed on the
    // feature and fall back to it, so a new FEATURE_KEY renders in English
    // rather than as a missing-key crash.
    const label = t.has?.(`feature.${feature}`)
        ? t(`feature.${feature}` as Parameters<typeof t>[0])
        : FEATURE_LABELS[feature];

    return (
        <div className="relative inline-flex items-center gap-tight">
            <div className="opacity-40 pointer-events-none select-none">
                {children}
            </div>
            {/* Localized. Every gated button on the reports hub rendered this
                tooltip and aria-label in English regardless of locale, because
                both were template literals over an English-only FEATURE_LABELS
                map — so a bg user met English at exactly the moment they were
                being asked to spend money. */}
            <Tooltip
                title={label}
                content={t('requiresPlan', { plan: requiredPlan })}
            >
                <Link
                    href={tenantHref('/admin/billing')}
                    className="inline-flex items-center gap-1.5 text-xs text-[var(--brand-default)] hover:text-[var(--brand-emphasis)] transition whitespace-nowrap"
                    aria-label={t('requiresPlanAria', { label, plan: requiredPlan })}
                >
                    <Lock className="w-3 h-3" />
                    {requiredPlan}
                    <ArrowUpRight className="w-3 h-3" />
                </Link>
            </Tooltip>
        </div>
    );
}
