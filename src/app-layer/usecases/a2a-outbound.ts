/**
 * OUTBOUND A2A — an Inflect agent's task to a pinned peer is an EXTERNAL WRITE
 * (#3679, step 4b; `docs/a2a-mapping.md`, "Outbound").
 *
 * Three moments, each its own function, and the order of checks in each is the
 * design:
 *
 *   1. ASSEMBLY — `resolveGrantedA2aSendTools`. The send tool is offered to a
 *      run only when the agent is granted it, its connection is enabled and
 *      above `DISABLED`, the run was NOT started by a peer (R14), no kill is in
 *      force on the peer, and the peer is admitted against a card copy at most
 *      fifteen minutes old (R18). Anything else and the tool is absent.
 *
 *   2. THE CALL — `dispatchA2aSend`, from inside `authorizeToolCall`'s `run`.
 *      Every term is asked AGAIN, because the offered set is a snapshot and a
 *      kill or a changed card must stop the NEXT message, not the next run.
 *      Then the connection's rung, read fresh: `DISABLED` refuses, `DRY_RUN`
 *      journals the intent and sends nothing, `PROPOSE_ONLY` makes an
 *      `EXTERNAL_WRITE` proposal a person approves, and `AUTOMATIC` opens a
 *      journal row through `openAutomaticExternalWrite` — the parameter set,
 *      the per-connection window and the Art 12 record all apply. NOTHING IS
 *      SENT FROM HERE AT ANY RUNG.
 *
 *   3. THE SEND — `sendA2aJournalRow`, from `runExternalWriteDispatch`, the
 *      only sender in the build. It re-asks the agent kill, the peer kill, R14,
 *      admission, and whether the basis the write was authorised on still holds
 *      (the pin it recorded as prior state, R9), and at `AUTOMATIC` the
 *      approved bounds. Only then does it sign the task, keep the receipt, and
 *      send through the one wire. The peer's answer is verified against the
 *      peer's registered key before it is believed or kept.
 *
 * ## FAILED is a claim, INDETERMINATE is the absence of one
 *
 * As in the MCP dispatch: every refusal above the socket is `FAILED`, because
 * nothing was sent. A send that may have arrived and did not come back with a
 * verifiable answer is `INDETERMINATE`, never `FAILED`.
 */
import { randomUUID } from 'node:crypto';

import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { logger } from '@/lib/observability/logger';
import { recordA2aMessage as recordA2aMetric } from '@/lib/observability/integration-metrics';
import { decryptField } from '@/lib/security/encryption';
import { canonicalJson } from '@/lib/canonical-json';
import {
    clampForInboundA2a,
    coerceStoredMode,
    type ExternalWriteMode,
} from '@/lib/integrations/external-write-ladder';
import { resolveKillState } from '@/lib/agentic/kill-switch';
import {
    A2A_SEND_TOOL,
    A2A_SEND_TOOL_DEFINITION,
    A2aSendArgsSchema,
    a2aSendConnectionId,
    a2aSendPriorState,
    a2aSendToolName,
    type A2aSendArgs,
} from '@/lib/agentic/a2a/send-tool';
import { buildA2aSendBody, buildA2aTaskGetBody, parseA2aPeerReply } from '@/lib/agentic/a2a/protocol';
import {
    a2aBodyDigest,
    encodeA2aReceiptHeader,
    signA2aReceipt,
    verifyA2aReceiptHeader,
} from '@/lib/agentic/a2a/receipt';
import { sendA2aMessage } from '@/lib/agentic/a2a/client';
import { inflectA2aOrigin } from '@/lib/agentic/a2a/origin';
import type { RecentCardOptions } from '@/lib/agentic/a2a/card-cache';
import type { WireFetch } from '@/lib/mcp/wire-transport';
import { A2A_PEER_PROVIDER_ID } from '@/app-layer/integrations/providers/a2a-peer-provider';

import { admitPeerMessage } from './peer-agents';
import { resolvePeerKill } from './a2a-peer-kill';
import { A2aReplayError, recordA2aMessage } from './a2a-messages';
import { currentTenantA2aPublicKey, resolveTenantA2aSigningKey } from './a2a-signing-key';
import { ownA2aIdentity } from './a2a-agent-card';
import {
    concludeAcceptedIndeterminate,
    noteAcceptedWrite,
    promoteAcceptedWrite,
    recordIntent,
    settleWrite,
    type SettledOutcome,
} from './external-write-journal';
import { automaticBoundRefusalAtSend, openAutomaticExternalWrite } from './external-write-automatic';
import { createAgentProposal } from './agent-proposals';

/** Test seams for the network. No file under src/ passes either. */
export interface A2aNetworkOptions {
    /** The card fetch, passed to `recentAgentCard`. */
    readonly card?: RecentCardOptions;
    /** The send, passed to `wirePost`. */
    readonly fetchImpl?: WireFetch;
}

export interface GrantedA2aSendTool {
    readonly qualified: string;
    readonly def: typeof A2A_SEND_TOOL_DEFINITION;
    readonly peerId: string;
    readonly connection: { id: string; name: string; url: string; mode: ExternalWriteMode };
    readonly parameterSets: ReadonlyArray<{
        label: string;
        parameters: Record<string, unknown>;
        openFields: unknown;
        targetPopulation: string | null;
    }>;
}

function peerIdOf(configJson: unknown): string | null {
    const v = (configJson ?? {}) as { peerId?: unknown };
    return typeof v.peerId === 'string' && v.peerId.trim() !== '' ? v.peerId.trim() : null;
}

/** The text every refusal returns to a model. Names no hash and no reason (pinning rule 7). */
function refusedForModel(code: string, sentence: string): Error {
    return new Error(`${code}: ${sentence} Nothing was sent.`);
}

/**
 * ASSEMBLY: the send tools this invocation may load. `[]`, with no query, when
 * the agent holds no A2A grant — which is nearly every invocation.
 */
export async function resolveGrantedA2aSendTools(
    ctx: RequestContext,
    grantedTools: ReadonlySet<string> | null,
    net: A2aNetworkOptions = {},
): Promise<GrantedA2aSendTool[]> {
    if (!grantedTools || grantedTools.size === 0) return [];
    const connectionIds = [...grantedTools].map(a2aSendConnectionId).filter((v): v is string => v !== null);
    if (connectionIds.length === 0) return [];
    // R14: a run a peer started never sends to a peer. Not offered at all, and
    // refused again at the call, because the snapshot is not the only gate.
    if (ctx.a2aInbound) return [];
    // A tenant with no signing key of its own can sign nothing, so no send is
    // offered (and the call and the send refuse `NO_SIGNING_KEY` again).
    if (!(await currentTenantA2aPublicKey(ctx))) return [];
    // Nor without a public origin, which the tenant's identity is built on.
    if (!inflectA2aOrigin()) return [];

    const { connections, parameterSets } = await runInTenantContext(ctx, async (db) => ({
        connections: await db.integrationConnection.findMany({
            where: { id: { in: connectionIds }, tenantId: ctx.tenantId, provider: A2A_PEER_PROVIDER_ID, isEnabled: true },
            select: { id: true, name: true, configJson: true, externalWriteMode: true },
        }),
        parameterSets: await db.externalToolParameterSet.findMany({
            where: { tenantId: ctx.tenantId, toolName: { in: connectionIds.map(a2aSendToolName) } },
            orderBy: { label: 'asc' },
            take: 500,
            select: { toolName: true, label: true, parameters: true, openFields: true, targetPopulation: true },
        }),
    }));

    const out: GrantedA2aSendTool[] = [];
    for (const connection of connections) {
        const rung = coerceStoredMode(connection.externalWriteMode);
        if (rung === 'DISABLED') continue;
        const peerId = peerIdOf(connection.configJson);
        if (!peerId) continue;
        if (await resolvePeerKill(ctx, peerId)) continue;
        const admitted = await admitPeerMessage(ctx, peerId, net.card);
        if (!admitted.admission.admitted || !admitted.endpoint) {
            logger.warn('a2a.send_tool_withheld', {
                component: 'a2a-outbound',
                tenantId: ctx.tenantId,
                connectionId: connection.id,
                reason: admitted.admission.admitted ? 'NO_ENDPOINT' : admitted.admission.reason,
            });
            continue;
        }
        const qualified = a2aSendToolName(connection.id);
        out.push({
            qualified,
            def: A2A_SEND_TOOL_DEFINITION,
            peerId,
            connection: { id: connection.id, name: connection.name, url: admitted.endpoint, mode: rung },
            parameterSets: parameterSets
                .filter((p) => p.toolName === qualified)
                .map((p) => ({
                    label: p.label,
                    parameters: (p.parameters ?? {}) as Record<string, unknown>,
                    openFields: p.openFields ?? null,
                    targetPopulation: p.targetPopulation ?? null,
                })),
        });
    }
    return out;
}

/**
 * THE CALL: apply the ladder to one send. Returns the text the MODEL reads,
 * which says plainly that nothing was sent yet.
 */
export async function dispatchA2aSend(
    ctx: RequestContext,
    call: {
        qualified: string;
        peerId: string;
        connection: { id: string; name: string };
        policyCardVersion: number;
        outbound: Record<string, unknown>;
        parameterSetLabel: string | null;
    },
    net: A2aNetworkOptions = {},
): Promise<{ content: { type: 'text'; text: string }[]; isError: false }> {
    // R14, at the call. A peer may not use this tenant's agent to reach a
    // second peer (I4 E), whatever the snapshot said.
    if (ctx.a2aInbound) {
        recordA2aMetric({ direction: 'OUTBOUND', outcome: 'INBOUND_RUN_REFUSED' });
        throw refusedForModel(
            'a2a_send_refused_for_peer_started_run',
            'This run was started by a task from an A2A peer, and such a run may not send a task to a peer.',
        );
    }
    const parsedArgs = A2aSendArgsSchema.safeParse(call.outbound);
    if (!parsedArgs.success) {
        throw refusedForModel(
            'a2a_send_arguments_invalid',
            'A task to a peer takes `text`, and optionally `contextId`, `taskId` and `skillId`, and nothing else.',
        );
    }
    const args = parsedArgs.data;

    if (await resolvePeerKill(ctx, call.peerId)) {
        recordA2aMetric({ direction: 'OUTBOUND', outcome: 'PEER_KILLED' });
        throw refusedForModel('a2a_peer_stopped', 'This peer is stopped by an administrator\'s kill switch.');
    }
    if (!(await currentTenantA2aPublicKey(ctx))) {
        recordA2aMetric({ direction: 'OUTBOUND', outcome: 'NO_SIGNING_KEY' });
        throw refusedForModel(
            'a2a_no_signing_key',
            'This organisation has no A2A signing key, so no task to a peer can be signed. An owner must generate one.',
        );
    }
    if (!inflectA2aOrigin()) {
        recordA2aMetric({ direction: 'OUTBOUND', outcome: 'NO_PUBLIC_ORIGIN' });
        throw refusedForModel(
            'a2a_no_public_origin',
            'This deployment has no public https address configured, so it has no A2A identity to send as.',
        );
    }

    // The rung, read FRESH rather than taken from the assembly snapshot: a
    // narrowing must take effect at the next message.
    const connection = await runInTenantContext(ctx, (db) =>
        db.integrationConnection.findFirst({
            where: { id: call.connection.id, tenantId: ctx.tenantId, provider: A2A_PEER_PROVIDER_ID },
            select: { id: true, name: true, isEnabled: true, externalWriteMode: true, configJson: true },
        }),
    );
    if (!connection || !connection.isEnabled || peerIdOf(connection.configJson) !== call.peerId) {
        throw refusedForModel('a2a_connection_unavailable', 'The connection to this peer is gone or disabled.');
    }
    const rung = clampForInboundA2a(coerceStoredMode(connection.externalWriteMode), Boolean(ctx.a2aInbound));
    if (rung === 'DISABLED') {
        recordA2aMetric({ direction: 'OUTBOUND', outcome: 'DISABLED' });
        throw refusedForModel('a2a_connection_disabled', 'This connection is at DISABLED on the external write ladder.');
    }

    const admitted = await admitPeerMessage(ctx, call.peerId, net.card);
    if (!admitted.admission.admitted || !admitted.pin || !admitted.endpoint) {
        recordA2aMetric({ direction: 'OUTBOUND', outcome: admitted.admission.admitted ? 'NO_ENDPOINT' : admitted.admission.reason });
        throw refusedForModel(
            'a2a_peer_refused',
            'This peer is not admitted. If it or its agent card changed, a person must re-approve it.',
        );
    }

    const priorState = a2aSendPriorState({ peerId: call.peerId, pin: admitted.pin, args });
    const attempt = {
        connectionId: connection.id,
        connectionName: connection.name,
        endpointUrl: admitted.endpoint,
        toolName: call.qualified,
        advertisedToolName: A2A_SEND_TOOL,
        argumentsJson: JSON.stringify(args),
        priorStateJson: JSON.stringify(priorState),
    };

    if (rung === 'DRY_RUN') {
        const handle = await recordIntent(ctx, { ...attempt, mode: rung, agentId: ctx.agentId ?? null });
        recordA2aMetric({ direction: 'OUTBOUND', outcome: 'RECORDED_ONLY' });
        return modelText(
            `DRY RUN — nothing was sent. This connection is at DRY_RUN, so the task was recorded `
                + `and not sent to the peer. Journal reference ${handle.journalId}. Do not report this as `
                + 'a completed task.',
        );
    }

    if (rung === 'PROPOSE_ONLY') {
        const proposal = await createAgentProposal(ctx, {
            kind: 'EXTERNAL_WRITE',
            payload: {
                connectionId: attempt.connectionId,
                connectionName: attempt.connectionName,
                endpointUrl: attempt.endpointUrl,
                toolName: attempt.toolName,
                advertisedToolName: attempt.advertisedToolName,
                arguments: args,
                priorState,
            },
            policyCardVersion: call.policyCardVersion,
        });
        recordA2aMetric({ direction: 'OUTBOUND', outcome: 'PROPOSED' });
        const queued =
            proposal.status === 'QUARANTINED'
                ? `QUARANTINED — nothing was sent, and this will NOT be reviewed. The agentic output `
                  + `guard refused the content (${proposal.guardVerdict}). Proposal reference ${proposal.id}.`
                : `QUEUED FOR APPROVAL — nothing was sent. This connection is at PROPOSE_ONLY, so a `
                  + `person must approve the task before it is sent to the peer. Proposal reference ${proposal.id}.`;
        return modelText(`${queued} Do not report this as a completed task.`);
    }

    if (rung === 'AUTOMATIC') {
        const { journalId } = await openAutomaticExternalWrite(ctx, {
            ...attempt,
            parameterSetLabel: call.parameterSetLabel,
        });
        recordA2aMetric({ direction: 'OUTBOUND', outcome: 'QUEUED' });
        return modelText(
            `QUEUED FOR UNATTENDED DISPATCH — nothing has been sent yet. This connection is at `
                + `AUTOMATIC, so the external-write dispatch pass sends the task. Journal reference `
                + `${journalId}. Do not report this as a completed task; the journal row records the outcome.`,
        );
    }

    // A rung this build does not implement refuses — it never inherits a
    // neighbour's behaviour by falling through.
    throw refusedForModel('a2a_rung_unimplemented', `This build sends no A2A task at ${rung}.`);
}

function modelText(text: string): { content: { type: 'text'; text: string }[]; isError: false } {
    return { content: [{ type: 'text', text }], isError: false };
}

export interface A2aJournalRow {
    readonly id: string;
    readonly toolName: string;
    readonly mode: string;
    readonly argumentsJson: string;
    readonly priorStateJson: string;
    readonly parameterSetLabel: string | null;
    readonly agentId: string | null;
    readonly runId: string | null;
}

/** How the far end's A2A task state settles the journal row. */
function outcomeForTaskState(state: string): SettledOutcome {
    if (state === 'completed') return 'APPLIED';
    // Taken, not done. ACCEPTED claims strictly less than APPLIED.
    if (state === 'submitted' || state === 'working' || state === 'input-required' || state === 'auth-required') {
        return 'ACCEPTED';
    }
    // failed / rejected / canceled / anything else: the peer SAYS it did not
    // act, which is the peer's claim, not ours — INDETERMINATE.
    return 'INDETERMINATE';
}

/**
 * THE SEND, from the dispatch pass. Settles the row and returns the outcome.
 * Never throws for a refusal; a refusal is a settled `FAILED` row.
 */
export async function sendA2aJournalRow(
    ctx: RequestContext,
    row: A2aJournalRow,
    connection: { id: string; configJson: unknown; secretEncrypted: string | null },
    net: A2aNetworkOptions = {},
): Promise<SettledOutcome> {
    const settle = async (outcome: SettledOutcome, detail: string | null, metric: string) => {
        await settleWrite(ctx, row.id, outcome, detail);
        recordA2aMetric({ direction: 'OUTBOUND', outcome: metric });
        return outcome;
    };

    // The agent's own stops, at every scope. An agent killed after it queued a
    // task must not have the task leave on its behalf.
    const agentKill = await resolveKillState(ctx.tenantId, row.agentId);
    if (agentKill) return settle('FAILED', `A ${agentKill.scope} kill switch is in force, so the task was not sent.`, 'AGENT_KILLED');

    // R14 at the send: a row whose run a peer started never leaves. Unreachable
    // through the tool, which refuses first; this holds it for every other way a
    // row could have been opened.
    if (row.runId) {
        const run = await runInTenantContext(ctx, (db) =>
            db.workflowRun.findFirst({ where: { id: row.runId as string, tenantId: ctx.tenantId }, select: { inboundPeerId: true } }),
        );
        if (run?.inboundPeerId) {
            return settle('FAILED', 'The run behind this task was started by an A2A peer, and such a run may not send to a peer.', 'INBOUND_RUN_REFUSED');
        }
    }

    const peerId = peerIdOf(connection.configJson);
    if (!peerId || a2aSendConnectionId(row.toolName) !== connection.id) {
        return settle('FAILED', 'The connection no longer names the peer this task was written for.', 'CONNECTION_MOVED');
    }
    if (await resolvePeerKill(ctx, peerId)) {
        return settle('FAILED', 'A kill switch is in force on this peer, so the task was not sent.', 'PEER_KILLED');
    }

    let args: A2aSendArgs;
    try {
        args = A2aSendArgsSchema.parse(JSON.parse(row.argumentsJson));
    } catch {
        return settle('FAILED', 'The recorded task is not a well-formed A2A send, so it was not sent.', 'ARGUMENTS_INVALID');
    }

    const admitted = await admitPeerMessage(ctx, peerId, net.card);
    if (!admitted.admission.admitted || !admitted.pin || !admitted.endpoint) {
        const reason = admitted.admission.admitted ? 'NO_ENDPOINT' : admitted.admission.reason;
        return settle('FAILED', `The peer was not admitted (${reason}), so the task was not sent. A person must re-approve it.`, reason);
    }

    // R9: the basis the write was authorised on must still be the basis now.
    // A card re-approved between the decision and the send is a different
    // peer as far as that decision knew.
    const nowBasis = canonicalJson(a2aSendPriorState({ peerId, pin: admitted.pin, args }));
    let recorded: string;
    try {
        recorded = canonicalJson(JSON.parse(row.priorStateJson));
    } catch {
        recorded = '';
    }
    if (nowBasis !== recorded) {
        return settle(
            'FAILED',
            'The peer\'s card was re-approved after this task was authorised, so what was decided is not what '
                + 'would be sent. Nothing was sent; ask again under the current pin.',
            'BASIS_MOVED',
        );
    }

    if (coerceStoredMode(row.mode) === 'AUTOMATIC') {
        const bound = await automaticBoundRefusalAtSend(ctx, {
            toolName: row.toolName,
            parameterSetLabel: row.parameterSetLabel,
            argumentsJson: row.argumentsJson,
        });
        if (bound) return settle('FAILED', bound, 'BOUND_REFUSED');
    }

    const key = await resolveTenantA2aSigningKey(ctx);
    if (!key) {
        return settle('FAILED', 'This organisation has no A2A signing key, so the task cannot be signed and was not sent.', 'NO_SIGNING_KEY');
    }
    // What the task is signed as, and what the answer must be addressed to:
    // this tenant's card URL, the same for every peer (#3742).
    const inflect = await ownA2aIdentity(ctx);
    if (!inflect) {
        return settle(
            'FAILED',
            'This deployment has no public https origin (APP_URL), so it has no A2A identity to sign as. The task was not sent.',
            'NO_PUBLIC_ORIGIN',
        );
    }

    let authorization: string | undefined;
    try {
        const secrets = connection.secretEncrypted
            ? (JSON.parse(decryptField(connection.secretEncrypted)) as Record<string, unknown>)
            : {};
        authorization = typeof secrets.authorization === 'string' && secrets.authorization.trim() !== ''
            ? secrets.authorization.trim()
            : undefined;
    } catch {
        return settle('FAILED', 'The connection\'s credential is unusable, so the task was not sent.', 'CREDENTIAL_UNUSABLE');
    }

    const messageId = randomUUID();
    const body = buildA2aSendBody({
        rpcId: row.id,
        messageId,
        text: args.text,
        contextId: args.contextId,
        taskId: args.taskId,
        skillId: args.skillId,
    });
    const task = signA2aReceipt(
        {
            v: 'inflect-a2a-receipt/1',
            kind: 'TASK',
            messageId,
            relatesTo: null,
            method: 'message/send',
            sender: inflect,
            recipient: admitted.peer.cardUrl,
            issuedAt: new Date().toISOString(),
            bodyDigest: a2aBodyDigest(body),
        },
        key.privateKey,
    );
    // Kept BEFORE it leaves, so the record of what was sent survives whatever
    // happens on the wire.
    await recordA2aMessage(ctx, {
        peerId,
        direction: 'OUTBOUND',
        receipt: task,
        signerKeyFingerprint: key.fingerprint,
        signerPublicKey: key.publicKeyHex,
        body,
        agentId: row.agentId,
        runId: row.runId,
        journalId: row.id,
    });

    const sent = await sendA2aMessage({
        url: admitted.endpoint,
        authorization,
        body,
        receiptHeader: encodeA2aReceiptHeader(task),
        fetchImpl: net.fetchImpl,
    });
    if (!sent.ok) {
        return sent.mayHaveArrived
            ? settle('INDETERMINATE', `The task was sent and no usable answer came back (${sent.reason}).`, 'INDETERMINATE')
            : settle('FAILED', `The task was refused before it left (${sent.reason}).`, sent.reason);
    }

    const verdict = verifyA2aReceiptHeader(sent.receiptHeader, admitted.peer.signingPublicKey, {
        kind: 'RESULT',
        sender: admitted.peer.cardUrl,
        recipient: inflect,
        bodyDigest: a2aBodyDigest(sent.body),
        relatesTo: messageId,
    });
    if (!verdict.ok) {
        // The peer's answer could not be tied to the peer. It is discarded and
        // not kept: an unverified body is not a receipt. Whether the task was
        // acted on is unknown, so INDETERMINATE.
        logger.warn('a2a.reply_unverified', {
            component: 'a2a-outbound',
            tenantId: ctx.tenantId,
            journalId: row.id,
            reason: verdict.reason,
        });
        return settle(
            'INDETERMINATE',
            `The peer answered, and its answer could not be verified against its registered key (${verdict.reason}). `
                + 'It was discarded; confirm with the peer whether the task was acted on.',
            'REPLY_UNVERIFIED',
        );
    }
    try {
        await recordA2aMessage(ctx, {
            peerId,
            direction: 'INBOUND',
            receipt: verdict.receipt,
            signerKeyFingerprint: admitted.peer.signingKeyFingerprint,
            signerPublicKey: admitted.peer.signingPublicKey,
            body: sent.body,
            agentId: row.agentId,
            runId: row.runId,
            journalId: row.id,
        });
    } catch (err) {
        if (err instanceof A2aReplayError) {
            return settle('INDETERMINATE', 'The peer answered with a message id it had used before. The answer was not kept.', 'REPLAY');
        }
        throw err;
    }

    const reply = parseA2aPeerReply(sent.body, row.id);
    switch (reply.kind) {
        case 'message':
            return settle('APPLIED', 'The peer answered the task directly; its signed answer is kept.', 'APPLIED');
        case 'task': {
            const outcome = outcomeForTaskState(reply.state);
            const detail =
                outcome === 'APPLIED'
                    ? `The peer completed task ${reply.taskId}; its signed answer is kept.`
                    : outcome === 'ACCEPTED'
                      ? `The peer accepted task ${reply.taskId} (${reply.state}); it is not yet known to be done.`
                      : `The peer reported task ${reply.taskId} as ${reply.state}; whether anything changed is its claim.`;
            return settle(outcome, detail, outcome);
        }
        case 'error':
            return settle('INDETERMINATE', `The peer answered with JSON-RPC error ${reply.code}.`, 'INDETERMINATE');
        default:
            return settle('INDETERMINATE', 'The peer\'s signed answer was not a task or a message.', 'INDETERMINATE');
    }
}

// ─── #3743: asking a peer about a task it accepted ──────────────────────────

/**
 * What one poll of an `ACCEPTED` A2A send concluded.
 *
 * - `PROMOTED`: the peer reports the task completed, in a signed answer that
 *   verifies. The row is `APPLIED`.
 * - `INDETERMINATE`: the peer reports the task failed, was cancelled or was
 *   rejected, or its answer cannot be tied to it. The row is `INDETERMINATE`,
 *   as the send settles the same report.
 * - `STILL_RUNNING`: the peer reports the task under way. The row stays
 *   `ACCEPTED`, and its detail says when it was asked and how long it has been
 *   accepted.
 * - `NOT_POLLED`: nothing was asked, or nothing usable came back. The row stays
 *   `ACCEPTED` and is asked again next pass. `reason` says why.
 */
export type A2aPollResult =
    | { readonly outcome: 'PROMOTED' }
    | { readonly outcome: 'INDETERMINATE' }
    | { readonly outcome: 'STILL_RUNNING' }
    | { readonly outcome: 'NOT_POLLED'; readonly reason: string };

/**
 * How soon a row may be asked again: a quarter of the time it has been
 * accepted, between the pass's own ten minutes and six hours. A task the peer
 * finishes in minutes is seen in minutes; one that runs for days is asked a few
 * times a day, not 144, because every poll is two kept receipts and counts
 * against the peer's own inbound quota.
 */
export const A2A_POLL_MIN_INTERVAL_MS = 10 * 60 * 1000;
export const A2A_POLL_MAX_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function a2aPollDue(acceptedAt: Date | null, lastPolledAt: Date | null, now: Date): boolean {
    if (!lastPolledAt) return true;
    const age = acceptedAt ? now.getTime() - acceptedAt.getTime() : 0;
    const interval = Math.min(A2A_POLL_MAX_INTERVAL_MS, Math.max(A2A_POLL_MIN_INTERVAL_MS, age / 4));
    return now.getTime() - lastPolledAt.getTime() >= interval;
}

/** How long a row has been accepted, for its detail. Coarse on purpose. */
function acceptedFor(since: Date | null, now: Date): string {
    if (!since) return 'for an unknown time';
    const minutes = Math.max(0, Math.round((now.getTime() - since.getTime()) / 60_000));
    if (minutes < 120) return `for ${minutes} minute${minutes === 1 ? '' : 's'}`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `for ${hours} hours`;
    return `for ${Math.round(hours / 24)} days`;
}

/**
 * Ask the peer about one `ACCEPTED` send with `tasks/get`, and settle the row
 * only on what a signed, verified answer says (#3743).
 *
 * The same rails as the send, in the same order, because a poll goes out on
 * the same wire to the same organisation:
 *   the peer's kill → the card admission → the basis the write was authorised
 *   on (a re-approved card is a different peer as far as that decision knew)
 *   → the tenant's signing key and identity → the peer's credential.
 * Then the request and its answer are each kept as a receipt, as every A2A
 * message is. The poll is a read: `tasks/get` asks after a task and changes
 * nothing, and the client's closed method set is what lets it leave.
 *
 * Promotion only on positive, verified evidence. A transport failure, a JSON-RPC
 * error or an answer that is not a task leaves the row `ACCEPTED`; only a
 * signed report of a terminal state, or a signature that fails, settles it.
 */
export async function pollAcceptedA2aSend(
    ctx: RequestContext,
    row: A2aJournalRow & { readonly settledAt: Date | null },
    connection: { id: string; isEnabled: boolean; configJson: unknown; secretEncrypted: string | null },
    net: A2aNetworkOptions = {},
    /** Test seam for the backoff. */
    now?: Date,
): Promise<A2aPollResult> {
    const notPolled = (reason: string): A2aPollResult => {
        recordA2aMetric({ direction: 'OUTBOUND', outcome: `POLL_${reason}` });
        return { outcome: 'NOT_POLLED', reason };
    };

    const peerId = peerIdOf(connection.configJson);
    if (!peerId || a2aSendConnectionId(row.toolName) !== connection.id) return notPolled('CONNECTION_MOVED');
    if (!connection.isEnabled) return notPolled('CONNECTION_DISABLED');
    if (await resolvePeerKill(ctx, peerId)) return notPolled('PEER_KILLED');

    const admitted = await admitPeerMessage(ctx, peerId, net.card);
    if (!admitted.admission.admitted || !admitted.pin || !admitted.endpoint) {
        return notPolled(admitted.admission.admitted ? 'NO_ENDPOINT' : admitted.admission.reason);
    }

    let args: A2aSendArgs;
    let recorded: string;
    try {
        args = A2aSendArgsSchema.parse(JSON.parse(row.argumentsJson));
        recorded = canonicalJson(JSON.parse(row.priorStateJson));
    } catch {
        return notPolled('ARGUMENTS_INVALID');
    }
    if (canonicalJson(a2aSendPriorState({ peerId, pin: admitted.pin, args })) !== recorded) {
        return notPolled('BASIS_MOVED');
    }

    const lastPoll = await runInTenantContext(ctx, (db) =>
        db.peerAgentMessage.findFirst({
            where: { tenantId: ctx.tenantId, journalId: row.id, direction: 'OUTBOUND', kind: 'TASK', method: 'tasks/get' },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true },
        }),
    );
    if (!a2aPollDue(row.settledAt, lastPoll?.createdAt ?? null, now ?? new Date())) {
        return { outcome: 'NOT_POLLED', reason: 'NOT_DUE' };
    }

    // The peer's own id for the task, from the answer it signed to the send:
    // the first RESULT kept against this row. Later RESULTs are this pass's own
    // polls, so the oldest is the one that answered `message/send`.
    const answer = await runInTenantContext(ctx, (db) =>
        db.peerAgentMessage.findFirst({
            where: { tenantId: ctx.tenantId, journalId: row.id, direction: 'INBOUND', kind: 'RESULT' },
            orderBy: { createdAt: 'asc' },
            select: { body: true },
        }),
    );
    const accepted = answer ? parseA2aPeerReply(answer.body, row.id) : null;
    if (accepted?.kind !== 'task') return notPolled('NO_TASK_ID');

    const key = await resolveTenantA2aSigningKey(ctx);
    if (!key) return notPolled('NO_SIGNING_KEY');
    const inflect = await ownA2aIdentity(ctx);
    if (!inflect) return notPolled('NO_PUBLIC_ORIGIN');

    let authorization: string | undefined;
    try {
        const secrets = connection.secretEncrypted
            ? (JSON.parse(decryptField(connection.secretEncrypted)) as Record<string, unknown>)
            : {};
        authorization = typeof secrets.authorization === 'string' && secrets.authorization.trim() !== ''
            ? secrets.authorization.trim()
            : undefined;
    } catch {
        return notPolled('CREDENTIAL_UNUSABLE');
    }

    const rpcId = randomUUID();
    const messageId = randomUUID();
    const body = buildA2aTaskGetBody({ rpcId, taskId: accepted.taskId });
    const task = signA2aReceipt(
        {
            v: 'inflect-a2a-receipt/1',
            kind: 'TASK',
            messageId,
            relatesTo: null,
            method: 'tasks/get',
            sender: inflect,
            recipient: admitted.peer.cardUrl,
            issuedAt: new Date().toISOString(),
            bodyDigest: a2aBodyDigest(body),
        },
        key.privateKey,
    );
    await recordA2aMessage(ctx, {
        peerId,
        direction: 'OUTBOUND',
        receipt: task,
        signerKeyFingerprint: key.fingerprint,
        signerPublicKey: key.publicKeyHex,
        body,
        agentId: row.agentId,
        runId: row.runId,
        journalId: row.id,
    });

    const sent = await sendA2aMessage({
        url: admitted.endpoint,
        authorization,
        body,
        receiptHeader: encodeA2aReceiptHeader(task),
        fetchImpl: net.fetchImpl,
    });
    if (!sent.ok) return notPolled(`SEND_${sent.reason}`);

    const verdict = verifyA2aReceiptHeader(sent.receiptHeader, admitted.peer.signingPublicKey, {
        kind: 'RESULT',
        sender: admitted.peer.cardUrl,
        recipient: inflect,
        bodyDigest: a2aBodyDigest(sent.body),
        relatesTo: messageId,
    });
    if (!verdict.ok) {
        logger.warn('a2a.poll_unverified', {
            component: 'a2a-outbound',
            tenantId: ctx.tenantId,
            journalId: row.id,
            reason: verdict.reason,
        });
        await concludeAcceptedIndeterminate(
            ctx,
            row.id,
            `Asked about task ${accepted.taskId}, the peer answered in a way that could not be verified against `
                + `its registered key (${verdict.reason}). The answer was discarded; confirm with the peer whether `
                + 'the task was acted on.',
        );
        recordA2aMetric({ direction: 'OUTBOUND', outcome: 'POLL_REPLY_UNVERIFIED' });
        return { outcome: 'INDETERMINATE' };
    }
    try {
        await recordA2aMessage(ctx, {
            peerId,
            direction: 'INBOUND',
            receipt: verdict.receipt,
            signerKeyFingerprint: admitted.peer.signingKeyFingerprint,
            signerPublicKey: admitted.peer.signingPublicKey,
            body: sent.body,
            agentId: row.agentId,
            runId: row.runId,
            journalId: row.id,
        });
    } catch (err) {
        if (err instanceof A2aReplayError) return notPolled('REPLAY');
        throw err;
    }

    const reply = parseA2aPeerReply(sent.body, rpcId);
    if (reply.kind !== 'task' || reply.taskId !== accepted.taskId) {
        // An error (the peer may not know the task yet, or at all) or a shape
        // that is not this task: kept, and asked again. Neither is a report of
        // the task's state.
        return notPolled(reply.kind === 'error' ? `PEER_ERROR_${reply.code}` : 'NOT_THIS_TASK');
    }
    const outcome = outcomeForTaskState(reply.state);
    if (outcome === 'APPLIED') {
        await promoteAcceptedWrite(
            ctx,
            row.id,
            `The peer reports task ${reply.taskId} completed, in a signed answer to tasks/get that verifies `
                + 'against its registered key. The request and the answer are kept.',
        );
        recordA2aMetric({ direction: 'OUTBOUND', outcome: 'POLL_APPLIED' });
        return { outcome: 'PROMOTED' };
    }
    if (outcome === 'ACCEPTED') {
        const at = now ?? new Date();
        await noteAcceptedWrite(
            ctx,
            row.id,
            `The peer accepted task ${reply.taskId} and reported it ${reply.state} at ${at.toISOString()}, `
                + `accepted ${acceptedFor(row.settledAt, at)}. It is not yet known to be done.`,
        );
        recordA2aMetric({ direction: 'OUTBOUND', outcome: 'POLL_STILL_RUNNING' });
        return { outcome: 'STILL_RUNNING' };
    }
    await concludeAcceptedIndeterminate(
        ctx,
        row.id,
        `The peer reports task ${reply.taskId} as ${reply.state}, in a signed answer to tasks/get. Whether `
            + 'anything changed is its claim.',
    );
    recordA2aMetric({ direction: 'OUTBOUND', outcome: 'POLL_INDETERMINATE' });
    return { outcome: 'INDETERMINATE' };
}
