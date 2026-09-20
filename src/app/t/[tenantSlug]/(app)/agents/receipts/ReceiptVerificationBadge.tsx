'use client';

import { BadgeCheck, TriangleWarning } from '@/components/ui/icons/nucleo';
import { StatusBadge } from '@/components/ui/status-badge';

/**
 * The verified / unverified pill on a receipt row.
 *
 * WHY THIS FILE EXISTS AT ALL — it is a React Server Components boundary fix,
 * not a component somebody wanted.
 *
 * `receipts/page.tsx` is a SERVER component and `StatusBadge` is a CLIENT one
 * (`status-badge.tsx:1`). Its `icon` prop is typed `Icon | null` — a COMPONENT,
 * which is a function. Passing `icon={BadgeCheck}` across that boundary throws
 * *"Functions cannot be passed directly to Client Components"*, and the whole
 * page falls to its error boundary.
 *
 * WHY NOBODY HIT IT. The badge is rendered inside `receipts.map(...)`, under a
 * `receipts.length === 0` guard. With no receipts the map never runs, the prop
 * is never passed, and the page renders its empty state perfectly. Every
 * production tenant has zero receipts and so does every test — so the page
 * worked everywhere it had ever been looked at, and broke on the first row it
 * was ever given. Found by `tests/e2e/agentic-surface-with-data.spec.ts`, which
 * exists to put a row in front of each of these pages.
 *
 * WHY NOT JUST DROP THE `icon` PROP. `StatusBadge` resolves a default per
 * variant, but the defaults are `CircleCheck` / `CircleWarning`, not
 * `BadgeCheck` / `TriangleWarning`. Dropping the prop would fix the crash by
 * silently changing the iconography, which is a different change wearing this
 * one's clothes. Moving the import to the client side keeps the rendering
 * identical to what the server component intended.
 *
 * The labels arrive as STRINGS because strings cross the boundary and
 * `next-intl`'s `t` on the server is itself a function that cannot.
 */
export function ReceiptVerificationBadge({
    verified,
    verifiedLabel,
    verifiedTooltip,
    unverifiedLabel,
    unverifiedTooltip,
}: {
    verified: boolean;
    verifiedLabel: string;
    verifiedTooltip: string;
    unverifiedLabel: string;
    unverifiedTooltip: string;
}) {
    return verified ? (
        <StatusBadge variant="success" icon={BadgeCheck} tooltip={verifiedTooltip}>
            {verifiedLabel}
        </StatusBadge>
    ) : (
        <StatusBadge variant="warning" icon={TriangleWarning} tooltip={unverifiedTooltip}>
            {unverifiedLabel}
        </StatusBadge>
    );
}
