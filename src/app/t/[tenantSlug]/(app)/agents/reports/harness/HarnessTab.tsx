'use client';

/**
 * THE HARNESS TAB on `/agents/reports` (#3687) — what the scanners found, as
 * of each one's latest scan, with drift, the shadow list and the scan history.
 *
 * ZERO IS NEVER COMPLETE. With no scan at all this tab renders a FINDING, not
 * an empty state: the pack's inventory can say "no agents are registered" as a
 * complete answer because the register is its whole population, but a scan
 * population that does not exist means nothing has looked for agents OUTSIDE
 * the register — so "no agents" here would be a claim about an estate nobody
 * observed.
 *
 * REPORT-ONLY. Levels are rendered, never acted on: nothing on this tab gates
 * an agent, and the notice at the top says so.
 *
 * THE THREE WRITES are the owner's shortfall acceptance, the scanner-key
 * register and the registration intake from the shadow list (#3712). Each posts
 * to its own route and then refreshes this server read; the tab holds no copy
 * of any of them to keep in step. The intake's dialog is imported here, inside
 * the chunk `ReportsClient` loads on demand, so the pack tab never ships it.
 */
import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';

import { InlineNotice } from '@/components/ui/inline-notice';
import type {
    AcceptanceRow,
    HarnessMatrixView,
    HarnessScannerKeysView,
    MatrixRow,
    ShadowRow,
} from '@/lib/agentic/harness-read-model';

import { AcceptShortfallModal, type AcceptTarget } from './AcceptShortfallModal';
import { AcceptancesCard } from './AcceptancesCard';
import { RegisterShadowAgentModal } from './RegisterShadowAgentModal';
import { ScanHistory } from './ScanHistory';
import { ScannerKeysCard } from './ScannerKeysCard';
import { ScannerSection } from './ScannerSection';
import { ShadowList } from './ShadowList';

export function HarnessTab({
    view,
    scannerKeys,
    canRegisterShadow = false,
}: {
    view: HarnessMatrixView;
    /**
     * `null` for a reader without `admin.agent_registry` (#3710): the key
     * register is that key's to read and to change, so a view-key reader gets
     * no card rather than a list of controls that would be refused.
     */
    scannerKeys: HarnessScannerKeysView | null;
    /** The intake usecase's own rule, decided on the server. */
    canRegisterShadow?: boolean;
}) {
    const t = useTranslations('agents');
    const hasScans = view.scans.rows.length > 0;
    const [accepting, setAccepting] = useState<AcceptTarget | null>(null);
    const [registering, setRegistering] = useState<ShadowRow | null>(null);

    const acceptFromRow = useCallback((row: MatrixRow) => {
        setAccepting({
            discoveredAgentId: row.discoveredAgentId,
            agentLabel: row.registered?.name ?? row.discoveredId,
            renewing: row.acceptAffordance === 'RENEW',
            inForceUntil: row.acceptance?.expiresAt ?? null,
        });
    }, []);
    const acceptFromCard = useCallback((row: AcceptanceRow) => {
        setAccepting({
            discoveredAgentId: row.discoveredAgentId,
            agentLabel: row.agentLabel,
            renewing: row.acceptAffordance === 'RENEW',
            inForceUntil: row.inForce ? row.expiresAt : null,
        });
    }, []);

    return (
        <>
            <InlineNotice variant="info" icon={null} data-testid="harness-report-only">
                {t('harness.reportOnly')}
            </InlineNotice>

            {!hasScans ? (
                <InlineNotice variant="error" title={t('harness.noScansTitle')} data-testid="harness-no-scans">
                    {t('harness.noScansBody')}
                </InlineNotice>
            ) : (
                <>
                    {view.sections.map((section) => (
                        <ScannerSection
                            key={section.latest.id}
                            section={section}
                            scanWindow={view.scanWindow}
                            onAccept={acceptFromRow}
                        />
                    ))}
                    {view.scannersNotShown > 0 && (
                        <InlineNotice variant="warning" data-testid="harness-scanners-not-shown">
                            {t('harness.scannersNotShown', { count: view.scannersNotShown })}
                        </InlineNotice>
                    )}
                </>
            )}
            {/* A trusted scanner that has sent nothing is not a scanner that
                found nothing — said whether or not any other scanner reported. */}
            {view.scannersWithoutScan.rows.length > 0 && (
                <InlineNotice variant="warning" data-testid="harness-scanners-without-scan">
                    {t('harness.scannersWithoutScan', {
                        count: view.scannersWithoutScan.rows.length,
                        window: view.scanWindow,
                        names: view.scannersWithoutScan.rows.map((r) => r.name ?? r.agentId).join(', '),
                    })}
                </InlineNotice>
            )}
            {view.scannersWithoutScan.truncated && (
                <InlineNotice variant="warning" icon={null} data-testid="harness-scanners-without-scan-truncated">
                    {t('harness.scannersWithoutScanTruncated')}
                </InlineNotice>
            )}

            {/* Rendered whenever it has a row, scans or not: the calendar
                deep-links to each row's anchor. */}
            {(hasScans || view.acceptances.rows.length > 0) && (
                <AcceptancesCard acceptances={view.acceptances} onAccept={acceptFromCard} />
            )}
            {hasScans && (
                <ShadowList
                    shadow={view.shadow}
                    onRegister={canRegisterShadow ? setRegistering : null}
                />
            )}
            {hasScans && <ScanHistory scans={view.scans} scanWindow={view.scanWindow} />}
            {/* Rendered with or without scans: a key is what lets the FIRST
                report be accepted, so it cannot wait for one. */}
            {scannerKeys && <ScannerKeysCard view={scannerKeys} />}

            {accepting && <AcceptShortfallModal target={accepting} onClose={() => setAccepting(null)} />}
            {registering && canRegisterShadow && (
                <RegisterShadowAgentModal target={registering} onClose={() => setRegistering(null)} />
            )}
        </>
    );
}
