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
 * The gates are NOT the same key, and that is not an oversight. The proposals
 * and runs pages gate themselves on `admin.view` OR the inventory view key
 * (`mayReadAgentActivity`, #3710), and compose on `admin.view` alone; receipts,
 * quarantine, decisions, review quality and external tools gate themselves on
 * `admin.agent_registry`; the governance pack (`/agents/reports`) on the
 * INVENTORY read, the view key or the register key (`mayReadAgentInventory`).
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
    Globe,
    PenWriting,
    ShieldSlash,
    SquareCheck,
    UserMinus,
    Workflow,
} from '@inflect/ui/components/ui/icons/nucleo';
import { ViewsMenu } from '@/components/ui/views-menu';

/** Which of the agentic surfaces the reader is on. */
export type AgentsViewRoute =
    | 'register'
    | 'proposals'
    | 'runs'
    | 'receipts'
    | 'quarantine'
    | 'review-quality'
    | 'reports'
    | 'decisions'
    | 'external-tools'
    | 'peers'
    | 'compose'
    | 'owner-orphan-pass'
    | 'audit-pilot';

export interface AgentsViewsMenuProps {
    current: AgentsViewRoute;
    tenantSlug: string;
    /** `mayReadAgentActivity` — the proposals and runs pages' own gate. */
    canReviewProposals: boolean;
    /**
     * `admin.view` — the compose page's gate. Defaults to `canReviewProposals`,
     * which it equalled until the view key split the two (#3710); a page that
     * can tell them apart passes it.
     */
    canCompose?: boolean;
    /** `admin.agent_registry` — the receipts / quarantine / review-quality gate. */
    canInvestigate: boolean;
    /**
     * `mayReadAgentInventory` — the governance pack's gate (#3710). Defaults to
     * `canInvestigate`, the gate the pack had before the view key existed; a
     * page that holds a view-key reader passes it.
     */
    canReadReports?: boolean;
    /**
     * Proposals awaiting review. `null` means the count could not be read,
     * which renders no badge — the honest rendering of "this page cannot tell
     * you", as distinct from a confident zero.
     */
    proposalsAwaitingReview?: number | null;
    /**
     * `admin.tenant_lifecycle` — the owner-orphan pass page's gate (#3807). An
     * OWNER's key: the mode decides whether a scheduled job stops agents
     * unattended. Defaults to false, so a page that does not pass it shows no
     * entry rather than one that would be refused.
     */
    canSetOrphanPass?: boolean;
}

export function AgentsViewsMenu({
    current,
    tenantSlug,
    canReviewProposals,
    canCompose = canReviewProposals,
    canInvestigate,
    canReadReports = canInvestigate,
    proposalsAwaitingReview = null,
    canSetOrphanPass = false,
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
                        canCompose && {
                            // #3301 — the only item here that ACCEPTS an intent; the other
                            // two review what one produced, which is why it sits first.
                            // Gated on `canCompose` (= `admin.view`), which is exactly
                            // what its destination asks — the view key opens proposals
                            // and runs but not compose (#3710). Submitting additionally
                            // needs write, and the page says so rather than hiding the
                            // form.
                            id: 'agents-view-compose',
                            label: t('views.compose'),
                            icon: <PenWriting className="size-4" />,
                            href: href('/agents/compose'),
                            selected: current === 'compose',

                        },
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
                        canSetOrphanPass && {
                            // The owner-orphan pass (#3670): whether a nightly
                            // job stops the agents of owners who have left. OPERATE
                            // because it acts on agents; OWNER-only, as its page.
                            id: 'agents-view-owner-orphan-pass',
                            label: t('views.ownerOrphanPass'),
                            icon: <UserMinus className="size-4" />,
                            href: href('/agents/owner-orphan-pass'),
                            selected: current === 'owner-orphan-pass',
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
                            // The EU AI Act record: one row per model call,
                            // with whether a person looked. Assurance rather
                            // than Operate — nobody acts on a run from here,
                            // they audit what already happened.
                            id: 'agents-view-decisions',
                            label: t('views.decisions'),
                            icon: <Gauge6 className="size-4" />,
                            href: href('/agents/decisions'),
                            selected: current === 'decisions',
                        },
                        canReadReports && {
                            id: 'agents-view-reports',
                            label: t('views.reports'),
                            icon: <Gauge6 className="size-4" />,
                            href: href('/agents/reports'),
                            selected: current === 'reports',
                        },
                        canInvestigate && {
                            // The pilot auditor's set-up (#3676, #3807): the
                            // second line registers its auditor and schedules
                            // library v1. ASSURANCE because the auditor is the
                            // check on everything in OPERATE. The page asks
                            // `admin.agent_registry`, as this entry does; who may
                            // own an auditor is the usecase's to refuse.
                            id: 'agents-view-audit-pilot',
                            label: t('views.auditPilot'),
                            icon: <BadgeCheck className="size-4" />,
                            href: href('/agents/audit-pilot'),
                            selected: current === 'audit-pilot',
                        },
                        canInvestigate && {
                            id: 'agents-view-review-quality',
                            label: t('views.reviewQuality'),
                            icon: <Gauge6 className="size-4" />,
                            href: href('/agents/review-quality'),
                            selected: current === 'review-quality',
                        },
                        canInvestigate && {
                            // Baselining an external tool's definition: reading
                            // the instruction text a third party will hand the
                            // model, and accepting it. ASSURANCE rather than
                            // OPERATE — this group is "whether the approvals
                            // mean anything", and an approval is exactly what
                            // this surface records. Like every entry here but
                            // the pack, it asks `admin.agent_registry`, which is
                            // what its destination asks.
                            id: 'agents-view-external-tools',
                            label: t('views.externalTools'),
                            icon: <Workflow className="size-4" />,
                            href: href('/agents/external-tools'),
                            selected: current === 'external-tools',
                        },
                        canInvestigate && {
                            // A2A peers (#3679): which other organisation's
                            // agents this tenant exchanges tasks with, their
                            // pins, kills, credentials and signed receipts, and
                            // the tenant's own signing key. ASSURANCE for the
                            // same reason as external tools: what it shows is
                            // whether the approvals that admit a peer still
                            // hold. `admin.agent_registry`, as its page asks.
                            id: 'agents-view-peers',
                            label: t('views.peers'),
                            icon: <Globe className="size-4" />,
                            href: href('/agents/peers'),
                            selected: current === 'peers',
                        },
                    ],
                },
            ]}
        />
    );
}
