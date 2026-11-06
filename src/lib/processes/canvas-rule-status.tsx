'use client';

/**
 * Each Action or Agent step's rule, as the step shows it on the canvas.
 *
 * A step that owns a rule read like any other box: nothing on the canvas said
 * whether its rule was a draft, enabled, or still missing what it needs to
 * run, so the canvas and the Rules tab could disagree without anyone seeing.
 * The load-time hydration (`ruleStatus` merged into `dataJson`) was a snapshot,
 * stale the moment the rule was toggled.
 *
 * This reads the live rules list (the same SWR key the Rules tab, the
 * inspector and the rule builder revalidate), so a change made anywhere shows
 * on the step. The text is translated HERE, because a tldraw shape body has no
 * translator: it renders inside the canvas, and its own tests render it with no
 * NextIntl provider. Same split as the execution overlay.
 *
 * ALWAYS MOUNTED, GATED BY `enabled`, for the overlay's reason: the step reads
 * this context unconditionally, so a document map gets an empty map rather
 * than a missing provider, and fetches nothing.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { CACHE_KEYS } from '@/lib/swr-keys';

export interface StepRuleStatus {
    /** The stored status, as a fact a test can read. */
    status: string;
    /** What the step shows: status, then run count. */
    text: string;
    tone: 'success' | 'warning' | 'neutral';
}

interface RuleListRow {
    id: string;
    status: string;
    executionCount: number;
    readiness?: string[];
}

const RuleStatusContext = createContext<ReadonlyMap<string, StepRuleStatus>>(new Map());

export function CanvasRuleStatusProvider({
    enabled,
    children,
}: {
    enabled: boolean;
    children: ReactNode;
}) {
    const t = useTranslations('automation.stepRuleStatus');
    const { data } = useTenantSWR<RuleListRow[]>(enabled ? CACHE_KEYS.automation.rules.list() : null);
    const map = useMemo(() => {
        const m = new Map<string, StepRuleStatus>();
        for (const r of data ?? []) {
            const needsSetup = r.status !== 'ENABLED' && (r.readiness?.length ?? 0) > 0;
            const statusText =
                r.status === 'ENABLED'
                    ? t('enabled')
                    : r.status === 'DISABLED'
                      ? t('disabled')
                      : needsSetup
                        ? t('draftNeedsSetup')
                        : t('draft');
            m.set(r.id, {
                status: r.status,
                text: `${statusText} · ${t('runs', { count: r.executionCount })}`,
                tone: r.status === 'ENABLED' ? 'success' : needsSetup ? 'warning' : 'neutral',
            });
        }
        return m;
    }, [data, t]);
    return <RuleStatusContext.Provider value={map}>{children}</RuleStatusContext.Provider>;
}

/** The status of the rule a step owns, or undefined (no rule, or not an automation map). */
export function useStepRuleStatus(ruleId: string | undefined): StepRuleStatus | undefined {
    const map = useContext(RuleStatusContext);
    return ruleId ? map.get(ruleId) : undefined;
}
