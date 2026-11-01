import { notFound } from 'next/navigation';

import { getTranslations } from 'next-intl/server';

import { getOrgCtx } from '@/app-layer/context';
import { getOrgAgentSwitches } from '@/app-layer/usecases/org-agent-switches';
import { Heading } from '@/components/ui/typography';
import { OrgAgentSwitchesSection } from './OrgAgentSwitchesSection';
import { OrgSettingsIntro } from './OrgSettingsIntro';

/**
 * Organization settings (#4557). Today one section: the two agent switches an
 * organization decides for its workspaces when the deployment leaves them open.
 *
 * Every org member who can see the portfolio may read it; only
 * `canManageAgentSwitches` (ORG_ADMIN) may change a switch, and the section
 * says so to everybody else. Non-members collapse to `notFound()` through
 * `getOrgCtx`, as the rest of the org tree does.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
    params: Promise<{ orgSlug: string }>;
}

export default async function OrgSettingsPage({ params }: PageProps) {
    const { orgSlug } = await params;

    let ctx;
    try {
        ctx = await getOrgCtx({ orgSlug });
    } catch {
        notFound();
    }

    const t = await getTranslations('org.settings');
    const switches = await getOrgAgentSwitches(ctx);

    return (
        <div className="space-y-section" data-testid="org-settings-page">
            <div>
                <Heading level={1}>{t('heading')}</Heading>
                <OrgSettingsIntro />
            </div>
            <OrgAgentSwitchesSection initial={JSON.parse(JSON.stringify(switches))} />
        </div>
    );
}
