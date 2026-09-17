/**
 * AGENTIC UI 1/4 (#2441, #2562, #2561) — in-app notifications for the agentic
 * events a human has to know about without going and looking.
 *
 * ── WHY THESE FOUR, OUT OF EVERYTHING THE SUBSYSTEM DOES ────────────────────
 *
 * None of the twenty existing `NotificationType` members is agentic, so the
 * whole subsystem was silent: every fact it produced lived on a page somebody
 * had to already be on. Four of those facts are about a PERSON rather than a
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
 *   • `AGENT_CIRCUIT_BREAKER_TRIPPED` (#2562) — the behavioural detector
 *     latched the breaker OPEN and the agent is stopped until a human closes
 *     it with a reason. The odd one out in two ways: there is NO human actor,
 *     and the only surface that shows breaker state is a tab on one agent's
 *     detail page whose selection is local `useState`, so there is not even a
 *     deep link to it. An un-trip is manual BY DESIGN, which assumes somebody
 *     learns about the trip; before this, nothing told them.
 *
 *   • `AGENT_TOOL_MANIFEST_PIN_CHANGED` (#2561) — somebody accepted a new tool
 *     DEFINITION on the tenant's behalf. The widest of the four: one approval
 *     clears the MCP boundary's refusal for EVERY agent at once, and the
 *     button sits on one agent's Tools tab, so the decision is taken from a
 *     per-agent page and lands tenant-wide. The description inside a tool
 *     definition is instruction text delivered to the model, which makes this
 *     the tool-poisoning surface — the one act where "somebody I trust
 *     approved something I did not see" is the attack. Fired only when the pin
 *     actually MOVED; a re-approval matching the hash on file writes nothing
 *     and says nothing.
 *
 * Deliberately NOT notified: proposal CREATED. That is the ordinary case — the
 * propose-not-commit queue exists to accumulate them — and one bell per
 * proposal would train the recipient to ignore the bell, taking the two above
 * with it. The waiting count is surfaced instead, where it costs nothing to
 * ignore: a badge on the register's ViewsMenu and a line on the dashboard card.
 *
 * ── THE EXISTING CATALOGUE, NOT A SECOND CHANNEL ────────────────────────────
 *
 * All four go through `db.notification.createMany({ skipDuplicates: true })` plus
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
 * agent — a TENANT-scope kill, a quarantined proposal from an unattributed
 * credential, or a tool-manifest pin that binds every agent at once — it falls
 * back to the workspace's ACTIVE OWNERs, because the question "who answers for
 * this" then has no narrower answer.
 *
 * THE ACTOR IS NEVER NOTIFIED OF THEIR OWN ACTION. An operator who just
 * engaged a kill switch does not need a bell telling them they did; a bell that
 * fires on your own click is the first one people learn to dismiss. A breaker
 * trip has no actor at all and passes `null`, which excludes nobody.
 */

import type { PrismaClient } from '@prisma/client';

import { publishNotificationEvent } from '@/lib/notifications/notification-bus';
import { isInAppTypeEnabled } from './settings';

/** The agentic members of `NotificationType`. */
export type AgenticNotificationKind =
    | 'AGENT_KILL_SWITCH_ENGAGED'
    | 'AGENT_PROPOSAL_QUARANTINED'
    | 'AGENT_CIRCUIT_BREAKER_TRIPPED'
    | 'AGENT_TOOL_MANIFEST_PIN_CHANGED';

interface AgenticCopy {
    title: string;
    /**
     * `detail` is the type-specific fact the sentence needs and the subject
     * cannot carry — the firing signals for a breaker trip, and whether a
     * manifest pin is a first approval or a replacement. `null` for the two
     * types whose body is complete without one, which is why the parameter is
     * read by two entries and ignored by the other two.
     */
    body: (subject: string, detail: string | null) => string;
    /**
     * Where the bell row navigates. Takes the ENTITY as well as the slug: a
     * breaker trip is about one agent and the only surface that shows breaker
     * state is that agent's own detail page, so a link to the register would
     * land the recipient on a page that says nothing about what happened. The
     * three entries that link to a surface rather than a row ignore it.
     */
    linkPath: (tenantSlug: string, entityId: string) => string;
}

/**
 * Copy, in the same shape and register as `assignment.ts`'s `COPY`. English
 * literals, matching every other notification emitter in the repo — the bell's
 * rows are written at emit time and stored, so they are not reachable by
 * `next-intl` at render.
 *
 * The link is to wherever the recipient can ACT on what they were told. For a
 * kill switch that is the register, where you lift it; for a quarantined
 * proposal it is the triage page, which is where the attempted content is and
 * the row itself has no detail page. For a breaker trip it is the agent's own
 * detail page, because the breaker tab there is the only surface in the product
 * that renders breaker state or offers the close. For a manifest pin it is the
 * register again — pin state is tenant-wide data with no tenant-level page and
 * no per-row URL, so the register is the nearest thing to where you act.
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
    AGENT_CIRCUIT_BREAKER_TRIPPED: {
        title: "An agent's circuit breaker tripped",
        body: (subject, detail) =>
            `${subject} was stopped automatically by its behavioural circuit breaker` +
            `${detail === null ? '' : ` — firing signals: ${detail}`}. ` +
            `It cannot act at the tool boundary until somebody closes the breaker with a reason.`,
        // The AGENT's page, not the register: breaker state appears on the
        // detail page's breaker tab and nowhere else, and closing it — the
        // only thing that restarts the agent — is done from there.
        linkPath: (slug, agentId) => `/t/${slug}/agents/${agentId}`,
    },
    AGENT_TOOL_MANIFEST_PIN_CHANGED: {
        title: 'A tool definition was approved for this workspace',
        body: (subject, detail) =>
            `${subject} was accepted for every agent in this workspace, clearing the ` +
            `tool boundary's refusal${detail === null ? '' : ` (${detail})`}. ` +
            `A tool's description is instruction text the model reads, so an approval ` +
            `nobody expected is a supply-chain event — check who approved it and why.`,
        // THE SUBJECT AND BODY NAME THE TOOL AND NOTHING ELSE. Never the
        // description: the whole hazard a pin exists for is that the
        // description is instruction text, and a bell row is read by a person
        // and rendered into surfaces a model can reach. `mcp-tool-manifest.ts`
        // refuses to put it in the audit row for exactly this reason, and the
        // bell must refuse the same way.
        //
        // The register, not a row. Pin state is TENANT-WIDE data rendered on a
        // per-agent Tools tab (`ToolManifestPins.tsx`, TOOL_MANIFEST_PATH =
        // '/admin/agents/tool-manifests'), and that tab's selection is local
        // `useState` — so there is no tenant-level manifest surface and no
        // row-level URL to deep-link. Same answer the kill switch gives.
        linkPath: (slug) => `/t/${slug}/agents`,
    },
};

/** One row of the preference surface's catalogue (#2564). */
export interface InAppNotificationTypeInfo {
    type: AgenticNotificationKind;
    /** The bell's own title for this type — see `listInAppNotificationTypes`. */
    title: string;
}

/**
 * The in-app types `/admin/notifications` offers a toggle for.
 *
 * Derived from `COPY`, which is the emitter's own copy, so the catalogue
 * cannot list a type the bell would not send or omit one it would. A future
 * agentic type is added to `COPY` to be emitted at all, and appears on the
 * preference page by that same edit — the client renders whatever this
 * returns and needs no change.
 *
 * The TITLE is the English literal the stored row carries, deliberately, and
 * this is the one place on the page that is not translated. Bell rows are
 * written at emit time and stored, so `next-intl` cannot reach them at render
 * (see the note on `COPY`); a translated label here would promise the operator
 * a Bulgarian bell that the emitter will not deliver. The surrounding section
 * heading and helper text ARE translated — they are rendered, not stored.
 */
export function listInAppNotificationTypes(): InAppNotificationTypeInfo[] {
    return (Object.keys(COPY) as AgenticNotificationKind[]).map((type) => ({
        type,
        title: COPY[type].title,
    }));
}

/**
 * Build the idempotency key. Pure helper so tests can assert the format
 * directly, and identical in shape to `buildAssignmentDedupeKey`.
 *
 * Day granularity in UTC. For quarantine that is the point: an agent under an
 * injection attempt produces a burst of refused proposals, and one bell per
 * refusal would bury the first. For a kill switch the `entityId` is the switch
 * row, which is unique per engagement anyway. For a manifest pin it is the TOOL
 * NAME, so a tool re-approved twice in one day rings once — and the day
 * boundary is why it is the tool name rather than the manifest hash: two
 * different accepted definitions for the same tool on the same day are the
 * burst worth collapsing, not two events worth two bells.
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
    /**
     * What the notification is about — a kill-switch row, a proposal row, an
     * agent id, or (for a manifest pin, which has no row a recipient can be
     * sent to) the TOOL NAME. Whatever it is, it is also the dedupe key's
     * entity segment, so it must be the thing a repeat should collapse on.
     */
    entityId: string;
    /**
     * What was stopped / what produced the refused write / what was accepted,
     * in words. An agent name where there is one agent; "Every agent in this
     * workspace" for a tenant-scope kill; "an unattributed credential" for a
     * proposal whose credential names no registered agent; `The tool "<name>"`
     * for a manifest pin — the NAME only, never the description.
     */
    subject: string;
    /**
     * The type-specific fact the body names beside the subject — the firing
     * signals for a breaker trip, first-approval-vs-replacement for a manifest
     * pin. `null` where the copy needs none.
     */
    detail?: string | null;
    /** Who to tell. Empty is a legitimate outcome — see `resolveRecipients`. */
    recipientUserIds: readonly string[];
    /**
     * The person who caused it, excluded from `recipientUserIds` below.
     *
     * `null` where there is NO human actor. A circuit breaker trips on its own
     * — that is the whole point of it — so there is nobody to exclude, and a
     * sentinel string would have to be one no real user id can equal. `null`
     * cannot collide with a `User.id`, and the filter below already treats it
     * as "exclude nobody".
     */
    actorUserId: string | null;
}

export interface AgenticNotificationOutcome {
    /** How many bell rows were actually written (duplicates return 0). */
    created: number;
}

export async function createAgenticNotification(
    db: Pick<PrismaClient, 'notification' | 'tenantNotificationSettings'>,
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

    // The tenant's in-app preference (#2564). Beside the empty-recipients
    // return above because both are the same kind of answer: a legitimate
    // "nobody is told", reported as `created: 0` rather than thrown.
    //
    // ABOVE the `createMany`, not filtered after it — a muted type must write
    // no row at all. A row written and then hidden still lands in the bell's
    // list page, still counts toward the unread badge, and still fans out over
    // SSE; muting has to mean the write does not happen.
    //
    // This is the ONLY emitter that consults the list today. Moving
    // `assignment.ts` and the other twenty types onto it is a behaviour change
    // for surfaces nobody asked to change, and belongs on its own diff.
    if (!(await isInAppTypeEnabled(db, target.tenantId, kind))) {
        return { created: 0 };
    }

    const copy = COPY[kind];
    const message = copy.body(target.subject, target.detail ?? null);
    const linkUrl =
        target.tenantSlug === null
            ? null
            : copy.linkPath(target.tenantSlug, target.entityId);

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
