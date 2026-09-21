import { Suspense } from 'react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { AgentStatus } from '@prisma/client';

import { getTenantCtx } from '@/app-layer/context';
import { getAgenticDashboardSummary } from '@/app-layer/usecases/agent-registry';
import { Robot } from '@/components/ui/icons/nucleo';
import { Card } from '@/components/ui/card';
import { Heading } from '@/components/ui/typography';
import { InlineNotice } from '@/components/ui/inline-notice';

/**
 * The order the census recites the standings in — the agent's own lifecycle.
 *
 * Written as a RANK MAP rather than an array because `Record<AgentStatus, …>`
 * is exhaustive: a member added to `AgentStatus` and not given a rank here is
 * a type error, where a bare `AgentStatus[]` would have compiled happily and
 * quietly left the new standing out of an operator-facing sentence while the
 * total kept counting it.
 */
const STANDING_RANK: Record<AgentStatus, number> = {
    [AgentStatus.DRAFT]: 0,
    [AgentStatus.ACTIVE]: 1,
    [AgentStatus.SUSPENDED]: 2,
    [AgentStatus.RETIRED]: 3,
};

const STANDING_ORDER = (Object.keys(STANDING_RANK) as AgentStatus[]).sort(
    (a, b) => STANDING_RANK[a] - STANDING_RANK[b],
);

/**
 * AGENTIC GOVERNANCE — the dashboard's answer to "is anything stopped?" (#2440).
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
 *
 * A KILL SWITCH IN FORCE MUST BE VISIBLE FROM THE DASHBOARD. Before this card,
 * it was visible on exactly one surface: the header of the detail page of the
 * agent it stopped. So finding out required already knowing which agent to
 * open — and a TENANT-WIDE kill, the widest state the subsystem has, could be
 * seen only by opening some arbitrary agent and reading a banner about all of
 * them. An operator who has just stopped every agent in the workspace, or
 * arrived after somebody else did, had nowhere to look.
 *
 * It is not a lifecycle state, which is exactly why it needs saying out loud:
 * engaging the kill switch does NOT change `RegisteredAgent.status`, so the
 * register still reads ACTIVE for every stopped agent. ACTIVE with a kill in
 * force is a coherent state, and nothing about the register's own rows says so.
 *
 * ── RENDERS NOTHING FOR A CALLER WITHOUT THE REGISTER KEY ───────────────────
 *
 * The dashboard is the one page everybody sees. `admin.agent_registry` decides
 * who may read the register, and these five numbers are aggregates over it —
 * "3 agents stopped, 2 unscored" is the shape of an answer somebody was
 * refused. So the gate is checked HERE, before the usecase (which asserts the
 * same key and would throw), and the card is absent rather than empty: a
 * heading with no content invites a reader to wonder what is behind it.
 *
 * Best-effort beyond that. It is one card on a dashboard of eleven, so a
 * failure renders nothing rather than taking the page down with it — the same
 * posture `page.tsx` takes for the trend snapshot.
 *
 * ── NOTHING AT ALL FOR A TENANT WITH AN EMPTY REGISTER (#2560) ──────────────
 *
 * The widget was asked for "WHEN ANY AGENT IS REGISTERED", and until #2560
 * there was no number here that could implement the condition. Without it a
 * workspace that has never registered an agent was told, in the reassuring
 * voice of the all-clear line, that "every active agent is scored" — a true
 * sentence about the empty set and a misleading one to read on a dashboard,
 * because it describes a governed fleet rather than no fleet at all.
 *
 * `totalRegistered === 0` is the gate, and it sits AFTER the summary read
 * rather than before it: the count is what the read returns.
 *
 * ── THE CENSUS IS A LINE, NOT A NOTICE ──────────────────────────────────────
 *
 * "Count by standing" answers a different question from everything below it.
 * The notices answer "is anything wrong"; the census answers "what is here" —
 * so it renders whatever the numbers are, ABOVE the notices, and it is not
 * behind a `> 0` guard the way each notice is. A card that could only raise
 * alarms read identically over a workspace with twelve SUSPENDED agents and
 * one with a single ACTIVE one, because engaging a kill switch does not move
 * `status` (above) and `activeUnscored` is a risk-tier fact, not a census.
 *
 * Inside the sentence, a standing with NO agents is suppressed: a workspace
 * that has never suspended anything does not need to be told "Suspended: 0".
 * The total always renders, and it is the total the gate above tested.
 *
 * The per-standing words are the REGISTER'S OWN labels
 * (`register.filterEnums.status.*`), not a second set written for this card.
 * One vocabulary for one enum, so the dashboard and the register it links to
 * cannot come to disagree about what to call a DRAFT.
 *
 * ── THE STATES ARE ORDERED BY WHAT AN OPERATOR SHOULD DO FIRST ──────────────
 *
 * Tenant-wide kill, then per-agent kills, then unscored-but-active, then the
 * enforcement caveat, then the waiting queue, then runs in flight. The
 * all-clear line renders when none of the above do, and it renders rather than
 * leaving the card blank: an empty panel cannot be told apart from a panel that
 * failed to load, and "nothing is stopped" is the single most reassuring
 * sentence here.
 *
 * Runs in flight is last and does NOT suppress the all-clear line, because it
 * is the only entry here that is not a fault: a workspace with three runs
 * executing and nothing stopped is a workspace where everything is working.
 * `clear` therefore stays a statement about the register and the kill switch,
 * and the run count sits beside it rather than contradicting it.
 */
export async function AgenticGovernanceCardBody({
    tenantSlug,
}: {
    tenantSlug: string;
}) {
    const ctx = await getTenantCtx({ tenantSlug });
    if (!ctx.appPermissions?.admin?.agent_registry) return null;

    const t = await getTranslations('agents');
    let summary: Awaited<ReturnType<typeof getAgenticDashboardSummary>>;
    try {
        summary = await getAgenticDashboardSummary(ctx);
    } catch {
        return null;
    }

    // The owner's "when any agent is registered", and the only early return
    // that is about the DATA rather than about the reader.
    if (summary.totalRegistered === 0) return null;

    const stopped = summary.tenantKillInForce || summary.agentsKilled > 0;
    const clear = !stopped && summary.activeUnscored === 0 && summary.enforcing;
    const breakdown = STANDING_ORDER.filter((standing) => summary.byStanding[standing] > 0)
        .map(
            (standing) =>
                `${t(`register.filterEnums.status.${standing}`)}: ${summary.byStanding[standing]}`,
        )
        .join(', ');

    return (
        <Card className="space-y-default" data-testid="agentic-governance-card">
            <div className="flex items-center justify-between gap-default">
                <Heading level={2} as="h3">
                    <span className="inline-flex items-center gap-compact">
                        <Robot className="h-4 w-4 text-content-muted" />
                        {t('dashboardWidget.title')}
                    </span>
                </Heading>
                <Link
                    id="dashboard-agent-register-link"
                    href={`/t/${tenantSlug}/agents`}
                    className="text-sm font-medium text-content-info hover:underline"
                >
                    {t('dashboardWidget.viewRegister')}
                </Link>
            </div>

            <div className="space-y-compact">
                <p className="text-sm text-content-muted" data-testid="agentic-standing">
                    {t('dashboardWidget.standing', {
                        total: summary.totalRegistered,
                        breakdown,
                    })}
                </p>
                {summary.tenantKillInForce && (
                    <InlineNotice variant="error" data-testid="agentic-kill-tenant">
                        {t('dashboardWidget.killInForceTenant')}
                    </InlineNotice>
                )}
                {/* Reported BESIDE the tenant-wide line, not instead of it.
                    Widest scope wins at the boundary, so lifting these rows
                    would not restart anything while the tenant arm stands —
                    and an operator shown only the narrower count would try. */}
                {summary.agentsKilled > 0 && (
                    <InlineNotice variant="error" data-testid="agentic-kill-agents">
                        {t('dashboardWidget.killInForceAgents', { count: summary.agentsKilled })}
                    </InlineNotice>
                )}
                {summary.activeUnscored > 0 && (
                    <InlineNotice variant="warning" data-testid="agentic-unscored-active">
                        {t('dashboardWidget.unscoredActive', { count: summary.activeUnscored })}
                    </InlineNotice>
                )}
                {!summary.enforcing && (
                    <InlineNotice variant="warning" data-testid="agentic-not-enforcing">
                        {t('dashboardWidget.notEnforcing')}
                    </InlineNotice>
                )}
                {summary.proposalsAwaitingReview > 0 && (
                    <InlineNotice variant="info" data-testid="agentic-proposals-waiting">
                        {t('dashboardWidget.proposalsWaiting', {
                            count: summary.proposalsAwaitingReview,
                        })}
                    </InlineNotice>
                )}
                {/* LAST, and behind a `> 0` gate, for two different reasons.
                    Last because nothing above it is true of a run in flight —
                    it is not a fault, it is the subsystem working — and the
                    order of this list is what an operator should do first.
                    Gated because zero runs is the permanent state of a
                    workspace whose agents are registered but never driven, and
                    a line reading "0 runs in flight" on every dashboard every
                    day is chrome an operator learns to stop seeing. */}
                {summary.runsInFlight > 0 && (
                    <InlineNotice variant="info" data-testid="agentic-runs-in-flight">
                        {t('dashboardWidget.runsInFlight', { count: summary.runsInFlight })}
                    </InlineNotice>
                )}
                {clear && (
                    <p className="text-sm text-content-muted" data-testid="agentic-clear">
                        {t('dashboardWidget.clear')}
                    </p>
                )}
            </div>
        </Card>
    );
}

/**
 * The Suspense boundary lives HERE, not at the call site.
 *
 * `tests/unit/executive-dashboard-page.test.ts` pins the dashboard `page.tsx`
 * under 120 lines so the shell cannot accumulate the composition it was split
 * apart to avoid — and a twelve-line boundary-plus-rationale in the shell is
 * exactly that accumulation. The reasoning belongs next to the component it
 * describes anyway.
 *
 * `fallback={null}`, not a skeleton: the body renders nothing at all for a
 * reader without `admin.agent_registry`, so a skeleton would be a visible
 * flicker of a card that was never going to appear.
 *
 * Deliberately OUTSIDE the page's `cachedSsrPayload` batch. This card's
 * content is kill-switch state, and a 60-second cache on "is everything
 * stopped right now" is the wrong trade.
 */
export default function AgenticGovernanceCard(props: { tenantSlug: string }) {
    return (
        <Suspense fallback={null}>
            <AgenticGovernanceCardBody {...props} />
        </Suspense>
    );
}
