'use client';

/**
 * Epic 46 — compact compliance-status indicator.
 *
 * Used in tree rows, the minimap section tiles, and (by the
 * detail pane) anywhere a `ComplianceStatus` needs a visual
 * shorthand. Three render modes:
 *
 *   - `dot`  — 8×8 colored dot. Used in tree rows where the row
 *              already carries the requirement code + title.
 *   - `chip` — pill with label text + colored background. Used in
 *              the detail pane and section headers.
 *   - `bar`  — narrow vertical strip. Used in the minimap to give
 *              a section a visible color band without adding a
 *              text label.
 *
 * Every mode carries a stable `aria-label` so the meaning is
 * available to screen readers regardless of the visual mode.
 *
 * Color token mapping is centralised so the same hue is used
 * everywhere — drift between tree dots, minimap bars, and the
 * detail pane has been a recurring failure mode in compliance UIs.
 */

import { cn } from '@inflect/ui/lib/cn';
import type { ComplianceStatus } from '@/lib/framework-tree/types';

// ─── Token map ─────────────────────────────────────────────────────────

interface StatusVisual {
    label: string;
    /** Background utility for chips + bars. */
    bg: string;
    /** Foreground utility for chip labels. */
    fg: string;
    /** Solid color used for dots + bar fill. */
    solid: string;
}

const STATUS_VISUALS: Record<ComplianceStatus, StatusVisual> = {
    compliant: {
        label: 'Compliant',
        bg: 'bg-bg-success',
        fg: 'text-content-success',
        solid: 'bg-bg-success-emphasis',
    },
    partial: {
        label: 'Partial',
        bg: 'bg-bg-warning',
        fg: 'text-content-warning',
        solid: 'bg-bg-warning-emphasis',
    },
    gap: {
        label: 'Gap',
        bg: 'bg-bg-error',
        fg: 'text-content-error',
        solid: 'bg-bg-error-emphasis',
    },
    na: {
        label: 'N/A',
        bg: 'bg-slate-500/15',
        fg: 'text-slate-300',
        solid: 'bg-slate-500',
    },
    unknown: {
        label: 'No data',
        bg: 'bg-slate-500/10',
        fg: 'text-slate-400',
        solid: 'bg-slate-600',
    },
};

export function getStatusVisual(status: ComplianceStatus): StatusVisual {
    return STATUS_VISUALS[status];
}

// ─── Public component ──────────────────────────────────────────────────

export interface ComplianceStatusIndicatorProps {
    status: ComplianceStatus;
    mode?: 'dot' | 'chip' | 'bar';
    className?: string;
    /**
     * When true (default), the indicator carries an `aria-label`
     * with the status word. Pass `false` only when the parent has
     * already labelled the row (e.g. the detail panel headline
     * carries the status word in plain text).
     */
    labelled?: boolean;
}

export function ComplianceStatusIndicator({
    status,
    mode = 'dot',
    className,
    labelled = true,
}: ComplianceStatusIndicatorProps) {
    const v = STATUS_VISUALS[status];
    const ariaLabel = labelled ? `Compliance status: ${v.label}` : undefined;
    const dataAttrs = { 'data-status': status } as const;

    if (mode === 'chip') {
        return (
            <span
                role={labelled ? 'status' : undefined}
                aria-label={ariaLabel}
                className={cn(
                    'inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium',
                    v.bg,
                    v.fg,
                    className,
                )}
                {...dataAttrs}
            >
                <span className={cn('w-1.5 h-1.5 rounded-full', v.solid)} aria-hidden="true" />
                {v.label}
            </span>
        );
    }

    if (mode === 'bar') {
        return (
            <span
                role={labelled ? 'status' : undefined}
                aria-label={ariaLabel}
                className={cn('block w-1 rounded-sm', v.solid, className)}
                {...dataAttrs}
            />
        );
    }

    // 'dot'
    return (
        <span
            role={labelled ? 'status' : undefined}
            aria-label={ariaLabel}
            className={cn('inline-block w-2 h-2 rounded-full flex-shrink-0', v.solid, className)}
            {...dataAttrs}
        />
    );
}

/**
 * Re-export for callers that want the visual map without
 * re-importing the token table separately.
 */
export { STATUS_VISUALS };
