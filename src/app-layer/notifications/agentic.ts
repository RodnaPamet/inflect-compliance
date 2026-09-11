/**
 * AGENTIC UI 1/4 (#2441) — in-app notifications for the two agentic events a
 * human has to know about without going and looking.
 *
 * ── WHY THESE TWO, OUT OF EVERYTHING THE SUBSYSTEM DOES ─────────────────────
 *
 * None of the twenty existing `NotificationType` members is agentic, so the
 * whole subsystem was silent: every fact it produced lived on a page somebody
 * had to already be on. Two of those facts are about a PERSON rather than a
 * page:
 *
 *   • `AGENT_KILL_SWITCH_ENGAGED` — an agent, or every agent in the workspace,
 *     has been stopped at the tool boundary, including runs already in flight.
 *     Engaging it does NOT change `RegisteredAgent.status`, so nothing in the
 *     register says so, and the only surface that did was the header of that
 *     agent's own detail page. The accountable owner is the person whose
 *     integration just stopped working.
 *
 *   • `AGENT_PROPOSAL_QUARANTINED` — the agentic output guard REFUSED a write
 *     the agent attempted. Quarantine is terminal: the row never reaches the
 *     review queue and no override exists, so nobody is going to encounter it
 *     in the course of ordinary work. Left un-notified, an agent producing
 *     injected content goes on producing it, and the evidence accumulates on a
 *     triage page with no inbound traffic.
 *
 * Deliberately NOT notified: proposal CREATED. That is the ordinary case — the
 * propose-not-commit queue exists to accumulate them — and one bell per
 * proposal would train the recipient to ignore the bell, taking the two above
 * with it. The waiting count is surfaced instead, where it costs nothing to
 * ignore: a badge on the register's ViewsMenu and a line on the dashboard card.
 *
 * ── THE EXISTING CATALOGUE, NOT A SECOND CHANNEL ────────────────────────────
 *
 * Both go through `db.notification.createMany({ skipDuplicates: true })` plus
 * `publishNotificationEvent`, which is the bell + SSE path every other in-app
 * notification uses, with the same `{tenantId}:{TYPE}:{entityId}:{userId}:{day}`
 * dedupe key shape. `createMany` rather than `create`: a duplicate key returns
 * `count: 0` with NO exception, where a raw `create` throws P2002 and poisons
 * an interactive Postgres transaction.
 *
 * Fire-and-forget, like `createAssignmentNotification` — callers isolate the
 * write so a notification failure never rolls back the parent operation. An
 * agent that could not be stopped because the bell was down is the wrong
 * failure mode for a kill switch.
 *
 * ── RECIPIENTS ──────────────────────────────────────────────────────────────
 *
 * The agent's ACCOUNTABLE OWNER first. `RegisteredAgent.ownerUserId` is NOT
 * NULL behind a real FK and the register's whole purpose is to name the human
 * who answers for an agent, so that is who is told. When there is no single
 * agent — a TENANT-scope kill, or a quarantined proposal from an unattributed
 * credential — it falls back to the workspace's ACTIVE OWNERs, because the
 * question "who answers for this" then has no narrower answer.
 *
 * THE ACTOR IS NEVER NOTIFIED OF THEIR OWN ACTION. An operator who just
 * engaged a kill switch does not need a bell telling them they did; a bell that
 * fires on your own click is the first one people learn to dismiss.
 */

import type { PrismaClient } from '@prisma/client';

import { publishNotificationEvent } from '@/lib/notifications/notification-bus';

/** The two agentic members of `NotificationType`. */
export type AgenticNotificationKind =
    | 'AGENT_KILL_SWITCH_ENGAGED'
    | 'AGENT_PROPOSAL_QUARANTINED';

interface AgenticCopy {
    title: string;
    body: (subject: string) => string;
    linkPath: (tenantSlug: string) => string;
}

/**
 * Copy, in the same shape and register as `assignment.ts`'s `COPY`. English
 * literals, matching every other notification emitter in the repo — the bell's
 * rows are written at emit time and stored, so they are not reachable by
 * `next-intl` at render.
 *
 * The link is to the SURFACE, not to the row. For a kill switch the register is
 * where you lift it; for a quarantined proposal the triage page is where the
 * attempted content is, and the row itself has no detail page.
 */
const COPY: Record<AgenticNotificationKind, AgenticCopy> = {
    AGENT_KILL_SWITCH_ENGAGED: {
        title: 'An agent kill switch was engaged',
        body: (subject) =>
            `${subject} is stopped at the tool boundary, including runs already in flight. ` +
            `Its registered status is unchanged — lift the kill switch to let it act again.`,
        linkPath: (slug) => `/t/${slug}/agents`,
    },
    AGENT_PROPOSAL_QUARANTINED: {
        title: 'An agent proposal was quarantined',
        body: (subject) =>
            `The output guard refused a write from ${subject}. Quarantine is terminal — ` +
            `the proposal cannot be approved. Read the attempted content before deciding ` +
            `whether the agent should keep running.`,
        linkPath: (slug) => `/t/${slug}/agents/quarantine`,
    },
};

/**
 * Build the idempotency key. Pure helper so tests can assert the format
 * directly, and identical in shape to `buildAssignmentDedupeKey`.
 *
 * Day granularity in UTC. For quarantine that is the point: an agent under an
 * injection attempt produces a burst of refused proposals, and one bell per
 * refusal would bury the first. For a kill switch the `entityId` is the switch
 * row, which is unique per engagement anyway.
 */
export function buildAgenticDedupeKey(
    tenantId: string,
    kind: AgenticNotificationKind,
    entityId: string,
    userId: string,
    now: Date = new Date(),
): string {
    const ymd = now.toISOString().slice(0, 10);
    return `${tenantId}:${kind}:${entityId}:${userId}:${ymd}`;
}

export interface AgenticNotificationTarget {
    tenantId: string;
    /**
     * For the deep link. `RequestContext.tenantSlug` is OPTIONAL, so callers
     * pass `ctx.tenantSlug ?? null` and a missing slug yields a notification
     * with NO link rather than one pointing at `/t/undefined/agents`. A bell
     * row that navigates nowhere is worse than a bell row that does not offer
     * to.
     */
    tenantSlug: string | null;
    /** The row the notification is about (kill-switch row, or proposal row). */
    entityId: string;
    /**
     * What was stopped / what produced the refused write, in words. An agent
     * name where there is one agent; "Every agent in this workspace" for a
     * tenant-scope kill; "an unattributed credential" for a proposal whose
     * credential names no registered agent.
     */
    subject: string;
    /** Who to tell. Empty is a legitimate outcome — see `resolveRecipients`. */
    recipientUserIds: readonly string[];
    /** The person who caused it, excluded from `recipientUserIds` by the caller. */
    actorUserId: string;
}

export interface AgenticNotificationOutcome {
    /** How many bell rows were actually written (duplicates return 0). */
    created: number;
}

export async function createAgenticNotification(
    db: Pick<PrismaClient, 'notification'>,
    kind: AgenticNotificationKind,
    target: AgenticNotificationTarget,
    now: Date = new Date(),
): Promise<AgenticNotificationOutcome> {
    // An empty recipient list is NOT an error and must not throw. A workspace
    // whose only OWNER is the operator who engaged the switch has nobody left
    // to tell once the actor is excluded, and that is the correct outcome —
    // the person who needs to know already knows.
    const recipients = target.recipientUserIds.filter((id) => id !== target.actorUserId);
    if (recipients.length === 0) return { created: 0 };

    const copy = COPY[kind];
    const message = copy.body(target.subject);
    const linkUrl = target.tenantSlug === null ? null : copy.linkPath(target.tenantSlug);

    const res = await db.notification.createMany({
        data: recipients.map((userId) => ({
            tenantId: target.tenantId,
            userId,
            type: kind,
            title: copy.title,
            message,
            linkUrl,
            dedupeKey: buildAgenticDedupeKey(
                target.tenantId,
                kind,
                target.entityId,
                userId,
                now,
            ),
        })),
        skipDuplicates: true,
    });

    // Published only on a real write. Pushing an SSE event for a row the
    // dedupe key rejected would make the bell show a notification that is not
    // in the list it opens.
    if (res.count > 0) {
        for (const userId of recipients) {
            publishNotificationEvent(target.tenantId, userId, {
                id: `${kind}:${target.entityId}:${userId}`,
                type: kind,
                title: copy.title,
                message,
                read: false,
                linkUrl,
                createdAt: now.toISOString(),
            });
        }
    }

    return { created: res.count };
}

/**
 * Who to tell, given an agent — or given that there is no single agent.
 *
 * One query either way, and the fallback is ACTIVE OWNERs only rather than
 * OWNER + ADMIN: the notification says something has stopped acting or has
 * been refused, and OWNER is the role that cannot be delegated away. Bounded
 * `take`, because a broadcast to an unbounded membership list is how a bell
 * becomes a mail bomb.
 */
export async function resolveAgenticRecipients(
    db: Pick<PrismaClient, 'registeredAgent' | 'tenantMembership'>,
    tenantId: string,
    agentId: string | null,
): Promise<{ recipientUserIds: string[]; agentName: string | null }> {
    if (agentId !== null) {
        const agent = await db.registeredAgent.findFirst({
            where: { id: agentId, tenantId, deletedAt: null },
            select: { name: true, ownerUserId: true },
        });
        if (agent) {
            return { recipientUserIds: [agent.ownerUserId], agentName: agent.name };
        }
        // An agentId that resolves to no live row falls through to the owners
        // rather than notifying nobody: something named an agent this
        // workspace cannot produce, which is itself worth a look.
    }
    const owners = await db.tenantMembership.findMany({
        where: { tenantId, role: 'OWNER', status: 'ACTIVE' },
        select: { userId: true },
        take: 50,
    });
    return { recipientUserIds: owners.map((o) => o.userId), agentName: null };
}
