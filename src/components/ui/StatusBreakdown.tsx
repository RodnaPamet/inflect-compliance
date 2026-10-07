'use client';

import { useTranslations } from 'next-intl';
import { Heading } from '@/components/ui/typography';
import { cardVariants } from '@/components/ui/card-variants';
import { cn } from '@inflect/ui/lib/cn';
/**
 * StatusBreakdown — Horizontal stacked bar with legend.
 *
 * Shows distribution of items across statuses (e.g., risk by severity,
 * tasks by status). Renders as a compact card suitable for dashboard grids.
 *
 * @example
 * ```tsx
 * <StatusBreakdown
 *     label="Risks by Severity"
 *     items={[
 *         { label: 'Critical', value: 3, color: 'bg-bg-error-emphasis' },
 *         { label: 'High', value: 8, color: 'bg-orange-500' },
 *         { label: 'Medium', value: 12, color: 'bg-bg-warning-emphasis' },
 *         { label: 'Low', value: 5, color: 'bg-bg-success-emphasis' },
 *     ]}
 * />
 * ```
 */

// ─── Props ──────────────────────────────────────────────────────────

export interface StatusItem {
    label: string;
    value: number;
    /** Tailwind bg color class */
    color: string;
}

export interface StatusBreakdownProps {
    /** Card heading */
    label: string;
    /** Status items */
    items: StatusItem[];
    /** Show numeric total in the header */
    showTotal?: boolean;
    /** Optional CSS class */
    className?: string;
    /** Optional test-id */
    id?: string;
}

// ─── Component ──────────────────────────────────────────────────────

export default function StatusBreakdown({
    label,
    items,
    showTotal = true,
    className = '',
    id,
}: StatusBreakdownProps) {
    const t = useTranslations('common.chart');
    const total = items.reduce((sum, item) => sum + item.value, 0);

    return (
        <div id={id} className={cn(cardVariants(), className)}>
            {/* Header */}
            <div className="flex items-center justify-between mb-3">
                <Heading level={3}>{label}</Heading>
                {showTotal && (
                    <span className="text-xs text-content-subtle tabular-nums">{t('total', { count: total })}</span>
                )}
            </div>

            {/* Stacked bar */}
            <div className="bg-bg-subtle rounded-full h-3 overflow-hidden">
                {total > 0 ? (
                    <div className="flex h-full">
                        {items.map((item) => {
                            if (item.value <= 0) return null;
                            const percent = (item.value / total) * 100;
                            return (
                                <div
                                    key={item.label}
                                    className={`h-full ${item.color} transition-all duration-500`}
                                    style={{ width: `${percent}%` }}
                                    title={`${item.label}: ${item.value} (${percent.toFixed(1)}%)`}
                                />
                            );
                        })}
                    </div>
                ) : (
                    <div className="h-full w-full bg-bg-subtle" title={t('noData')} />
                )}
            </div>

            {/* Legend */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mt-3">
                {items.map((item) => (
                    <div key={item.label} className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-1.5">
                            <span className={`w-2 h-2 rounded-full ${item.color} shrink-0`} />
                            <span className="text-content-muted">{item.label}</span>
                        </div>
                        <span className="text-content-default font-medium tabular-nums">{item.value}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}
