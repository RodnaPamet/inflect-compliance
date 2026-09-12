'use client';

import { useTranslations } from 'next-intl';

import {
    AUTONOMY_MAX,
    AUTONOMY_MIN,
    AUTONOMY_REQUIRED_BY_CAPABILITY,
} from '@/lib/agentic/autonomy-ceiling';
import { cn } from '@/lib/cn';

/**
 * THE AUTONOMY LADDER, IN WORDS (#2457).
 *
 * `autonomyLevel` is the central authority dial — it is a term in
 * `min(key.maxAutonomyLevel, agent.autonomyLevel, tierCap)`, evaluated at the
 * tool boundary on every call — and it rendered as a bare integer. Nobody
 * reading "4" could tell what it permitted without opening the source.
 *
 * ── THE RUNG MEANINGS ARE DERIVED, NOT RETYPED ──────────────────────
 *
 * `AUTONOMY_REQUIRED_BY_CAPABILITY` is the live mapping the boundary itself
 * uses: read=1, propose=2, orchestrate=3. Importing it means a rung that moves
 * there moves here, rather than this screen quietly describing a ladder the
 * product stopped having. The module is a zero-import leaf, so a client bundle
 * can hold it.
 *
 * ── 4 TO 6 ARE REAL RUNGS THAT GRANT NOTHING EXTRA ──────────────────
 *
 * No capability class requires a rung above 3, so registering an agent at 5
 * buys it nothing that 3 did not already. That is the single most useful thing
 * this component says, and it is invisible from the integer: an operator
 * choosing 5 believes they are granting more, and an operator auditing 5 reads
 * it as more having been granted. Stated rather than left to be inferred from
 * a table nobody has.
 *
 * Rung 0 is the other one worth saying out loud: no MCP tool sits at 0, so an
 * agent registered there can call NOTHING. "Suggests only" means it.
 */

const CAPABILITY_AT_RUNG: Record<number, 'read' | 'propose' | 'orchestrate'> = Object.fromEntries(
    Object.entries(AUTONOMY_REQUIRED_BY_CAPABILITY).map(([cls, rung]) => [rung, cls]),
) as Record<number, 'read' | 'propose' | 'orchestrate'>;

function rungKey(rung: number): string {
    if (rung === 0) return 'autonomy.rung0';
    const capability = CAPABILITY_AT_RUNG[rung];
    if (capability) return `autonomy.rung_${capability}`;
    // Above every declared capability — a real rung the CHECK constraint
    // permits, which today grants nothing the rung below did not.
    return 'autonomy.rungAboveTop';
}

export function AutonomyScale({
    level,
    className,
}: {
    /** The agent's REGISTERED rung, marked on the scale. */
    level: number;
    className?: string;
}) {
    const t = useTranslations('admin');
    const rungs = Array.from(
        { length: AUTONOMY_MAX - AUTONOMY_MIN + 1 },
        (_, i) => AUTONOMY_MIN + i,
    );

    return (
        <div className={cn('space-y-tight', className)} data-testid="autonomy-scale">
            <ol className="space-y-tight">
                {rungs.map((rung) => {
                    const current = rung === level;
                    return (
                        <li
                            key={rung}
                            data-testid={`autonomy-rung-${rung}`}
                            data-current={current ? 'true' : undefined}
                            className={cn(
                                'flex gap-tight text-sm',
                                current ? 'text-content-emphasis font-medium' : 'text-content-muted',
                            )}
                        >
                            <span className="w-4 shrink-0 tabular-nums">{rung}</span>
                            <span>
                                {t(rungKey(rung))}
                                {current && (
                                    // Marked in TEXT, not only by weight: a bold
                                    // row is invisible to a screen reader and to
                                    // anyone reading a printed assessment pack.
                                    <span
                                        className="ml-1 text-content-info"
                                        data-testid="autonomy-current-marker"
                                    >
                                        {t('autonomy.registeredHere')}
                                    </span>
                                )}
                            </span>
                        </li>
                    );
                })}
            </ol>
            <p className="text-xs text-content-muted">{t('autonomy.effectiveNote')}</p>
        </div>
    );
}
