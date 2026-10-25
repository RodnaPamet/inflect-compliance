'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';
import { useTenantContext, useTenantHref } from '@/lib/tenant-context-provider';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { buttonVariants } from '@/components/ui/button';
import { Heading } from '@/components/ui/typography';
import { Card } from '@/components/ui/card';

/** The part of `getOnboardingMetrics` this card reads. */
interface OnboardingStatus {
    status: string;
}

/**
 * Dashboard card that shows "Complete Setup" while onboarding is not complete.
 * Only visible to admins.
 *
 * #4125 — it used to check `canAdmin` and nothing else, so it stayed on the
 * dashboard for good, even after the wizard had finished. It now reads the
 * status the wizard stores (`TenantOnboarding.status`, through the
 * admin-only `/onboarding/metrics` read) and hides once that is `COMPLETED`.
 * Nothing renders until the status is known, so a finished workspace never
 * flashes the card. If the read fails the card shows: an admin who has not
 * finished setup keeps the way back to it.
 */
export default function OnboardingBanner() {
    const { permissions } = useTenantContext();
    const tenantHref = useTenantHref();
    const t = useTranslations('onboarding');
    const { data, error } = useTenantSWR<OnboardingStatus>(
        permissions.canAdmin ? CACHE_KEYS.onboarding.metrics() : null,
    );

    if (!permissions.canAdmin) return null;
    if (!data && !error) return null;
    if (data?.status === 'COMPLETED') return null;

    return (
        <Card className="border-[var(--brand-default)]/30 bg-gradient-to-r from-[var(--brand-subtle)] to-[var(--brand-subtle)]">
            <div className="flex items-center gap-compact">
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[var(--brand-emphasis)] to-[var(--brand-default)] flex items-center justify-center flex-shrink-0">
                    <Sparkles className="w-5 h-5 text-white" />
                </div>
                <div className="flex-1 min-w-0">
                    <Heading level={3}>{t('banner.title')}</Heading>
                    <p className="text-xs text-content-muted mt-0.5">{t('banner.body')}</p>
                </div>
                <Link href={tenantHref('/onboarding')} className={buttonVariants({ variant: 'primary', size: 'sm', className: 'flex-shrink-0' })} data-testid="onboarding-cta">
                    <Sparkles className="w-3.5 h-3.5" /> {t('banner.continue')}
                </Link>
            </div>
        </Card>
    );
}
