'use client';

/**
 * AI features: the four AI switches, and which engine runs agents.
 *
 * ═══ THE PAGE IS admin.view; ITS SECTIONS CARRY THEIR OWN KEYS ═══
 *
 * The admin layout gates this subtree on `admin.view`.
 *
 * - The AI switches sit behind `admin.tenant_lifecycle`, because that is what
 *   their endpoint takes. An admin who is not an owner would otherwise reach a
 *   rendered page and be told the settings "couldn't load", which is a
 *   permission refusal wearing the costume of a broken backend. That admin
 *   sees a sentence saying an owner decides, not a control that would 403.
 * - "Where AI runs" sits behind `admin.manage`, the key of the
 *   security-settings endpoint it reads and writes. Somebody without it is
 *   told an administrator decides, not shown a section that would 403.
 * - The "Agent engines" section renders for every admin (owner decision
 *   2026-10-25, #4139). It reads `GET /admin/agent-driver`, which is
 *   `admin.view`, and it decides for itself whether to offer the control.
 */
import { useTranslations } from 'next-intl';

import { RequirePermission } from '@/components/require-permission';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { Heading } from '@/components/ui/typography';
import { InlineNotice } from '@/components/ui/inline-notice';
import { useTenantHref } from '@/lib/tenant-context-provider';

import { AiFeaturesClient } from './AiFeaturesClient';
import { AiResidencySection } from './AiResidencySection';
import { AgentEnginesSection } from './AgentEnginesSection';

export default function AiFeaturesPage() {
    const t = useTranslations('admin');
    const tenantHref = useTenantHref();
    return (
        <div className="space-y-section" data-testid="admin-ai-features-page">
            <BackAffordance />
            <PageBreadcrumbs
                items={[
                    { label: t('nav.aiFeatures'), href: tenantHref('/admin/ai-features') },
                    { label: t('aiFeatures.breadcrumb') },
                ]}
            />

            <Heading level={1}>{t('aiFeatures.heading')}</Heading>
            <p className="max-w-3xl text-sm text-content-muted">{t('aiFeatures.intro')}</p>

            <RequirePermission
                resource="admin"
                action="tenant_lifecycle"
                fallback={
                    // The existing sentence. For this key an administrator is
                    // exactly who cannot help: it is owner-only.
                    <InlineNotice variant="info">
                        <span data-testid="ai-features-owner-only">{t('aiFeatures.forbidden')}</span>
                    </InlineNotice>
                }
            >
                <AiFeaturesClient />
            </RequirePermission>

            <RequirePermission
                resource="admin"
                action="manage"
                fallback={
                    <InlineNotice variant="info">
                        <span data-testid="ai-residency-admin-only">{t('aiResidency.forbidden')}</span>
                    </InlineNotice>
                }
            >
                <AiResidencySection />
            </RequirePermission>

            <AgentEnginesSection />
        </div>
    );
}
