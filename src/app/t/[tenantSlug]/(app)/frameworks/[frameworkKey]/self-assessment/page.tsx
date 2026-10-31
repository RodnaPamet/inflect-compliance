import { getTranslations } from 'next-intl/server';

import { getTenantCtx } from '@/app-layer/context';
import { Nis2SelfAssessmentResume } from './Nis2SelfAssessmentResume';

export const dynamic = 'force-dynamic';

/**
 * Resume-later surface for the NIS2 self-assessment. Onboarding is the
 * FIRST entry point, not the only one — a tenant who skipped the step (or
 * finished onboarding) returns here to continue the same assessment.
 * Only meaningful for the NIS2 framework.
 */
export default async function FrameworkSelfAssessmentPage({
    params,
}: {
    params: Promise<{ tenantSlug: string; frameworkKey: string }>;
}) {
    const { tenantSlug, frameworkKey } = await params;
    // Ensure tenant access (throws/redirects on mismatch).
    const ctx = await getTenantCtx({ tenantSlug });

    if (frameworkKey.toUpperCase() !== 'NIS2') {
        const t = await getTranslations('frameworks');
        return (
            <div className="p-6">
                <p className="text-content-muted text-sm">
                    {t('selfAssessment.onlyNis2')}
                </p>
            </div>
        );
    }

    // Every read and write of the assessment takes `assertCanManageOnboarding`
    // (Owner, Admin). Anyone else was shown "Could not load…", which invites a
    // reload that fails the same way (#4734).
    if (!ctx.permissions.canAdmin) {
        const t = await getTranslations('frameworks');
        return (
            <div className="p-6">
                <p className="text-content-muted text-sm" id="nis2-self-assessment-admin-only">
                    {t('selfAssessment.adminOnly')}
                </p>
            </div>
        );
    }

    return <Nis2SelfAssessmentResume tenantSlug={tenantSlug} frameworkKey={frameworkKey} />;
}
