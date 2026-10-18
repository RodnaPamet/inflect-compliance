/**
 * ASK FOR A CONTAINED AGENT'S ENTRA SERVICE PRINCIPAL TO BE DISABLED — through
 * the external write ladder, and only through it (#3671, agentic IAM 2c).
 *
 * The owner-orphan pass stops an agent inside Inflect: an `OWNER_DEPARTED` kill
 * and a suspension. This module carries the containment one step outward, into
 * the customer's directory, and it does so WITHOUT a directory client of its
 * own. It finds the outbound endpoint the tenant nominated, runs that
 * endpoint's paired prior-state read, and then hands the write to exactly the
 * primitive the agent-facing path uses for the connection's rung:
 *
 *   DISABLED      nothing — not even the read.
 *   DRY_RUN       `recordIntent`: a RECORDED_ONLY journal row with the prior
 *                 state, and nothing sent. It is the evidence that rung's dwell
 *                 counts.
 *   PROPOSE_ONLY  `createAgentProposal` of kind EXTERNAL_WRITE, carrying the
 *                 prior state, for a human to approve. Approval opens the
 *                 journal row; the dispatch re-reads and refuses on drift.
 *   AUTOMATIC     `openAutomaticExternalWrite`: a PENDING journal row carrying
 *                 the prior state, under an approved template whose target is
 *                 bounded to the contained-agent population. The dispatch sends
 *                 it after re-resolving that population.
 *
 * The write itself leaves only from `external-write-dispatch` — the one sender
 * in the build — and settles `ACCEPTED`; only the reconcile, reading the
 * principal back, promotes it to `APPLIED`. Nothing in this file opens a
 * socket except the paired READ, through `callTool`, the one outbound MCP seam.
 *
 * ═══ THE ORDER IS THE DESIGN ═══
 *
 *   1. Is the agent contained, and does it name exactly one principal?
 *   2. Is there exactly one nominated pairing for the disable tool, on a usable
 *      connection? ("No external write without prior state": no pairing, no
 *      write.)
 *   3. The connection's rung. DISABLED stops here, before any read.
 *   4. Has a person confirmed this link? At AUTOMATIC an unconfirmed link is
 *      refused (`LINK_UNCONFIRMED`); below it, the proposal or intent says.
 *      Then, at AUTOMATIC only: exactly one approved template bounded to the
 *      contained-agent population, and the principal in that population NOW.
 *   5. The paired read, with the write's own arguments. A read that fails, or
 *      answers in any shape but the read tool's, REFUSES the write.
 *   6. Already disabled? Nothing to write.
 *   7. Only then, the rung's primitive.
 *
 * ═══ IT NEVER THROWS ═══
 *
 * The caller is the orphan pass, mid-sweep, with the kill and the suspension
 * already landed. A failure here must be a recorded outcome on that agent's
 * decision, not an exception that turns the whole pass into an ERROR row and
 * hides the containment that DID happen.
 *
 * @module usecases/agent-service-principal-disable
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { decryptField } from '@/lib/security/encryption';
import { logger } from '@/lib/observability/logger';
import { recordAgentServicePrincipalDisable } from '@/lib/observability/integration-metrics';
import { coerceStoredMode } from '@/lib/integrations/external-write-ladder';
import { parseOpenFields } from '@/lib/integrations/open-fields';
import { parseExternalToolName } from '@/lib/mcp/external-tool-name';
import { NO_POLICY_CARD } from '@/lib/agentic/policy-card';
import {
    CONTAINED_AGENT_SP_POPULATION,
    SERVICE_PRINCIPAL_DISABLE_TOOL,
    SERVICE_PRINCIPAL_TARGET_FIELD,
    servicePrincipalFactsOf,
    type ServicePrincipalDisableRecord,
    type ServicePrincipalDisableStatus,
} from '@/lib/agentic/service-principal-disable';
import { callTool } from '@/app-layer/integrations/mcp/client';
import { authorizationFor } from '@/app-layer/integrations/mcp/token';
import { MCP_SERVER_PROVIDER_ID } from '@/app-layer/integrations/providers/mcp-server-provider';

import { readContainedAgentServicePrincipalLinks } from './agent-service-principal-links';
import { liveConfirmationFor } from './agent-service-principal-confirmation';
import { checkTargetInPopulation } from './external-tool-target-populations';
import { recordIntent } from './external-write-journal';
import { openAutomaticExternalWrite } from './external-write-automatic';
import { createAgentProposal } from './agent-proposals';

/** Bounded, ours, and never the far end's prose. */
function bounded(text: string): string {
    return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

/**
 * What the approving human is told about the link (owner decision,
 * 2026-10-18): a confirmed link names who confirmed it and when; an
 * unconfirmed one says so plainly, because it is the scanner's claim and the
 * approval is the only person who will look at it.
 */
function linkSentence(
    confirmation: { readonly id: string; readonly confirmedByUserId: string; readonly confirmedAt: Date } | null,
): string {
    if (confirmation === null) {
        return (
            'THE LINK IS UNCONFIRMED: it is the harness scanner\'s reconciliation, and no person has '
            + 'confirmed that this principal is the agent\'s own. Check the principal in the prior '
            + 'state before approving.'
        );
    }
    return (
        `The link was confirmed by user ${confirmation.confirmedByUserId} at `
        + `${confirmation.confirmedAt.toISOString()} (confirmation ${confirmation.id}).`
    );
}

/** How many pairings, templates or links we read to tell "one" from "several". */
const ONE_OR_SEVERAL = 5;

type Outcome = ServicePrincipalDisableRecord & { readonly status: ServicePrincipalDisableStatus };

/**
 * Request the disable of `agentId`'s principal. Returns what happened; never
 * throws. Emits one outcome metric per call.
 */
export async function requestServicePrincipalDisable(
    ctx: RequestContext,
    input: { readonly agentId: string },
): Promise<Outcome> {
    let outcome: Outcome;
    try {
        outcome = await request(ctx, input);
    } catch (err) {
        outcome = {
            status: 'FAILED',
            detail: bounded(
                `The disable request could not be completed: ${err instanceof Error ? err.message : 'non-Error thrown'}`,
            ),
        };
    }
    recordAgentServicePrincipalDisable({ outcome: outcome.status, rung: outcome.rung ?? 'none' });
    logger.info('agent service principal disable requested', {
        component: 'agent-service-principal-disable',
        tenantId: ctx.tenantId,
        agentId: input.agentId,
        status: outcome.status,
        rung: outcome.rung ?? 'none',
    });
    return outcome;
}

async function request(ctx: RequestContext, input: { readonly agentId: string }): Promise<Outcome> {
    // ── 1. CONTAINED, AND ONE PRINCIPAL ────────────────────────────────────
    const read = await readContainedAgentServicePrincipalLinks(ctx, {
        agentIds: [input.agentId],
        limit: ONE_OR_SEVERAL,
    });
    if (!read.containedAgentIds.has(input.agentId)) {
        return {
            status: 'NOT_CONTAINED',
            detail:
                'No OWNER_DEPARTED kill is in force for this agent, so it is not contained and its '
                + 'principal is not this pass\'s to disable.',
        };
    }
    const links = read.links.filter((l) => l.agentId === input.agentId);
    if (links.length === 0) return { status: 'NOT_LINKED' };
    if (links.length > 1) {
        return {
            status: 'AMBIGUOUS_LINK',
            detail:
                `The harness reconciled ${links.length} Entra service principals to this agent. `
                + 'A disable names one, so none was requested.',
        };
    }
    const link = links[0];
    if (link.servicePrincipalId === null) {
        return {
            status: 'NOT_LINKED',
            discoveredAgentId: link.discoveredAgentId,
            detail: 'The discovered principal\'s id is not a directory object id.',
        };
    }
    const base = { discoveredAgentId: link.discoveredAgentId };

    // ── 2. THE NOMINATED PAIRING, AND ITS CONNECTION ───────────────────────
    //
    // The pairing names the connection: `mcp__<connectionId>__disable_service_principal`.
    // Found through the pairing rather than by URL, because a write with no
    // nominated prior-state read is refused whatever else is configured.
    const pairings = (
        await runInTenantContext(ctx, (db) =>
            db.externalToolPriorStateRead.findMany({
                where: {
                    tenantId: ctx.tenantId,
                    writeToolName: { endsWith: `__${SERVICE_PRINCIPAL_DISABLE_TOOL}` },
                },
                select: { writeToolName: true, readToolName: true },
                orderBy: { writeToolName: 'asc' },
                take: ONE_OR_SEVERAL,
            }),
        )
    ).filter((p) => parseExternalToolName(p.writeToolName)?.toolName === SERVICE_PRINCIPAL_DISABLE_TOOL);
    if (pairings.length === 0) return { ...base, status: 'NO_PAIRED_ENDPOINT' };
    if (pairings.length > 1) {
        return {
            ...base,
            status: 'AMBIGUOUS_PAIRED_ENDPOINT',
            detail:
                `${pairings.length} connections pair a prior-state read with `
                + `${SERVICE_PRINCIPAL_DISABLE_TOOL}. A disable names one directory, so none was `
                + 'requested; clear the pairings that should not receive it.',
        };
    }
    const pairing = pairings[0];
    const writeRef = parseExternalToolName(pairing.writeToolName);
    const readRef = parseExternalToolName(pairing.readToolName);
    if (!writeRef || !readRef || readRef.connectionId !== writeRef.connectionId) {
        return {
            ...base,
            status: 'CONNECTION_UNUSABLE',
            detail: 'The nominated prior-state read is not a usable tool on the same connection.',
        };
    }

    const connection = await runInTenantContext(ctx, (db) =>
        db.integrationConnection.findFirst({
            where: {
                id: writeRef.connectionId,
                tenantId: ctx.tenantId,
                provider: MCP_SERVER_PROVIDER_ID,
            },
            select: {
                id: true,
                name: true,
                isEnabled: true,
                configJson: true,
                secretEncrypted: true,
                externalWriteMode: true,
            },
        }),
    );
    const withConnection = { ...base, connectionId: writeRef.connectionId };
    if (!connection || !connection.isEnabled) {
        return {
            ...withConnection,
            status: 'CONNECTION_UNUSABLE',
            detail: 'The connection the disable is paired on is gone or disabled.',
        };
    }

    // ── 3. THE RUNG. DISABLED STOPS BEFORE ANY READ ────────────────────────
    //
    // Coerced at the read boundary: an unrecognised stored value is DISABLED.
    const rung = coerceStoredMode(connection.externalWriteMode);
    const atRung = { ...withConnection, rung };
    if (rung === 'DISABLED') return { ...atRung, status: 'RUNG_DISABLED' };

    const url = ((connection.configJson ?? {}) as { url?: unknown }).url;
    if (typeof url !== 'string' || !url.trim()) {
        return { ...atRung, status: 'CONNECTION_UNUSABLE', detail: 'The connection has no URL.' };
    }
    let authorization: string | undefined;
    try {
        const secrets = connection.secretEncrypted
            ? (JSON.parse(decryptField(connection.secretEncrypted)) as Record<string, unknown>)
            : {};
        // The SHARED resolver — the one the dispatch and the Test button use.
        authorization = await authorizationFor(
            connection.id,
            (connection.configJson ?? {}) as Record<string, unknown>,
            secrets,
        );
    } catch {
        return {
            ...atRung,
            status: 'CONNECTION_UNUSABLE',
            detail: 'The connection credentials are unusable.',
        };
    }
    const transport = { url: url.trim(), authorization };

    // ── 4a. HAS A PERSON CONFIRMED THIS LINK? ──────────────────────────────
    //
    // Asked at every rung that reads, and decisive at AUTOMATIC only (owner
    // decision, 2026-10-18). The link is the scanner's reconciliation; a
    // person reviewing a proposal can judge it, and the proposal says which it
    // is. A write with nobody in it needs a person to have confirmed THIS link
    // — exactly this principal, this agent — and no scan to have moved it.
    const confirmation = await liveConfirmationFor(ctx, {
        agentId: input.agentId,
        discoveredAgentId: link.discoveredAgentId,
        discoveredId: link.discoveredId,
    });
    const confirmed = { ...atRung, linkConfirmed: confirmation !== null };
    if (rung === 'AUTOMATIC' && confirmation === null) {
        return {
            ...confirmed,
            status: 'LINK_UNCONFIRMED',
            detail:
                'The connection is at AUTOMATIC and no person has confirmed that this principal is '
                + 'the agent\'s own. Confirm the link on the agent (admin.agent_registry) for an '
                + 'unattended disable; nothing was read or opened.',
        };
    }

    // ── 4b. AT AUTOMATIC: THE ONE TEMPLATE, AND THE POPULATION NOW ─────────
    //
    // The arguments sent are the template's exact values with the target
    // merged OVER nothing — a template that also fixes `servicePrincipalId` is
    // a template that names a principal, and is not one this pass may use.
    let args: Record<string, unknown> = { [SERVICE_PRINCIPAL_TARGET_FIELD]: link.servicePrincipalId };
    let parameterSetLabel: string | null = null;
    if (rung === 'AUTOMATIC') {
        const sets = await runInTenantContext(ctx, (db) =>
            db.externalToolParameterSet.findMany({
                where: { tenantId: ctx.tenantId, toolName: pairing.writeToolName },
                select: { label: true, parameters: true, openFields: true, targetPopulation: true },
                orderBy: { label: 'asc' },
                take: ONE_OR_SEVERAL,
            }),
        );
        const usable = sets.filter((s) => {
            const parsed = parseOpenFields(s.openFields ?? null, s.targetPopulation ?? null);
            if (parsed.state !== 'ok') return false;
            const names = Object.keys(parsed.fields);
            const target = parsed.fields[SERVICE_PRINCIPAL_TARGET_FIELD];
            const params = (s.parameters ?? {}) as Record<string, unknown>;
            return (
                names.length === 1
                && target !== undefined
                && target.kind === 'target'
                && target.population === CONTAINED_AGENT_SP_POPULATION
                && !Object.hasOwn(params, SERVICE_PRINCIPAL_TARGET_FIELD)
            );
        });
        if (usable.length === 0) {
            return {
                ...confirmed,
                status: 'NO_APPROVED_TEMPLATE',
                detail:
                    'The connection is at AUTOMATIC and no approved template opens only '
                    + `${SERVICE_PRINCIPAL_TARGET_FIELD} as a target bounded to `
                    + `${CONTAINED_AGENT_SP_POPULATION}. Nothing was opened.`,
            };
        }
        if (usable.length > 1) {
            return {
                ...confirmed,
                status: 'AMBIGUOUS_TEMPLATE',
                detail:
                    `${usable.length} approved templates qualify for the unattended disable, so none `
                    + 'was chosen. Remove the ones that should not be used.',
            };
        }
        const set = usable[0];
        parameterSetLabel = set.label;
        args = { ...((set.parameters ?? {}) as Record<string, unknown>), ...args };

        // The same primitive the agent path and the compose surface use. It is
        // resolved again, from live data, when the dispatch sends.
        const member = await checkTargetInPopulation(
            ctx,
            CONTAINED_AGENT_SP_POPULATION,
            link.servicePrincipalId,
        );
        if (!member.ok) {
            return {
                ...confirmed,
                status: 'NOT_IN_POPULATION',
                detail: `The contained-agent population did not admit this principal (${member.kind}).`,
            };
        }
    }

    // ── 5. THE PAIRED READ, WITH THE WRITE'S OWN ARGUMENTS ─────────────────
    //
    // Through `callTool`, the one outbound seam, so the egress scan applies. A
    // read that throws, answers with an error, or answers in any shape but the
    // read tool's REFUSES the write: unreadable prior state is a refusal, not a
    // warning (owner decision 2, and rule 5 of the roadmap).
    let priorState: unknown;
    try {
        priorState = await callTool(transport, readRef.toolName, args);
    } catch {
        return {
            ...confirmed,
            status: 'PRIOR_STATE_UNREADABLE',
            detail: 'The paired prior-state read could not be run, so the disable was not requested.',
        };
    }
    const facts = servicePrincipalFactsOf(priorState);
    if (facts === null || facts.id !== link.servicePrincipalId) {
        return {
            ...confirmed,
            status: 'PRIOR_STATE_UNREADABLE',
            detail:
                'The paired prior-state read did not report this principal\'s state, so what the '
                + 'disable would replace cannot be recorded. Nothing was requested.',
        };
    }

    // ── 6. NOTHING TO DO ───────────────────────────────────────────────────
    if (!facts.accountEnabled) return { ...confirmed, status: 'ALREADY_DISABLED' };

    const write = {
        connectionId: connection.id,
        connectionName: connection.name,
        endpointUrl: transport.url,
        toolName: pairing.writeToolName,
        advertisedToolName: writeRef.toolName,
    };

    // ── 7. THE RUNG'S PRIMITIVE ────────────────────────────────────────────
    if (rung === 'DRY_RUN') {
        const handle = await recordIntent(ctx, {
            ...write,
            mode: rung,
            argumentsJson: JSON.stringify(args),
            priorStateJson: JSON.stringify(priorState),
            // No agent DECIDED this: the contained agent is its subject, and
            // the decider is the system pass. Attributing it to the agent would
            // read as the agent disabling itself.
            agentId: null,
        });
        return { ...confirmed, status: 'RECORDED_INTENT', journalId: handle.journalId };
    }

    if (rung === 'PROPOSE_ONLY') {
        try {
            const proposal = await createAgentProposal(ctx, {
                kind: 'EXTERNAL_WRITE',
                payload: { ...write, arguments: args, priorState },
                // No agent proposed this, so no card governed it — the
                // sentinel, not null: the question was asked and the answer
                // was "none".
                policyCardVersion: NO_POLICY_CARD,
                rationale:
                    `The owner-orphan pass contained registered agent ${input.agentId} because its `
                    + 'accountable owner has left (OWNER_DEPARTED), and the harness reconciled one '
                    + 'Entra service principal to it. Disabling the principal stops its credentials '
                    + 'working in the directory as well as in Inflect. It is undone by re-enabling '
                    + 'the principal. '
                    + linkSentence(confirmation),
                proposedBySessionRef: `agent-owner-orphan-pass:${input.agentId}`,
            });
            return {
                ...confirmed,
                status: proposal.status === 'QUARANTINED' ? 'QUARANTINED' : 'PROPOSED',
                proposalId: proposal.id,
            };
        } catch (err) {
            return {
                ...confirmed,
                status: 'REFUSED',
                detail: bounded(
                    `The proposal was refused: ${err instanceof Error ? err.message : 'non-Error thrown'}`,
                ),
            };
        }
    }

    if (rung === 'AUTOMATIC') {
        try {
            const opened = await openAutomaticExternalWrite(ctx, {
                ...write,
                parameterSetLabel,
                argumentsJson: JSON.stringify(args),
                priorStateJson: JSON.stringify(priorState),
            });
            return { ...confirmed, status: 'QUEUED', journalId: opened.journalId };
        } catch (err) {
            return {
                ...confirmed,
                status: 'REFUSED',
                detail: bounded(
                    `The unattended write was refused: ${err instanceof Error ? err.message : 'non-Error thrown'}`,
                ),
            };
        }
    }

    // A rung added to the ladder without a branch here is refused, never
    // inherited — the identity ladder's lesson.
    return {
        ...confirmed,
        status: 'REFUSED',
        detail: `This build requests no disable at ${rung}.`,
    };
}
