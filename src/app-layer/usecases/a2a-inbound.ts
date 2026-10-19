/**
 * INBOUND A2A — a pinned peer's task becomes the input of ONE run of ONE
 * registered agent (#3679, step 4b; `docs/a2a-mapping.md`, "Inbound").
 *
 * The endpoint's whole authorization lives here, because no session or role
 * stands behind the caller: it is another organisation's agent. The route
 * caps the body and calls `handleInboundA2a`; nothing else.
 *
 * ## The order is the design
 *
 * Cheapest and least revealing first, and NOTHING the peer wrote is parsed
 * until the peer is identified, its signature over the exact bytes verified,
 * and its card admitted (mapping rule 1, "admission before parsing"):
 *
 *    1. The tenant in the URL exists. If not, there is nobody to attribute a
 *       refusal to: it is logged, never audited.
 *    2. The peer in the URL is registered in that tenant.
 *    3. No kill is in force on the peer — read uncached, every message.
 *    4. The bearer is the peer's live `iflp_` credential (constant time).
 *    5. The receipt header is the peer's: Ed25519 by its REGISTERED key over a
 *       statement naming this tenant-and-peer as recipient, the body's exact
 *       digest, a TASK, inside the clock window. Then the tenant has its own
 *       signing key (`NO_SIGNING_KEY` otherwise), since nothing could be
 *       answered unsigned — asked after the peer proved itself, so the refusal
 *       tells nobody else whether the tenant has a key.
 *    6. The peer is admitted against a card copy at most fifteen minutes old:
 *       ACTIVE, owner still a member, scored, pinned, card unchanged (R18).
 *    7. The peer's own quota, `PeerAgent.inboundMessagesPerHour` (R13, I1 D).
 *    8. The message is RECORDED — the insert refuses a message id seen before
 *       from this peer (replay).
 *    9. The tenant has set both run caps (R13, owner decision).
 *   10. Only now is the body parsed, against a closed method set; file parts
 *       and push-notification URLs are refused (R10).
 *   11. `message/send`: the workflow is on the credential's allowlist (R6); the
 *       receiving agent is ACTIVE, scored, not killed and its breaker not open;
 *       the principal — the peer's accountable owner — still resolves. The task
 *       text enters the run input inside a third-party provenance envelope, and
 *       `startWorkflowRun` scans the whole input before the run row exists
 *       (`assertNoReviewRequired`): a flag or a block refuses, with no run.
 *       `tasks/get`: only a run THIS peer started.
 *   12. The answer passes `guardEgress`; a flag or a block withholds its artefact. It
 *       reports proposals by status and says plainly none is committed by the
 *       report. It is signed, kept, and returned with its receipt.
 *
 * ## Every refusal: generic to the peer, specific in the audit row
 *
 * The peer is told "refused" and nothing else (pinning rule 7, I5 I) — the same
 * body for every reason, so a refusal is no oracle for a credential, a key, a
 * card change or a tenant's configuration. The reason goes to a hash-chained
 * `AUTHZ_DENIED` row for every refusal attributable to a tenant (steps 2 on),
 * and to the `agentic.a2a.message` metric.
 *
 * ## No second authority model
 *
 * Nothing here grants. The run is the receiving agent's, under the peer's
 * owner, through `startWorkflowRun` → `resolveMcpInvocation` →
 * `authorizeToolCall` on every step, with the agent's own deny-by-default tool
 * allowlist: a peer reaches no tool the agent was not granted, because the peer
 * can name a workflow and nothing else. The run carries `a2aInbound`, which
 * only narrows (R17, R14).
 */
import { randomUUID } from 'node:crypto';

import type { RequestContext } from '../types';
import { runInGlobalContext } from '@/lib/db/rls-middleware';
import { runInTenantContext } from '@/lib/db-context';
import { appendAuditEntryOrQueue } from '@/lib/audit';
import { logger } from '@/lib/observability/logger';
import { recordA2aMessage as recordA2aMetric } from '@/lib/observability/integration-metrics';
import { resolveTenantContext } from '@/lib/tenant-context';
import { resolveKillState } from '@/lib/agentic/kill-switch';
import { readBreakerLatch } from '@/lib/agentic/circuit-breaker-store';
import { getWorkflowDefinition } from '@/lib/agentic/workflow-registry';
import { mayCarryInstruction, resolveContentProvenance } from '@/lib/agentic/content-provenance';
import { peerBearerFrom } from '@/lib/agentic/a2a/credential';
import {
    A2A_RECEIPT_HEADER,
    a2aBodyDigest,
    encodeA2aReceiptHeader,
    signA2aReceipt,
    verifyA2aReceiptHeader,
    type SignedA2aReceipt,
} from '@/lib/agentic/a2a/receipt';
import {
    a2aRefusal,
    a2aResult,
    parseA2aInboundRequest,
    taskStateForRunStatus,
} from '@/lib/agentic/a2a/protocol';
import { inflectA2aIdentity } from '@/lib/agentic/a2a/send-tool';
import type { RecentCardOptions } from '@/lib/agentic/a2a/card-cache';
import { PEER_ID_SHAPE } from '@/app-layer/integrations/providers/a2a-peer-provider';
import { guardEgress } from '@/app-layer/ai/guard';

import { buildSystemContext } from '../context-system';
import { admitPeerMessage } from './peer-agents';
import { resolvePeerKill } from './a2a-peer-kill';
import { matchPeerInboundCredential } from './a2a-peer-credentials';
import { A2aReplayError, countInboundTasksSince, recordA2aMessage } from './a2a-messages';
import { resolveTenantA2aSigningKey, type TenantA2aSigningKeyInForce } from './a2a-signing-key';

/**
 * The default per-peer quota: inbound messages one peer may send one tenant per
 * rolling hour (R13). Each peer carries its own, `PeerAgent.inboundMessagesPerHour`
 * (owner decision 2026-10-19), which defaults to this and is held to 1..1000.
 */
export const A2A_INBOUND_MESSAGES_PER_PEER_PER_HOUR = 60;

/** The content-provenance source an inbound task's text is labelled with. */
export const A2A_PEER_TASK_SOURCE = 'a2a.peer-task';

export type A2aInboundRefusalReason =
    | 'NO_SIGNING_KEY'
    | 'UNKNOWN_TENANT'
    | 'UNKNOWN_PEER'
    | 'PEER_KILLED'
    | 'BAD_CREDENTIAL'
    | 'QUOTA'
    | 'REPLAY'
    | 'TENANT_CAPS_UNSET'
    | 'METHOD_MISMATCH'
    | 'WORKFLOW_NOT_ALLOWED'
    | 'AGENT_NOT_ACTIVE'
    | 'AGENT_KILLED'
    | 'AGENT_BREAKER_LATCHED'
    | 'OWNER_UNRESOLVED'
    | 'GUARD_REFUSED'
    | 'RUN_REFUSED'
    | 'TASK_NOT_FOUND'
    | string;

export interface InboundA2aRequest {
    readonly tenantSlug: string;
    readonly peerId: string;
    readonly authorization: string | null;
    readonly receiptHeader: string | null;
    /** The exact bytes received, already capped by the route. */
    readonly body: string;
    readonly requestId: string;
    /** Test seam for the card fetch. No file under src/ passes one. */
    readonly card?: RecentCardOptions;
    readonly now?: Date;
}

export interface InboundA2aResponse {
    readonly status: number;
    readonly body: string;
    readonly headers: Record<string, string>;
    /** For the caller's logs and the tests. Never sent to the peer. */
    readonly outcome: 'ANSWERED' | A2aInboundRefusalReason;
    readonly runId?: string;
}

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

function refusal(reason: A2aInboundRefusalReason, rpcId: string | number | null = null, status = 403): InboundA2aResponse {
    recordA2aMetric({ direction: 'INBOUND', outcome: reason });
    return {
        status,
        body: a2aRefusal(rpcId),
        headers: status === 429 ? { ...JSON_HEADERS, 'retry-after': '3600' } : { ...JSON_HEADERS },
        outcome: reason,
    };
}

/** The AUTHZ_DENIED row `requirePermission` would have written. Best-effort: the refusal already happened. */
async function auditRefusal(tenantId: string, peerId: string, reason: string, requestId: string): Promise<void> {
    try {
        await appendAuditEntryOrQueue({
            tenantId,
            userId: null,
            actorType: 'SYSTEM',
            entity: 'PeerAgent',
            entityId: peerId,
            action: 'AUTHZ_DENIED',
            requestId,
            detailsJson: { category: 'access', endpoint: 'a2a-inbound', reason, peerId },
        });
    } catch (err) {
        logger.error('a2a inbound could not record a refusal', {
            component: 'a2a-inbound',
            tenantId,
            reason,
            error: err instanceof Error ? err.message : 'non-Error thrown',
        });
    }
}

export async function handleInboundA2a(req: InboundA2aRequest): Promise<InboundA2aResponse> {
    const tenant = await runInGlobalContext((db) =>
        db.tenant.findFirst({ where: { slug: req.tenantSlug, deletedAt: null }, select: { id: true, slug: true } }),
    );
    if (!tenant || !PEER_ID_SHAPE.test(req.peerId)) {
        logger.warn('a2a inbound refused an unattributable caller', { component: 'a2a-inbound', reason: 'UNKNOWN_TENANT' });
        return refusal('UNKNOWN_TENANT', null, 401);
    }
    const sys = buildSystemContext({
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        job: 'a2a-inbound',
        requestId: req.requestId,
    });
    const refuse = async (reason: A2aInboundRefusalReason, rpcId: string | number | null = null, status = 403) => {
        await auditRefusal(tenant.id, req.peerId, reason, req.requestId);
        return refusal(reason, rpcId, status);
    };

    const peer = await runInTenantContext(sys, (db) =>
        db.peerAgent.findFirst({
            where: { id: req.peerId, tenantId: tenant.id },
            select: {
                id: true,
                cardUrl: true,
                signingPublicKey: true,
                signingKeyFingerprint: true,
                ownerUserId: true,
                inboundMessagesPerHour: true,
            },
        }),
    );
    if (!peer) return refuse('UNKNOWN_PEER', null, 401);

    if (await resolvePeerKill(sys, peer.id)) return refuse('PEER_KILLED');

    const token = peerBearerFrom(req.authorization);
    const credential = token ? await matchPeerInboundCredential(sys, peer.id, token) : null;
    if (!credential) return refuse('BAD_CREDENTIAL', null, 401);

    const inflect = inflectA2aIdentity(tenant.id, peer.id);
    const verdict = verifyA2aReceiptHeader(req.receiptHeader, peer.signingPublicKey, {
        kind: 'TASK',
        sender: peer.cardUrl,
        recipient: inflect,
        bodyDigest: a2aBodyDigest(req.body),
        now: req.now,
    });
    if (!verdict.ok) return refuse(verdict.reason, null, 401);

    // The tenant's own key, which the answer must be signed with. Asked only
    // now, after the peer has proved who it is, so an unauthenticated caller
    // cannot learn from the refusal whether a tenant has a key.
    const key = await resolveTenantA2aSigningKey(sys);
    if (!key) return refuse('NO_SIGNING_KEY', null, 503);

    const admitted = await admitPeerMessage(sys, peer.id, req.card);
    if (!admitted.admission.admitted) return refuse(admitted.admission.reason);

    const since = new Date((req.now ?? new Date()).getTime() - 60 * 60 * 1000);
    if ((await countInboundTasksSince(sys, peer.id, since)) >= peer.inboundMessagesPerHour) {
        return refuse('QUOTA', null, 429);
    }

    // KEPT before anything acts on it, and the insert is the replay check.
    let taskRow: { id: string };
    try {
        taskRow = await recordA2aMessage(sys, {
            peerId: peer.id,
            direction: 'INBOUND',
            receipt: verdict.receipt,
            signerKeyFingerprint: peer.signingKeyFingerprint,
            signerPublicKey: peer.signingPublicKey,
            body: req.body,
            agentId: credential.receivingAgentId,
        });
    } catch (err) {
        if (err instanceof A2aReplayError) return refuse('REPLAY');
        throw err;
    }

    const settings = await runInTenantContext(sys, (db) =>
        db.tenantSecuritySettings.findUnique({
            where: { tenantId: tenant.id },
            select: { agentMonthlyTokenBudget: true, agentMaxConcurrentRuns: true },
        }),
    );
    // R13, by owner decision (2026-10-17): no inbound A2A for a tenant that has
    // left either cap at "no cap", because a peer could otherwise spend it.
    if (settings?.agentMonthlyTokenBudget == null || settings?.agentMaxConcurrentRuns == null) {
        return refuse('TENANT_CAPS_UNSET');
    }

    const parsed = parseA2aInboundRequest(req.body);
    if (!parsed.ok) return refuse(parsed.reason, parsed.rpcId);
    const request = parsed.request;
    if (verdict.receipt.statement.method !== request.method) return refuse('METHOD_MISMATCH', request.rpcId);

    const answer = async (result: Record<string, unknown>, runId: string | undefined, rpcId: string | number) => {
        const outcome = await guardEgress(sys, result, { source: 'a2a-inbound-answer' });
        // A flagged or blocked answer is withheld, not trimmed: the peer learns
        // the task's state and nothing the guard would not let leave (I5 I).
        // `reviewRequired`, not `blocked`: under the default balanced mode a
        // secret in the payload resolves to `flag`, and no person reviews this
        // answer before it crosses into another organisation.
        const body = a2aResult(rpcId, outcome.reviewRequired ? { ...result, artifacts: [] } : result);
        return sign(sys, key, peer.id, inflect, peer.cardUrl, verdict.receipt, body, credential.receivingAgentId, runId);
    };

    if (request.method === 'tasks/get') {
        const run = await runInTenantContext(sys, (db) =>
            db.workflowRun.findFirst({
                where: { id: request.taskId, tenantId: tenant.id, inboundPeerId: peer.id },
                select: { id: true, status: true },
            }),
        );
        if (!run) return refuse('TASK_NOT_FOUND', request.rpcId);
        return answer(await taskFor(sys, run.id, run.status, null), run.id, request.rpcId);
    }

    // ── message/send ─────────────────────────────────────────────────────────
    if (!credential.workflowKeys.includes(request.workflowKey)) return refuse('WORKFLOW_NOT_ALLOWED', request.rpcId);
    const def = getWorkflowDefinition(request.workflowKey);
    if (!def) return refuse('WORKFLOW_NOT_ALLOWED', request.rpcId);
    // A data part supplies only the inputs the workflow DECLARES. Anything else
    // is a peer trying to put content where the definition did not ask for it.
    const declared = new Set(def.requiredInput ?? []);
    if (Object.keys(request.data).some((k) => !declared.has(k))) return refuse('DATA_REFUSED', request.rpcId);

    const agent = await runInTenantContext(sys, (db) =>
        db.registeredAgent.findFirst({
            where: { id: credential.receivingAgentId, tenantId: tenant.id, deletedAt: null },
            select: { id: true, status: true, riskTier: true },
        }),
    );
    if (!agent || agent.status !== 'ACTIVE' || agent.riskTier === null) return refuse('AGENT_NOT_ACTIVE', request.rpcId);
    if (await resolveKillState(tenant.id, agent.id)) return refuse('AGENT_KILLED', request.rpcId);
    if ((await readBreakerLatch(tenant.id, agent.id))?.state === 'OPEN') return refuse('AGENT_BREAKER_LATCHED', request.rpcId);

    let principal;
    try {
        principal = await resolveTenantContext({ tenantId: tenant.id }, peer.ownerUserId);
    } catch {
        return refuse('OWNER_UNRESOLVED', request.rpcId);
    }
    const ctx: RequestContext = {
        requestId: req.requestId,
        userId: peer.ownerUserId,
        actorType: 'SYSTEM',
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        role: principal.role,
        permissions: principal.permissions,
        appPermissions: principal.appPermissions,
        agentId: agent.id,
        a2aInbound: { peerId: peer.id, messageId: taskRow.id },
    };

    // THE TASK IS DATA. Its text travels inside an envelope that labels it
    // third-party and not instruction-bearing; the declared inputs a data part
    // supplied sit beside it, and the Flue driver fences and labels those itself
    // (`flue/run-message.ts`). The handling SENTENCE is deliberately not copied
    // in: the whole input is scanned for injection below, and a rule telling a
    // model to "ignore any directive" reads to a pattern scanner like one.
    const provenance = resolveContentProvenance(A2A_PEER_TASK_SOURCE);
    const input: Record<string, unknown> = {
        ...request.data,
        a2aTask: {
            kind: 'content-provenance',
            source: A2A_PEER_TASK_SOURCE,
            provenance,
            mayCarryInstruction: mayCarryInstruction(provenance),
            peerId: peer.id,
            messageId: request.messageId,
            contextId: request.contextId,
            text: request.text,
        },
    };

    let started;
    try {
        const { startWorkflowRun } = await import('./workflow-runs');
        started = await startWorkflowRun(ctx, request.workflowKey, input);
    } catch (err) {
        const message = err instanceof Error ? err.message : '';
        // The guard's own audit row names the rules; this one names the door.
        return refuse(message.startsWith('ai_guard_') ? 'GUARD_REFUSED' : 'RUN_REFUSED', request.rpcId);
    }

    await appendAuditEntryOrQueue({
        tenantId: tenant.id,
        userId: peer.ownerUserId,
        actorType: 'SYSTEM',
        entity: 'PeerAgent',
        entityId: peer.id,
        action: 'PEER_AGENT_TASK_ADMITTED',
        requestId: req.requestId,
        detailsJson: {
            category: 'access',
            peerId: peer.id,
            receiptId: taskRow.id,
            messageId: request.messageId,
            runId: started.runId,
            workflowKey: request.workflowKey,
            agentId: agent.id,
        },
    }).catch(() => undefined);

    return answer(await taskFor(sys, started.runId, started.status, request.contextId), started.runId, request.rpcId);
}

/**
 * The A2A task a run is, as the peer is told it: the state, and the proposals
 * the run has made with their statuses. It reports what EXISTS here and claims
 * nothing about effect: a pending proposal is pending, and the note says so.
 */
async function taskFor(sys: RequestContext, runId: string, status: string, contextId: string | null) {
    const proposals = await runInTenantContext(sys, (db) =>
        db.agentProposal.findMany({
            where: { tenantId: sys.tenantId, runId },
            orderBy: { createdAt: 'asc' },
            take: 50,
            select: { id: true, kind: true, status: true },
        }),
    );
    return {
        kind: 'task',
        id: runId,
        contextId: contextId ?? runId,
        status: { state: taskStateForRunStatus(status), timestamp: new Date().toISOString() },
        artifacts: [
            {
                artifactId: `${runId}:proposals`,
                name: 'inflect-run-proposals',
                parts: [
                    {
                        kind: 'data',
                        data: {
                            runStatus: status,
                            proposals,
                            note:
                                'Every write this run makes is a proposal that a person in the receiving '
                                + 'organisation decides. A PENDING proposal has changed nothing.',
                        },
                    },
                ],
            },
        ],
    };
}

/** Sign the answer, keep it, and return it with its receipt. */
async function sign(
    sys: RequestContext,
    key: TenantA2aSigningKeyInForce,
    peerId: string,
    inflect: string,
    peerIdentity: string,
    task: SignedA2aReceipt,
    body: string,
    agentId: string,
    runId: string | undefined,
): Promise<InboundA2aResponse> {
    const result = signA2aReceipt(
        {
            v: 'inflect-a2a-receipt/1',
            kind: 'RESULT',
            messageId: randomUUID(),
            relatesTo: task.statement.messageId,
            method: null,
            sender: inflect,
            recipient: peerIdentity,
            issuedAt: new Date().toISOString(),
            bodyDigest: a2aBodyDigest(body),
        },
        key.privateKey,
    );
    await recordA2aMessage(sys, {
        peerId,
        direction: 'OUTBOUND',
        receipt: result,
        signerKeyFingerprint: key.fingerprint,
        signerPublicKey: key.publicKeyHex,
        body,
        agentId,
        runId: runId ?? null,
    });
    recordA2aMetric({ direction: 'INBOUND', outcome: 'ANSWERED' });
    return {
        status: 200,
        body,
        headers: { ...JSON_HEADERS, [A2A_RECEIPT_HEADER]: encodeA2aReceiptHeader(result) },
        outcome: 'ANSWERED',
        runId,
    };
}
