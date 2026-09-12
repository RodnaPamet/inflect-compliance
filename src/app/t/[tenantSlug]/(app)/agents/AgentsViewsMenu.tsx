'use client';

/**
 * The agents "Views ▾" menu — five destinations in two labelled groups (#2436).
 *
 * Its own file, not a helper inside `AgentsClient.tsx`, because every one of
 * the five agentic surfaces mounts it — including the two that are SERVER
 * components (receipts, review quality). Importing it from `AgentsClient` would
 * drag the register's table, its modal and its filter defs into their bundles.
 * That is also why the prop is `tenantSlug` rather than a `tenantHref`
 * function: a function cannot cross the server→client boundary.
 *
 * ── WHY TWO GROUPS AND NOT ONE LIST ─────────────────────────────────────────
 *
 * The five surfaces answer two different questions and an operator reaches for
 * them at different times:
 *
 *   OPERATE   — Proposals, Activity. What agents are asking to do, and what
 *               they have done. Visited in the ordinary course of running them.
 *   ASSURANCE — Receipts, Quarantine, Review quality. Whether the record can be
 *               trusted, what was refused, and whether the approvals mean
 *               anything. Visited when answering for the system.
 *
 * ── EVERY GATE IS AN INLINE FALSY ENTRY ─────────────────────────────────────
 *
 * `ViewsMenuGroup.items` drops falsy members, so a permission gate is written
 * as `perm && { … }` and an item the reader may not reach is NOT RENDERED. Not
 * rendered-disabled: a disabled row in a NAVIGATION menu says "this exists and
 * is not yours", which is the right answer for a tab on a page you are already
 * on and the wrong one for a destination whose page would refuse you — the
 * click has nowhere to go. A group left with no items disappears, heading and
 * all; a menu with nothing left renders nothing.
 *
 * The two gates are NOT the same key, and that is not an oversight. The
 * proposals and runs pages gate themselves on `admin.view`; receipts,
 * quarantine and review quality gate themselves on `admin.agent_registry`.
 * A menu entry has to ask the question its destination asks, or it offers a
 * link that renders a ForbiddenPage.
 *
 * `selected` marks the entry for the route the reader is on, so the menu says
 * where you are as well as where you can go. The register itself is NOT an
 * entry — you are looking at it, or one click from it via the breadcrumb — so
 * `current="register"` deliberately selects nothing.
 */
import { useTranslations } from 'next-intl';

import {
    BadgeCheck,
    Gauge6,
    ShieldSlash,
    SquareCheck,
    Workflow,
} from '@/components/ui/icons/nucleo';
import { ViewsMenu } from '@/components/ui/views-menu';

/** Which of the agentic surfaces the reader is on. */
export type AgentsViewRoute =
    | 'register'
    | 'proposals'
    | 'runs'
    | 'receipts'
    | 'quarantine'
    | 'review-quality'
    | 'reports';

export interface AgentsViewsMenuProps {
    current: AgentsViewRoute;
    tenantSlug: string;
    /** `admin.view` — the proposals and runs pages' own gate. */
    canReviewProposals: boolean;
    /** `admin.agent_registry` — the receipts / quarantine / review-quality gate. */
    canInvestigate: boolean;
    /**
     * Proposals awaiting review. `null` means the count could not be read,
     * which renders no badge — the honest rendering of "this page cannot tell
     * you", as distinct from a confident zero.
     */
    proposalsAwaitingReview?: number | null;
}

export function AgentsViewsMenu({
    current,
    tenantSlug,
    canReviewProposals,
    canInvestigate,
    proposalsAwaitingReview = null,
}: AgentsViewsMenuProps) {
    const t = useTranslations('agents');
    const href = (path: string) => `/t/${tenantSlug}${path}`;
    return (
        <ViewsMenu
            id="agents-views-menu"
            groups={[
                {
                    id: 'operate',
                    label: t('views.groupOperate'),
                    items: [
                        canReviewProposals && {
                            id: 'agents-view-proposals',
                            label: t('views.proposals'),
                            icon: <SquareCheck className="size-4" />,
                            href: href('/agents/proposals'),
                            selected: current === 'proposals',
                            // Only when something is actually waiting — see
                            // `ViewsMenuItem.badge`.
                            badge:
                                proposalsAwaitingReview !== null &&
                                proposalsAwaitingReview > 0
                                    ? proposalsAwaitingReview
                                    : undefined,
                            badgeLabel: t('views.proposalsBadgeLabel'),
                        },
                        canReviewProposals && {
                            id: 'agents-view-runs',
                            label: t('views.runs'),
                            icon: <Workflow className="size-4" />,
                            href: href('/agents/runs'),
                            selected: current === 'runs',
                        },
                    ],
                },
                {
                    id: 'assurance',
                    label: t('views.groupAssurance'),
                    items: [
                        canInvestigate && {
                            id: 'agents-view-receipts',
                            label: t('views.receipts'),
                            icon: <BadgeCheck className="size-4" />,
                            href: href('/agents/receipts'),
                            selected: current === 'receipts',
                        },
                        canInvestigate && {
                            id: 'agents-view-quarantine',
                            label: t('views.quarantine'),
                            icon: <ShieldSlash className="size-4" />,
                            href: href('/agents/quarantine'),
                            selected: current === 'quarantine',
                        },
                        canInvestigate && {
                            id: 'agents-view-reports',
                            label: t('views.reports'),
                            icon: <Gauge6 className="size-4" />,
                            href: href('/agents/reports'),
                            selected: current === 'reports',
                        },
                        canInvestigate && {
                            id: 'agents-view-review-quality',
                            label: t('views.reviewQuality'),
                            icon: <Gauge6 className="size-4" />,
                            href: href('/agents/review-quality'),
                            selected: current === 'review-quality',
                        },
                    ],
                },
            ]}
        />
    );
}
