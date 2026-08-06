'use client';

import { Tooltip } from '@/components/ui/tooltip';
import { formatTailAwareAle } from '@/lib/tail-language';

/**
 * The per-risk ALE chip — RQ3-4's "one formatter, two registers".
 *
 * Extracted from an inline IIFE inside a `RisksClient` column cell so the
 * two-register output can be asserted by rendering it
 * (`tests/rendered/risk-ale-chip.test.tsx`) instead of by regex-matching
 * `RisksClient.tsx`. The guard that used to do that pinned the formatter's
 * UI copy verbatim, em-dash included, so copy-editing broke the build.
 *
 * The whole point of the component is the honest-null contract: when there
 * is no ALE at all it renders NOTHING rather than a zero or a dash, because
 * a fabricated zero on a money column reads as "we measured this and it is
 * nil" when the truth is "nobody has quantified it".
 */
export function RiskAleChip({
    riskId,
    ale,
    aleP90,
    money,
    tooltip,
}: {
    riskId: string;
    /** The mean ALE. `null` when the risk has never been quantified. */
    ale: number | null;
    /** P90 from the tail-percentiles cache; `null` when no simulation exists. */
    aleP90: number | null;
    /** Matches `TailRegisterOptions['money']` — the formatter may hand it a
     *  nullish value, so the chip must not narrow the signature. */
    money: (v: number | null | undefined) => string;
    tooltip: string;
}) {
    const label = formatTailAwareAle(ale, aleP90, { money, compact: true });
    if (label === null) return null;

    return (
        <Tooltip content={tooltip}>
            <span
                className="text-[10px] tabular-nums text-content-muted"
                data-testid={`risk-ale-${riskId}`}
            >
                {label}
            </span>
        </Tooltip>
    );
}
