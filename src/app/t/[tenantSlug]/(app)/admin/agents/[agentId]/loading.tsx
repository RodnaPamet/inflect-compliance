import { getTranslations } from 'next-intl/server';
import { SkeletonDetailTabs } from '@/components/ui/skeleton';

/**
 * Agent detail loading skeleton — header + meta strip + tab bar.
 *
 * Required by `tests/guards/detail-route-loading-coverage`: without it the
 * route falls back to the nearest ancestor's skeleton, which is the agent
 * REGISTER's table — a list skeleton flashing where a detail page is about
 * to render reads as the wrong page loading.
 */
export default async function AgentDetailLoading() {
    const t = await getTranslations('admin');
    return (
        <div
            role="status"
            aria-live="polite"
            aria-busy="true"
            aria-label={t('agentDetail.loadingAria')}
            className="space-y-section animate-fadeIn"
        >
            <SkeletonDetailTabs />
        </div>
    );
}
