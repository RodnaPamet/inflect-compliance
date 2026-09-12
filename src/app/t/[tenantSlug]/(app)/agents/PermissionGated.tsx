'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { Tooltip, TooltipProvider } from '@/components/ui/tooltip';

/**
 * A control the operator may not use — DISABLED and EXPLAINED, never hidden
 * and never enabled-then-403 (#2456).
 *
 * ── THE DEFECT THIS EXISTS FOR ──────────────────────────────────────
 *
 * `/agents/proposals` and `/agents/runs` are gated on `admin.view`, while every
 * mutating usecase behind their buttons opens with `assertCanWrite(ctx)` — a
 * ROLE-TIER check, not a permissions-blob key. So a READER or AUDITOR holding
 * `admin.view` reached those pages and found Approve, Reject, Start, Resume and
 * Abort rendered enabled. They returned 403 on press. An operator discovered
 * which controls were theirs by trying them, one refusal at a time.
 *
 * ── WHY DISABLED AND NOT HIDDEN ─────────────────────────────────────
 *
 * The agent detail tabs already settled this, and their docstring says it
 * better than a restatement would: "a greyed tab tells you the surface exists
 * and is not yours; a missing one would tell you the product does not have it."
 * Hiding a control answers a different question than the one the operator
 * asked, and answers it wrongly.
 *
 * The REASON is named rather than generic. "You do not have permission" tells
 * an operator nothing they can act on; naming the tier tells them what to ask
 * their administrator for.
 *
 * The wrapper adds no markup when the control IS allowed — a tooltip that never
 * fires is still a Radix subtree, and every row on these pages carries two or
 * three of these.
 */
export function PermissionGated({
    allowed,
    reason,
    children,
}: {
    allowed: boolean;
    /** What the operator lacks, in words they can take to an administrator. */
    reason: string;
    children: ReactNode;
}) {
    const t = useTranslations('admin');
    if (allowed) return <>{children}</>;
    return (
        // Its OWN provider, nested under the app's. Radix permits nesting, and
        // the alternative is a footgun: this branch renders only for a reader,
        // so a test that exercises the reader view would crash on a provider it
        // had no reason to know it needed — and the crash would look like the
        // component being broken rather than the harness being incomplete.
        <TooltipProvider>
        <Tooltip content={reason}>
            {/* The span is load-bearing: a DISABLED button fires no pointer
                events, so a tooltip bound directly to it never opens and the
                explanation is unreachable by exactly the people who need it. */}
            {/* A LABEL on the wrapper, not only a hover tooltip. A disabled
                button is reachable by a screen reader and announces nothing
                about WHY it is disabled; the tooltip is pointer-only. This is
                the same explanation, available to the reader who cannot hover. */}
            <span
                className="inline-flex"
                data-testid="permission-gated"
                role="group"
                aria-label={t('permissionGated.ariaLabel', { reason })}
            >
                {children}
            </span>
        </Tooltip>
        </TooltipProvider>
    );
}
