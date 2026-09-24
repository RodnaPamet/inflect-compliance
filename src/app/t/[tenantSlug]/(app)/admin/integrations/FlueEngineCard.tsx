'use client';

/* TODO(swr-migration): fetch-on-mount + setState, matching the parent
 * integrations page. Migrate together to useTenantSWR. */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { CheckCircle, XCircle } from 'lucide-react';

import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { useTranslations } from 'next-intl';

type TermKey = 'ENV' | 'TENANT' | 'BUILD' | 'WORKFLOW' | 'REGISTERED_AGENT' | 'BOUND_KEY';

interface Term {
    key: TermKey;
    satisfied: boolean;
    actor: 'operator' | 'tenant';
    count?: number;
}

interface WiringState {
    mode: string;
    effective: { driver: string; reason: string | null };
    terms: Term[];
    ready: boolean;
    blockedOn: TermKey | null;
}

/**
 * The Flue engine's wiring card on Admin → Integrations.
 *
 * ── WHY THIS IS A CARD AND NOT A SETTINGS ROW ───────────────────────────────
 *
 * The tenant's driver toggle already had a route and NO page — the surface
 * census in `tests/guards/agentic-route-inbound-links.test.ts` records
 * `admin/agent-driver` as "API surface without a user-facing page". A toggle
 * with no page is the same defect the usecase behind it was written to end,
 * one level up: reachable by curl and by nothing else.
 *
 * It is a card rather than a row because the toggle is one of SIX terms, and
 * on its own it tells an operator almost nothing. Five of six satisfied looks
 * exactly like none: every run executes on the static engine and succeeds.
 *
 * ── THE CARD DOES NOT DECIDE WHICH TERM BLOCKS ──────────────────────────────
 *
 * `getFlueWiringState` does, and this renders what it says. Deriving
 * satisfaction here from a flat payload would put a second copy of the
 * conjunction in the browser, which is how a settings page comes to report a
 * capability the runtime refuses.
 */
export function FlueEngineCard() {
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const t = useTranslations('admin');

    const [state, setState] = useState<WiringState | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/admin/flue-wiring'));
            if (res.ok) setState(await res.json());
        } catch {
            /* read-only load */
        }
    }, [apiUrl]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { void load(); }, [load]);

    const setMode = useCallback(
        async (mode: 'STATIC' | 'FLUE') => {
            setBusy(true);
            setError(null);
            try {
                const res = await fetch(apiUrl('/admin/agent-driver'), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode }),
                });
                if (!res.ok) {
                    setError(t('flue.saveFailed'));
                    return;
                }
                await load();
            } catch {
                setError(t('flue.saveFailed'));
            } finally {
                setBusy(false);
            }
        },
        [apiUrl, load, t],
    );

    if (!state) return null;

    /** Where a tenant-owned term is fixed. Operator terms have no link — see `actor`. */
    const fixHref = (key: TermKey): string | null => {
        if (key === 'REGISTERED_AGENT') return tenantHref('/admin/agents');
        if (key === 'BOUND_KEY') return tenantHref('/admin/api-keys');
        return null;
    };

    return (
        <Card className="space-y-default p-6" data-testid="flue-engine-card">
            <div className="flex items-center justify-between">
                <Heading level={2}>{t('flue.title')}</Heading>
                <div className="flex items-center gap-default">
                    <StatusBadge variant={state.ready ? 'success' : 'neutral'}>
                        {state.ready ? t('flue.statusReady') : t('flue.statusBlocked')}
                    </StatusBadge>
                    {state.mode === 'FLUE' ? (
                        <Button variant="ghost" size="sm" onClick={() => setMode('STATIC')} disabled={busy}>
                            {t('flue.optOut')}
                        </Button>
                    ) : (
                        <Button variant="primary" size="sm" onClick={() => setMode('FLUE')} disabled={busy}>
                            {t('flue.optIn')}
                        </Button>
                    )}
                </div>
            </div>

            <p className="text-sm text-content-muted">{t('flue.description')}</p>

            {/* The headline, and the reason the card exists: what runs TODAY,
                which is not what the toggle alone would suggest. */}
            <InlineNotice variant={state.ready ? 'success' : 'info'}>
                {state.ready
                    ? t('flue.runsOnFlue')
                    : t('flue.runsOnStatic', { term: t(`flue.term.${state.blockedOn ?? 'ENV'}`) })}
            </InlineNotice>

            {error && <InlineNotice variant="error">{error}</InlineNotice>}

            <ul className="space-y-tight">
                {state.terms.map((term) => {
                    const href = fixHref(term.key);
                    return (
                        <li key={term.key} className="flex items-center gap-default text-sm">
                            {term.satisfied ? (
                                <CheckCircle className="h-4 w-4 text-status-success" aria-hidden="true" />
                            ) : (
                                <XCircle className="h-4 w-4 text-content-muted" aria-hidden="true" />
                            )}
                            <span className={term.satisfied ? 'text-content-default' : 'text-content-muted'}>
                                {t(`flue.term.${term.key}`)}
                            </span>
                            {typeof term.count === 'number' && (
                                <span className="text-xs text-content-muted tabular-nums">
                                    {t('flue.count', { count: term.count })}
                                </span>
                            )}
                            <span className="ml-auto flex items-center gap-default">
                                {term.actor === 'operator' && (
                                    <span className="text-xs text-content-muted">{t('flue.operatorTerm')}</span>
                                )}
                                {!term.satisfied && href && (
                                    <Link href={href} className="text-sm text-content-link">
                                        {t('flue.fix')}
                                    </Link>
                                )}
                            </span>
                        </li>
                    );
                })}
            </ul>

            {/* The term that surprises people, spelled out rather than left to
                the checklist: a browser session carries no `agentId`, so a
                human admin cannot start a Flue run from the runs page at all. */}
            <p className="text-xs text-content-muted">{t('flue.boundKeyNote')}</p>
        </Card>
    );
}
