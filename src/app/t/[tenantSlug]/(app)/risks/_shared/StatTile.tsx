import type { ReactNode } from 'react';

/**
 * The tinted tile that a risk statistic sits in.
 *
 * B2-7 — this was 20 hand-written copies of the same `<div className="…">`
 * across four files (dashboard 8, loss-events 6, MonteCarloPanel 4,
 * RiskHistoryPanel 2). The kind of duplication a reader cannot see: nothing
 * names it, so nothing tells you the other 19 exist when you adjust one.
 *
 * ## Why not `<MetricCard>` / `<KpiCard>`
 *
 * Those primitives exist and are the right answer for a *card*. They are
 * richer components — their own border, heading slot, trend affordance and
 * padding scale — so swapping these tiles onto them would change how every
 * one of these surfaces looks. This is deliberately the minimal wrapper that
 * matches the existing markup EXACTLY, so the dedupe is invisible in the
 * rendered output. Choosing the richer primitive is a design decision; it
 * should be made on purpose, in a diff that shows the visual change, not
 * smuggled in under a refactor.
 *
 * ## Why `tone` exists
 *
 * 18 of the 20 tiles used `bg-bg-muted/30`; the two in `RiskHistoryPanel`
 * used `/20`. That difference is almost certainly drift rather than intent —
 * but "almost certainly" is not a licence to restyle two tiles inside a
 * deduplication commit. Both opacities are preserved, and the discrepancy is
 * now visible at the call site (`tone="subtle"`) instead of buried in a
 * class string, so it can be settled deliberately.
 */
export function StatTile({
    children,
    tone = 'default',
    testId,
}: {
    children: ReactNode;
    /** `subtle` is the /20 tint used only by the history sparklines. */
    tone?: 'default' | 'subtle';
    testId?: string;
}) {
    const tint = tone === 'subtle' ? 'bg-bg-muted/20' : 'bg-bg-muted/30';
    return (
        <div
            className={`rounded-md ${tint} px-default py-default`}
            {...(testId ? { 'data-testid': testId } : {})}
        >
            {children}
        </div>
    );
}
