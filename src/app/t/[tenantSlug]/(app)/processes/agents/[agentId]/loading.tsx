import { getTranslations } from 'next-intl/server';
import { SkeletonDetailTabs } from '@/components/ui/skeleton';

/**
 * Agent-canvas loading skeleton — header + meta strip + the two tabs.
 *
 * Required by `tests/guards/detail-route-loading-coverage`: without it the
 * route falls back to an ancestor's skeleton, which is not this page's shape,
 * and the page waits on the projection's reads, so the
 * wait is real.
 */
export default async function AgentCanvasLoading() {
    const t = await getTranslations('agentCanvas');
    return (
        <div
            role="status"
            aria-live="polite"
            aria-busy="true"
            aria-label={t('loadingAria')}
            className="space-y-section animate-fadeIn"
        >
            {/* Two, the canvas and the Elements list, so the tab bar does not
                shift on hydration. */}
            <SkeletonDetailTabs tabCount={2} />
        </div>
    );
}
