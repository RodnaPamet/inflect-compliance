'use client';

/**
 * Execution history panel (Automation Epic 6).
 *
 * The GRC audit trail for a single rule: recent executions with status,
 * trigger source, duration, and an expandable error/outcome line. Reads the
 * cursor-paginated executions endpoint (first page) via SWR.
 *
 * It had a "Re-trigger" button too, and it was removed rather than fixed.
 * It called the same endpoint as Monitor's "Test a rule" → Fire, but read
 * only the status: the server answers 200 with `enqueued: false` when there
 * is nothing to replay, and the button said "Re-run queued" for a run that
 * never happened. It was also offered to every role, while the server takes
 * the write tier. Fire reports each outcome, and is offered to the roles that
 * can use it.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import useSWR from 'swr';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { formatDateTime } from '@inflect/ui/lib/format-date';
import { InlineNotice } from '@/components/ui/inline-notice';
import { ApiClientError } from '@/lib/api-client';
import {
    buildExecutionStatusLabels,
    buildTriggerSourceLabels,
} from '@/lib/automation/execution-status-labels';

interface ExecutionRow {
    id: string;
    status: string;
    triggeredBy: string;
    durationMs: number | null;
    errorMessage: string | null;
    createdAt: string;
}

const STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
    SUCCEEDED: 'success',
    FAILED: 'error',
    RUNNING: 'info',
    PENDING: 'neutral',
    SKIPPED: 'neutral',
};

export function ExecutionsPanel({ ruleId }: { ruleId: string }) {
    const t = useTranslations('automation.executions');
    const apiUrl = useTenantApiUrl();
    // Shared with MonitorTab — see execution-status-labels.ts for why these
    // stopped being a local record.
    const statusLabels = buildExecutionStatusLabels((k) => t(k as Parameters<typeof t>[0]));
    const triggerLabels = buildTriggerSourceLabels((k) => t(k as Parameters<typeof t>[0]));
    const key = apiUrl(CACHE_KEYS.automation.rules.executions(ruleId));
    const { data, isLoading, error } = useSWR<{
        items: ExecutionRow[];
        nextCursor: string | null;
    }>(
        key,
        // `.then(r => r.json())` alone swallowed the status: a 403 or 500 body
        // parsed into an object with no `items`, so `items` fell back to `[]`
        // and the panel rendered the "no executions yet" empty state. On a
        // rule's audit trail, "we could not load this" and "this rule has never
        // run" are opposite claims and must not look identical.
        async (url: string) => {
            const r = await fetch(url);
            if (!r.ok) throw new ApiClientError(`executions ${r.status}`, 'fetch_failed', r.status);
            return r.json();
        },
    );
    const [expanded, setExpanded] = useState<string | null>(null);
    const items = data?.items ?? [];

    return (
        <div className="space-y-tight">
            <p className="text-[11px] uppercase tracking-wide text-content-subtle">
                {t('recent')}
            </p>
            {error ? (
                <InlineNotice variant="error">{t('loadError')}</InlineNotice>
            ) : isLoading ? (
                <p className="text-sm text-content-muted">{t('loading')}</p>
            ) : items.length === 0 ? (
                <p className="text-sm text-content-subtle">{t('empty')}</p>
            ) : (
                <ul className="space-y-tight" data-testid="executions-list">
                    {items.map((e) => (
                        <li key={e.id} className="rounded-md border border-border-subtle p-2">
                            <button
                                type="button"
                                className="flex w-full items-center justify-between gap-compact text-left"
                                onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                            >
                                <span className="flex items-center gap-compact">
                                    <StatusBadge variant={STATUS_VARIANT[e.status] ?? 'neutral'}>
                                        {statusLabels[e.status] ?? e.status}
                                    </StatusBadge>
                                    <span className="text-xs text-content-muted">
                                        {triggerLabels[e.triggeredBy] ?? e.triggeredBy}
                                    </span>
                                </span>
                                <span className="text-xs text-content-subtle tabular-nums">
                                    {formatDateTime(e.createdAt)}
                                </span>
                            </button>
                            {expanded === e.id && (
                                <div className="mt-2 space-y-tight text-xs text-content-muted">
                                    {e.durationMs != null && (
                                        <p>{t('duration', { ms: e.durationMs })}</p>
                                    )}
                                    {e.errorMessage && (
                                        <p className="text-content-error">{e.errorMessage}</p>
                                    )}
                                </div>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
