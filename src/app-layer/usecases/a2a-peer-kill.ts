/**
 * THE PER-PEER KILL (#3679; `docs/a2a-threat-model.md` "Stopping a peer", R11).
 *
 * The ONLY writer of `PeerAgentKillSwitch`
 * (`tests/guards/agent-harness-single-write-seam.test.ts`).
 *
 * While a kill is in force on a peer, the NEXT message in either direction is
 * refused: the inbound endpoint reads it on every request before it reads the
 * body, and the outbound path reads it when a run asks to send AND again when
 * the dispatch pass is about to send, because a row opened before the kill must
 * not leave after it. Nothing caches the answer — the reason
 * `src/lib/agentic/kill-switch.ts` gives for the agent kill holds here too: a
 * cached kill state is the control failing in the first seconds of an incident.
 *
 * ## Whose authority
 *
 * `admin.agent_kill_switch`, the key that stops an agent (roadmap permission
 * table; decision 4: no second authority model). A machine credential may
 * ENGAGE a kill — stopping is always safe — but only a PERSON lifts one, and
 * only with a reason: the CHECK on the table requires the reason, and this
 * usecase refuses an `apiKeyId` on the context.
 *
 * ## What it does not do
 *
 * It does not change the peer's status, the pin or the credential. Lifting a
 * kill restores exactly what was there, which is what makes it safe to pull
 * first and investigate second. A kill also cannot recall a message already
 * on the wire.
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { logEvent } from '../events/audit';
import { assertAgentGovernanceWrite } from '../policies/agent-governance.policies';
import { buildSystemContext } from '../context-system';

/**
 * The peer id the scheduled drill kills. Matches nothing `cuid()` mints, so it
 * names no peer in any tenant, and the engage usecase refuses it by hand.
 */
export const PEER_KILL_DRILL_PEER_ID = '__kill-switch-drill-canary-peer__';

export interface PeerKillVerdict {
    readonly switchId: string;
    readonly engagedAt: Date;
}

const KILL_SELECT = {
    id: true,
    peerId: true,
    reason: true,
    engagedByUserId: true,
    engagedAt: true,
    liftedAt: true,
    liftedByUserId: true,
    liftReason: true,
} as const;

function requireReason(raw: unknown, field: string): string {
    if (typeof raw !== 'string') throw badRequest(`\`${field}\` is required.`);
    const clean = sanitizePlainText(raw).trim();
    if (clean.length === 0) {
        throw badRequest(`\`${field}\` is required. A kill with no stated reason cannot be reviewed afterwards.`);
    }
    if (clean.length > 2000) throw badRequest(`\`${field}\` must be 2000 characters or fewer.`);
    return clean;
}

/** THE predicate: a kill on this peer that nobody has lifted. One spelling, read by the boundary and the drill. */
function inForce(tenantId: string, peerId: string) {
    return { tenantId, peerId, liftedAt: null } as const;
}

/**
 * Is a kill in force on this peer RIGHT NOW? Read through the tenant's own
 * row-level security, uncached, on every message.
 */
export async function resolvePeerKill(ctx: RequestContext, peerId: string): Promise<PeerKillVerdict | null> {
    const row = await runInTenantContext(ctx, (db) =>
        db.peerAgentKillSwitch.findFirst({
            where: inForce(ctx.tenantId, peerId),
            select: { id: true, engagedAt: true },
        }),
    );
    return row ? { switchId: row.id, engagedAt: row.engagedAt } : null;
}

export async function engagePeerKill(ctx: RequestContext, peerId: string, input: { reason?: unknown }) {
    assertAgentGovernanceWrite(ctx, 'agent_kill_switch');
    const reason = requireReason(input.reason, 'reason');
    if (peerId === PEER_KILL_DRILL_PEER_ID) {
        throw badRequest('That peer id is reserved for the scheduled kill-switch drill.');
    }
    return runInTenantContext(ctx, async (db) => {
        const peer = await db.peerAgent.findFirst({ where: { id: peerId, tenantId: ctx.tenantId }, select: { id: true } });
        if (!peer) throw notFound('Peer agent not found');

        // Idempotent: an operator pressing stop twice during an incident is told
        // it is stopped. The partial unique index is the authority.
        const existing = await db.peerAgentKillSwitch.findFirst({
            where: inForce(ctx.tenantId, peerId),
            select: KILL_SELECT,
        });
        if (existing) return { ...existing, alreadyInForce: true as const };

        const row = await db.peerAgentKillSwitch.create({
            data: { tenantId: ctx.tenantId, peerId, reason, engagedByUserId: ctx.userId },
            select: KILL_SELECT,
        });
        await logEvent(db, ctx, {
            action: 'PEER_AGENT_KILL_ENGAGED',
            entityType: 'PeerAgent',
            entityId: peerId,
            details: `Kill engaged on A2A peer agent ${peerId}`,
            detailsJson: {
                category: 'access',
                entityName: 'PeerAgentKillSwitch',
                operation: 'create',
                // The reason is tenant free text and stays on the switch row.
                after: { switchId: row.id, peerId, engagedByUserId: ctx.userId },
            },
        });
        return { ...row, alreadyInForce: false as const };
    });
}

export async function liftPeerKill(ctx: RequestContext, peerId: string, input: { liftReason?: unknown }) {
    assertAgentGovernanceWrite(ctx, 'agent_kill_switch');
    // Lifted only by a person (threat model, "Stopping a peer").
    if (ctx.apiKeyId) throw forbidden('A peer kill is lifted by a person, not by an API key');
    const liftReason = requireReason(input.liftReason, 'liftReason');
    return runInTenantContext(ctx, async (db) => {
        const existing = await db.peerAgentKillSwitch.findFirst({
            where: { tenantId: ctx.tenantId, peerId, liftedAt: null },
            select: { id: true },
        });
        if (!existing) throw notFound('No kill is in force on this peer');
        const claimed = await db.peerAgentKillSwitch.updateMany({
            where: { id: existing.id, tenantId: ctx.tenantId, liftedAt: null },
            data: { liftedAt: new Date(), liftedByUserId: ctx.userId, liftReason },
        });
        if (claimed.count !== 1) throw conflict('The kill was lifted by somebody else first');
        await logEvent(db, ctx, {
            action: 'PEER_AGENT_KILL_LIFTED',
            entityType: 'PeerAgent',
            entityId: peerId,
            details: `Kill lifted on A2A peer agent ${peerId}`,
            detailsJson: {
                category: 'access',
                entityName: 'PeerAgentKillSwitch',
                operation: 'update',
                after: { switchId: existing.id, peerId, liftedByUserId: ctx.userId },
            },
        });
        return db.peerAgentKillSwitch.findFirst({ where: { id: existing.id, tenantId: ctx.tenantId }, select: KILL_SELECT });
    });
}

export async function listPeerKills(ctx: RequestContext, peerId: string) {
    assertAgentGovernanceWrite(ctx, 'agent_kill_switch');
    return runInTenantContext(ctx, (db) =>
        db.peerAgentKillSwitch.findMany({
            where: { tenantId: ctx.tenantId, peerId },
            orderBy: { engagedAt: 'desc' },
            take: 100,
            select: KILL_SELECT,
        }),
    );
}

const ROLLBACK = Symbol('peer-kill-drill-rollback');

/**
 * The scheduled drill's PEER arm: engage a kill on the canary peer inside a
 * transaction that is always rolled back, and ask the boundary's own predicate
 * whether it sees it. Proves the row is writable, the predicate matches and the
 * index serves it, in production, without stopping a real peer — the shape
 * `probeUncommittableScopes` in `jobs/agent-kill-switch-drill.ts` uses for the
 * tenant and platform scopes. Lives here so this file stays the table's only
 * writer.
 */
export async function probePeerKillPredicate(tenantId: string, actorUserId: string): Promise<boolean> {
    const ctx = buildSystemContext({ tenantId, job: 'agent-kill-switch-drill', discriminator: 'peer' });
    let honoured = false;
    try {
        await runInTenantContext(ctx, async (db) => {
            await db.peerAgentKillSwitch.create({
                data: {
                    tenantId,
                    peerId: PEER_KILL_DRILL_PEER_ID,
                    reason: 'Scheduled kill-switch drill (rolled back)',
                    engagedByUserId: actorUserId,
                },
            });
            const seen = await db.peerAgentKillSwitch.findFirst({
                where: inForce(tenantId, PEER_KILL_DRILL_PEER_ID),
                select: { id: true },
            });
            honoured = seen !== null;
            throw ROLLBACK;
        });
    } catch (err) {
        if (err !== ROLLBACK) throw err;
    }
    return honoured;
}
