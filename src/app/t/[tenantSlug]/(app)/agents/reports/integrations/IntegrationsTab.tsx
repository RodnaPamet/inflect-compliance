'use client';

/**
 * THE INTEGRATIONS TAB on `/agents/reports` — the third-party applications a
 * directory (Entra, Okta, GitHub) has granted access to, as each trusted
 * scanner's latest `scanent-integrations/1` report found them.
 *
 * READ-ONLY. The scan's findings are raised by the ingest and live in the
 * findings register; this tab shows them beside the application they are
 * about, and changes nothing.
 *
 * ZERO IS NEVER COMPLETE, as on the harness tab. No scan at all, a scan that
 * read every source and found no application, and a trusted scanner that has
 * sent no such report are each a stated condition, never an empty state: a
 * population nobody read is not a population with nothing in it.
 *
 * Everything arrives as plain data from `getThirdPartyAppInventory`. The
 * contract's modules require `crypto`, so none of them is imported here.
 */
import { useTranslations } from 'next-intl';

import { InlineNotice } from '@/components/ui/inline-notice';
import type { ThirdPartyAppInventoryView } from '@/lib/agentic/third-party-app-read-model';

import { IntegrationsSection } from './IntegrationsSection';

export function IntegrationsTab({ view }: { view: ThirdPartyAppInventoryView }) {
    const t = useTranslations('agents');
    const hasScans = view.sections.length > 0;

    return (
        <>
            <InlineNotice variant="info" icon={null} data-testid="integrations-read-only">
                {t('reports.integrations.readOnly')}
            </InlineNotice>

            {!hasScans ? (
                <InlineNotice
                    variant="error"
                    title={t('reports.integrations.noScansTitle')}
                    data-testid="integrations-no-scans"
                >
                    {t('reports.integrations.noScansBody')}
                </InlineNotice>
            ) : (
                view.sections.map((section) => <IntegrationsSection key={section.scan.id} section={section} />)
            )}

            {view.scannersNotShown > 0 && (
                <InlineNotice variant="warning" data-testid="integrations-scanners-not-shown">
                    {t('reports.integrations.scannersNotShown', { count: view.scannersNotShown })}
                </InlineNotice>
            )}
            {/* A trusted scanner that has sent no application report has read
                nothing, as far as this page can see: said whether or not any
                other scanner reported. */}
            {view.scannersWithoutScan.rows.length > 0 && (
                <InlineNotice variant="warning" data-testid="integrations-scanners-without-scan">
                    {t('reports.integrations.scannersWithoutScan', {
                        count: view.scannersWithoutScan.rows.length,
                        window: view.scanWindow,
                        names: view.scannersWithoutScan.rows.map((r) => r.name ?? r.agentId).join(', '),
                    })}
                </InlineNotice>
            )}
            {view.scannersWithoutScan.truncated && (
                <InlineNotice variant="warning" icon={null} data-testid="integrations-scanners-without-scan-truncated">
                    {t('reports.integrations.scannersWithoutScanTruncated')}
                </InlineNotice>
            )}
            {view.scansTruncated && (
                <InlineNotice variant="warning" icon={null} data-testid="integrations-scans-truncated">
                    {t('reports.integrations.scansTruncated', { count: view.scanWindow })}
                </InlineNotice>
            )}
            {view.findingsTruncated && (
                <InlineNotice variant="warning" icon={null} data-testid="integrations-findings-truncated">
                    {t('reports.integrations.findingsTruncated')}
                </InlineNotice>
            )}
        </>
    );
}
