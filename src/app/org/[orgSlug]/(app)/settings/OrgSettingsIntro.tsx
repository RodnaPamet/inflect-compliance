'use client';

/**
 * The line under the Settings heading: WHICH organization these settings
 * belong to (#4850). The page named neither the organization nor its address,
 * so a member of two organizations could not tell from the page whose
 * switches they were about to change. The name comes from the org provider
 * the layout mounts, which read it with the membership check.
 */
import { useTranslations } from 'next-intl';
import { useOrgContext } from '@/lib/org-context-provider';

export function OrgSettingsIntro() {
    const t = useTranslations('org.settings');
    const { orgName, orgSlug } = useOrgContext();
    return (
        <p className="mt-1 max-w-3xl text-sm text-content-muted" data-testid="org-settings-intro">
            {t.rich('intro', {
                org: orgName,
                slug: orgSlug,
                b: (chunks) => <span className="font-medium text-content-default">{chunks}</span>,
            })}
        </p>
    );
}
