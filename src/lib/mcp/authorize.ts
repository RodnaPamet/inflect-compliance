/**
 * Per-invocation authorization for MCP tool calls — the one gate, applied once
 * per tool call, reusing the checks the equivalent human route already makes.
 *
 * ## What runs, in order, and why that order
 *
 *   1. AUDIENCE — was the token the caller presented minted FOR this tool?
 *      (RFC 8693; `null` for a caller holding the long-lived key itself.)
 *   2. LIVENESS — is the credential still live RIGHT NOW? Re-read per tool
 *      call, never cached, so a revoke lands inside a run in flight.
 *   3. EXPOSURE — is this tool on the agent's allowlist? Deny-by-default.
 *   4. AUTONOMY — is the rung this tool represents at or below the effective
 *      ceiling, `min(key max, agent autonomyLevel)`?
 *   5. POLICY CARD — is this call inside the agent's own declared, versioned
 *      runtime policy: its permitted tools, its data rung, its autonomy rung and
 *      its per-run and per-day action budgets?
 *   6. CAPABILITY — does the CREDENTIAL carry `mcp:propose`? (propose tools).
 *   7. RESOURCE SCOPE — does the CREDENTIAL carry `risks:read`?
 *   8. PERMISSION — may the PRINCIPAL do this? `assertPermission`, the SAME
 *      function `requirePermission` calls on the equivalent human route.
 *   9. POLICY — the shared `assertCanRead` / `assertCanWrite` the mirrored route
 *      applies, where `PermissionSet` has no key to name.
 *
 * Cheapest and least-revealing first, and CREDENTIAL checks before PRINCIPAL
 * checks. That ordering is not cosmetic: 1-7 are configuration — a key scoped
 * for controls calling a risks tool is an integration that needs a wider key,
 * and its refusal should say "scope", by name, so somebody can fix it. 8-9 are
 * the authority question, and a refusal there means the human this agent speaks
 * for genuinely may not do this. If the order were reversed, every under-scoped
 * integration would surface as a generic "Permission denied" and the audit trail
 * would fill with rows that look like an agent exceeding its authority when it
 * was only pointed at the wrong tool. An agent probing for reach it does not
 * have is the whole reason these rows exist; burying that in routine
 * misconfiguration is how a security signal stops being read.
 *
 * LIVENESS sits at 2 rather than later for two reasons. It is the check whose
 * ANSWER CHANGES DURING A RUN — every other term was fixed when the invocation
 * was assembled — so it has to be re-asked, and asking it early means a revoked
 * credential learns nothing about grants or ceilings on its way out. And it is
 * the one an operator reaches for in an incident: "revoke the key" has to mean
 * the next tool call, not the next run.
 *
 * ## The boundary, not the dispatch
 *
 * Steps 1, 2 and 4 all run HERE, per tool call, and that placement is the whole
 * of subpoint 6. The workflow engine resolves ONE `McpInvocation` per execution
 * and then runs many steps on it; a revocation checked at dispatch would leave a
 * run already in flight holding its authority to the end. A status code cannot
 * tell the two designs apart — both refuse the next REQUEST — so the property is
 * stated as "no further tool executes", and tested that way.
 *
 * ## Exactly one audit row per denial
 *
 * Every refusal writes ONE hash-chained `AUTHZ_DENIED` row and throws. Step 8
 * does it inside `assertPermission` (the same row a denied human route writes,
 * `entity: 'Permission'`); every other step does it through `denyToolCall`
 * below (`entity: 'McpTool'`). The steps are ordered and each returns by
 * throwing, so no path can produce two rows — and the paths that used to produce
 * ZERO rows (a scope throw, a bare `assertCanRead` throw inside a usecase: what
 * an agent denial looked like before today) now produce one.
 *
 * ## The 403 never names the permission key
 *
 * `assertPermission` throws the generic `forbidden('Permission denied')`; the
 * key travels only in the audit row. The messages here name the TOOL and the
 * SCOPES, both of which the caller supplied or already holds, and nothing else.
 */
import { appendAuditEntry } from '@/lib/audit';
import { enforceApiKeyScope } from '@/lib/auth/api-key-auth';
import { forbidden } from '@/lib/errors/types';
import {
    DENY_CEILING,
    requiredAutonomyFor,
    withinCeiling,
    type McpCapabilityClass,
} from '@/lib/agentic/autonomy-ceiling';
import {
    evaluateCardDailyBudget,
    evaluateCardReach,
    type PolicyCardInForce,
} from '@/lib/agentic/policy-card-evaluation';
import { reserveDailyAction } from '@/lib/agentic/policy-card-store';
import {
    recordPolicyCardEvaluation,
    recordPolicyCardRefusal,
} from '@/lib/observability/integration-metrics';
import { RESOURCE_READ_DATA_SCOPE, dataScopeForToolCall } from './tool-data-scope';
import type { AgentDataAccessScope } from '@prisma/client';
import { checkCredentialLiveness } from '@/lib/agentic/agent-credential-state';
import {
    audienceCovers,
    isTokenLive,
    MCP_RESOURCES_AUDIENCE,
    type Clock,
} from './token-exchange';
import { logger } from '@/lib/observability/logger';
import { assertPermission } from '@/lib/security/permission-middleware';
import { assertCanRead, assertCanWrite } from '@/app-layer/policies/common';
import { isAppError } from '@/lib/errors/types';
import type { PermissionSet } from '@/lib/permissions';
import type { AgentRiskTier } from '@prisma/client';
import type { RequestContext } from '@/app-layer/types';
import type { AgentPrincipal } from '@/lib/agentic/agent-authority';

import { enforceMcpCapability } from './auth';
import {
    toolIsLoadable,
    toolManifestDigest,
    toolWasOffered,
    type ToolManifest,
} from './tool-manifest';
import type { McpToolAuthorization, ScopeAction } from './tools/types';

/** The MCP surface, for the audit row. Mirrors `requirePermission`'s reqMeta. */
export const MCP_SURFACE = { method: 'POST', path: '/api/mcp' } as const;

/**
 * Everything one tool call is authorized against. Assembled once per HTTP
 * request by the route and passed down, so a tool cannot construct its own.
 */
export interface McpInvocation {
    /** principal ∧ credential — what the tool runs on. */
    ctx: RequestContext;
    /** The principal's own authority. See agent-authority.ts. */
    principal: AgentPrincipal;
    /**
     * The registered agent the credential speaks for, when it resolved to a live
     * ACTIVE one. `null` means the tenant is not enforcing the register — see
     * `agent-tool-exposure.ts` for why that is not an exposure bypass.
     */
    agentId: string | null;
    /**
     * The tools this agent is granted. `null` when there is no agent, which is
     * the only state that skips the exposure check.
     */
    grantedTools: ReadonlySet<string> | null;
    /**
     * The tool names this build put on the table WHEN THIS INVOCATION WAS
     * ASSEMBLED — the third list of `ToolManifest`, and the only one that is a
     * snapshot of the server rather than of the tenant.
     *
     * Resolution enumerates THIS, never the live registry arrays, so a tool that
     * enters the registry after assembly is not loadable by an invocation
     * already in flight. See `tool-manifest.ts` for why the property is stated
     * as "resolution enumerates the manifest" rather than as a detection of the
     * addition, and for what "mid-session" means when the session is an
     * `McpInvocation`.
     */
    offeredTools: readonly string[];
    /**
     * The RFC 8693 audience the presented token was minted for, or `null` when
     * the caller presented the long-lived API key itself.
     *
     * `null` and `[]` are DIFFERENT and must stay different. `null` is "this
     * credential carries no audience", which is the pre-exchange behaviour every
     * existing integration relies on; `[]` would be "an audience naming
     * nothing", which `mintExchangedToken` refuses to issue. Collapsing the two
     * turns the check into a formality in whichever direction you collapse them.
     */
    audience: readonly string[] | null;
    /**
     * `min(key.maxAutonomyLevel, agent.autonomyLevel, tierCap)` — the highest
     * rung this invocation may reach. See `agentic/autonomy-ceiling.ts`,
     * including why a NULL tier must deny while a NULL key ceiling must not.
     */
    autonomyCeiling: number;
    /**
     * The resolved agent's scored risk tier, or `null`.
     *
     * `null` here is NOT "unscored" on its own — it is also what a request with
     * no resolved agent carries. It exists for the DENIAL MESSAGE, which needs
     * to tell an operator whether the thing refusing them is the tier or the
     * registration, and those need different fixes.
     */
    riskTier: AgentRiskTier | null;
    /**
     * The agent's POLICY CARD, or `null` when it has none.
     *
     * `null` contributes NO term — the call is bounded exactly as 2/10 left it.
     * That is not a hole and it is not deny-by-default inverted: the tool GRANTS
     * are already deny-by-default, and a card only ever narrows them further.
     * Reading an absent card as "may do nothing" would make creating the
     * register's own governance artefact the thing that takes a working agent
     * dark — the composition failure this subsystem has now written down three
     * times.
     */
    policyCard: PolicyCardBinding | null;
    /** What must still be TRUE at every tool boundary, not merely at auth. */
    credential: {
        /** The `TenantApiKey.id` revocation is re-checked against. */
        apiKeyId: string | null;
        /** The exchanged token's expiry, re-checked against `now` per call. */
        tokenExpiresAt: Date | null;
    };
    /**
     * Injected clock. Every expiry comparison the funnel makes reads this, so a
     * test can prove an expiry without sleeping — and, more usefully, so an
     * expiry that stops being checked cannot hide behind real time passing.
     */
    now: Clock;
}

/**
 * The policy card in force for this invocation, plus the one piece of state the
 * card needs that no table holds: how many calls THIS invocation has made.
 *
 * `actionsThisRun` is MUTABLE, deliberately, and it is the only mutable field on
 * an invocation. The per-run budget bounds one execution, and one execution is
 * exactly what an `McpInvocation` is — the workflow engine resolves one per run
 * segment and drives every step on it, and `/api/mcp` resolves one per request.
 * There is nowhere else for that count to live: a database column would make it
 * a per-agent counter (which is the per-DAY budget, and already exists), and a
 * module-level map would leak between concurrent runs.
 *
 * It is seeded from the run's own step count on resume, so a run that pauses at
 * a checkpoint and comes back does not get a fresh budget for each segment.
 */
export interface PolicyCardBinding {
    inForce: PolicyCardInForce;
    /** Calls this invocation has already made. Excludes the one being gated. */
    actionsThisRun: number;
}

/** Why a tool call was refused, for the audit row an operator reads. */
export type McpDenialReason =
    | 'audience_denied'
    | 'credential_revoked'
    | 'credential_expired'
    | 'tool_not_offered'
    | 'tool_not_granted'
    | 'autonomy_denied'
    | 'policy_card_denied'
    | 'capability_denied'
    | 'scope_denied'
    | 'policy_denied';

/**
 * Write ONE hash-chained `AUTHZ_DENIED` row and throw. Best-effort audit, on the
 * same principle as `requirePermission`'s: an audit outage must never turn a
 * refusal into an admission, so the throw happens whether or not the row landed.
 */
export async function denyToolCall(
    ctx: RequestContext,
    reason: McpDenialReason,
    detail: { tool: string; agentId: string | null; message: string; extra?: Record<string, unknown> },
): Promise<never> {
    try {
        await appendAuditEntry({
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            actorType: 'API_KEY',
            entity: 'McpTool',
            entityId: detail.tool,
            action: 'AUTHZ_DENIED',
            details: `Agent tool call refused: ${reason} for ${detail.tool}`,
            detailsJson: {
                category: 'access',
                event: 'authz_denied',
                gate: 'mcp_tool_invocation',
                reason,
                tool: detail.tool,
                agentId: detail.agentId,
                apiKeyId: ctx.apiKeyId ?? null,
                role: ctx.role,
                method: MCP_SURFACE.method,
                path: MCP_SURFACE.path,
                ...(detail.extra ?? {}),
            },
            requestId: ctx.requestId,
            metadataJson: { apiKeyId: ctx.apiKeyId ?? null, reason, tool: detail.tool },
        });
    } catch (err) {
        logger.warn('audit: failed to record MCP AUTHZ_DENIED', {
            requestId: ctx.requestId,
            tenantId: ctx.tenantId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
    throw forbidden(detail.message);
}

/** The permission set a tool's keys are evaluated against. */
function permissionsFor(inv: McpInvocation, authorize: McpToolAuthorization): PermissionSet {
    return authorize.basis === 'principal' ? inv.principal.appPermissions : inv.ctx.appPermissions;
}

/**
 * Is this tool exposed to this agent? Deny-by-default when there is an agent;
 * no list to consult when there is not.
 */
export function isToolExposed(inv: McpInvocation, toolName: string): boolean {
    if (inv.grantedTools === null) return true;
    return inv.grantedTools.has(toolName);
}

/**
 * The three pinned lists this invocation's loadable set is the intersection of.
 *
 * A VIEW over fields the invocation already carries — it stores nothing and
 * derives nothing that is not already decided. The adapter lives here rather
 * than in `tool-manifest.ts` because that module must not import
 * `McpInvocation`: the manifest describes an invocation, so importing the
 * invocation back would make the two a cycle, and would also tie a
 * deliberately-leaf module to the whole authorization graph.
 */
export function toolManifestOf(inv: McpInvocation): ToolManifest {
    return {
        offered: inv.offeredTools,
        grantedTools: inv.grantedTools,
        permittedTools: inv.policyCard?.inForce.value.permittedTools ?? null,
    };
}

/**
 * May this invocation LOAD this tool — offered at assembly, granted in the
 * register, and permitted by the policy card?
 *
 * This is what `tools/list` filters on. Before it existed the catalogue applied
 * the grants and skipped the CARD, so an agent was advertised tools its own
 * declared policy forbade; every such call then 403'd and wrote an
 * `AUTHZ_DENIED` row, which is exactly the "manufacture denials until an
 * operator learns to ignore them" failure `listReadToolDescriptors`'s own
 * docstring names as the reason to filter at all.
 *
 * It is NOT a replacement for the per-call gate and must never become one. The
 * gate re-checks the grant (step 3) and the card (step 5) SEPARATELY, because
 * each refusal has to name its own rule; and it checks four more things this
 * cannot know — the data rung a call reaches depends on its arguments, and the
 * budgets depend on how many calls came before.
 */
export function isToolLoadable(inv: McpInvocation, toolName: string): boolean {
    return toolIsLoadable(toolManifestOf(inv), toolName);
}

/**
 * LOAD a tool, or refuse. The one door between a tool NAME and a tool OBJECT.
 *
 * Returns `null` when this build has no such tool at all — the caller turns that
 * into its own `MethodNotFound`, because an unknown name is a protocol error and
 * not a denied access attempt, and auditing it would let any caller fill the
 * trail with typos.
 *
 * Refuses — with one hash-chained `AUTHZ_DENIED` row — when the registry DOES
 * hold the tool but this invocation's manifest did not offer it. That is the
 * mid-session case, and the reason the check is here rather than inside
 * `authorizeToolCall` is that it is a property of LOADING, not of authority:
 * `authorizeToolCall` is handed a tool object, so a check inside it would run
 * after the object had already been taken out of the live registry. Resolving
 * through the manifest means the object is never obtained.
 *
 * It runs ahead of audience and liveness, which is a deliberate exception to
 * this file's "credential checks first" ordering: it needs no credential and no
 * query, and its refusal says something none of the others can — "the authority
 * this run holds was fixed before that tool existed; start a new run" rather
 * than "fix your configuration". The information it can leak is which tool names
 * this build shipped, to a caller whose credential was already validated at the
 * HTTP boundary before any of this ran.
 */
export async function resolveOfferedTool<T extends { name: string }>(
    inv: McpInvocation,
    registry: readonly T[],
    name: string,
): Promise<T | null> {
    const tool = registry.find((t) => t.name === name);
    if (!tool) return null;
    if (toolWasOffered(toolManifestOf(inv), name)) return tool;

    await denyToolCall(inv.ctx, 'tool_not_offered', {
        tool: name,
        agentId: inv.agentId,
        message:
            `The tool "${name}" was not offered when this session began, so it ` +
            'cannot be loaded by it. A tool that appears after a run has started ' +
            'is never callable by that run — start a new one.',
        extra: {
            // The SET, as a fingerprint, not a list: an operator comparing two
            // rows from one run needs "same or different", and an audit row is
            // not a place to accumulate payload.
            toolManifestDigest: toolManifestDigest(toolManifestOf(inv)),
            offeredAtAssembly: inv.offeredTools.length,
        },
    });
    return null;
}

/**
 * Step 1 — AUDIENCE. Was the token the caller presented minted for this target?
 *
 * `target` is a tool name, or `MCP_RESOURCES_AUDIENCE` for the resources
 * surface. A caller holding the long-lived key has `audience === null` and this
 * is a no-op — the exchange is opt-in, and a key that never went through it
 * behaves exactly as it did before token exchange existed.
 */
async function assertAudience(inv: McpInvocation, target: string): Promise<void> {
    if (inv.audience === null) return;
    if (audienceCovers(inv.audience, target)) return;
    await denyToolCall(inv.ctx, 'audience_denied', {
        tool: target,
        agentId: inv.agentId,
        // Names the audience the caller ALREADY HOLDS and the one it asked for
        // — both already known to it — and nothing else. An actionable message
        // for a misconfigured integration; no new information for a prober.
        message:
            `This token was issued for [${inv.audience.join(', ')}] and cannot be ` +
            `used for "${target}". Exchange a token naming that audience.`,
        extra: { requested: target, tokenAudience: [...inv.audience] },
    });
}

/**
 * Step 2 — LIVENESS. Re-read the credential, per tool call, uncached.
 *
 * The uncached read IS the feature. Everything else on the invocation was
 * settled when it was assembled; this is the only term whose answer can change
 * between two steps of the same run, and caching it — even for the length of one
 * execution — reintroduces exactly the window subpoint 6 exists to close.
 *
 * A key that vanished between assembly and now is treated as REVOKED rather than
 * ignored: the fail direction for "the credential I was told about is not there"
 * has to be refusal.
 */
async function assertCredentialLive(inv: McpInvocation, target: string): Promise<void> {
    const now = inv.now();

    // The exchanged token's own expiry, checked first: it needs no query, and a
    // spent token should not cost a database round trip to refuse.
    if (!isTokenLive(inv.credential.tokenExpiresAt, now)) {
        await denyToolCall(inv.ctx, 'credential_expired', {
            tool: target,
            agentId: inv.agentId,
            message: 'This MCP token has expired. Exchange a new one.',
            extra: { basis: 'exchanged_token' },
        });
    }

    const apiKeyId = inv.credential.apiKeyId;
    // A session-authenticated caller (the workflow engine started by a human)
    // has no key to revoke; its session was already checked upstream.
    if (!apiKeyId) return;

    // Uncached, per call — see `agent-credential-state.ts` for why that is the
    // feature rather than the cost.
    const failure = await checkCredentialLiveness(apiKeyId, inv.ctx.tenantId, now);
    if (failure === null) return;

    if (failure === 'expired') {
        await denyToolCall(inv.ctx, 'credential_expired', {
            tool: target,
            agentId: inv.agentId,
            message: 'The API key behind this request has expired.',
            extra: { basis: 'api_key' },
        });
        return;
    }

    await denyToolCall(inv.ctx, 'credential_revoked', {
        tool: target,
        agentId: inv.agentId,
        message:
            'The API key behind this request has been revoked. Every further ' +
            'tool call is refused, including within a run already in progress.',
        // `missing` and `revoked` are one REFUSAL and two diagnoses: an operator
        // reading the trail needs to tell "somebody revoked this" from "the row
        // is gone", which are different investigations.
        extra: { basis: failure },
    });
}

/**
 * Step 4 — AUTONOMY. Is the rung this call represents within the ceiling?
 *
 * The ceiling is `min(key.maxAutonomyLevel, agent.autonomyLevel, tierCap)`,
 * computed once per invocation — see `agentic/autonomy-ceiling.ts`. This is
 * what makes the authority a property of the AGENT: a credential can narrow it
 * and can never widen it, so "what may this agent do" stops depending on which
 * of its keys somebody is holding.
 *
 * The refusal names the term that is actually binding, because the three have
 * completely different fixes and an operator handed the wrong one edits the
 * wrong record. A ceiling of `DENY_CEILING` can only have come from the tier
 * term (the other two are bounded at 0), so an UNSCORED agent gets told to
 * assess itself rather than to raise a number that would change nothing.
 */
async function assertAutonomy(
    inv: McpInvocation,
    target: string,
    capabilityClass: McpCapabilityClass,
    declared: number | undefined,
): Promise<void> {
    const required = requiredAutonomyFor(capabilityClass, declared);
    if (withinCeiling(required, inv.autonomyCeiling)) return;

    const unscored = inv.autonomyCeiling === DENY_CEILING;
    const message = unscored
        ? 'This agent has not been risk-assessed, so it holds no authority at ' +
          'all. Complete its agent risk assessment in the register — an ' +
          'unassessed agent is refused every tool, by design.'
        : inv.riskTier !== null
          ? `This agent's autonomy ceiling does not reach the level "${target}" ` +
            `requires. Its assessed risk tier is ${inv.riskTier}, which caps it; ` +
            "the agent's registered autonomy level and the key's maximum apply " +
            'as well, and the lowest of the three wins.'
          : `This agent's autonomy ceiling does not reach the level "${target}" ` +
            "requires. Raise the agent's registered autonomy level, or the key's " +
            'maximum, whichever is lower.';

    await denyToolCall(inv.ctx, 'autonomy_denied', {
        tool: target,
        agentId: inv.agentId,
        message,
        extra: {
            required,
            ceiling: inv.autonomyCeiling,
            capabilityClass,
            riskTier: inv.riskTier,
            unscored,
        },
    });
}

/**
 * Step 5 — THE POLICY CARD. The refusal that happens BEFORE anything runs.
 *
 * Everything above this line asks whether the CALLER may reach the tool. This
 * asks whether the AGENT's own declared, versioned policy permits the call —
 * which tools, how far into tenant data, how autonomous, and how many times.
 *
 * ## Pre-execution, and why the ordering inside this function matters
 *
 * The card is evaluated here, inside the gate, so a refusal happens before
 * `tool.run` is ever entered. Detection and prevention answer the next request
 * identically — both 403 — so the property is "no side effect occurred", and it
 * is tested with a spy on the tool rather than with a status code.
 *
 * REACH IS EVALUATED BEFORE THE BUDGET IS SPENT. `evaluateCardReach` decides
 * everything that costs no write; only if it passes does `reserveDailyAction`
 * increment the day counter. A call refused for naming a tool the card does not
 * permit must not burn a unit of the day's budget on its way out, or one
 * misconfiguration exhausts the agent's day and the operator ends up reading
 * `DAILY_ACTION_CAP_EXCEEDED` while the actual fault was `TOOL_NOT_PERMITTED`.
 *
 * The reservation is an increment-and-return rather than a read-then-write, so
 * two concurrent calls can never both see the last unit of the budget.
 *
 * ## The refusal names the RULE, and the VERSION
 *
 * `reason: 'policy_card_denied'` alone would be the same defect one level down
 * as "denied" is one level up. The audit row carries `policyCardRule` (which
 * declaration refused), `policyCardVersion` (which version said so) and
 * `escalate` (whether this card asked to be woken for that rule), because those
 * are three different things an operator does next.
 *
 * ## And it is COUNTED, here, at the single emission point
 *
 * A refusal breaks nothing: no failed job, no error rate, no user-visible
 * symptom — the agent just does less. So the gate has to report itself, and this
 * function is the one place every evaluation passes through, which is why both
 * counters are emitted here rather than beside each `return`. Every path out
 * emits exactly one evaluation: the no-card early return, each refusal, and the
 * allow. `recordPolicyCardRefusal` carries the agent AND the rule, because
 * telling a misconfigured card (one agent, one rule, starting at an edit) from
 * an agent operating outside its envelope (one agent, spread across rules)
 * needs both on the same series — see the counters' own docstrings in
 * `integration-metrics.ts` for the cardinality argument and the alert shapes.
 */
async function assertWithinPolicyCard(
    inv: McpInvocation,
    target: string,
    tool: string | null,
    dataScope: AgentDataAccessScope,
    requiredAutonomy: number,
): Promise<void> {
    // `tool: null` is the RESOURCES surface — see the parameter's own docstring
    // on `PolicyCardRequest`. Named once here so both counters agree about which
    // door a call came through.
    const surface = tool === null ? 'resource' : 'tool';

    const binding = inv.policyCard;
    if (binding === null) {
        // Counted, and counted as WHICH of the two nulls this is. An agent with
        // no card is not the same as an agent whose card permits everything —
        // both produce zero refusals for ever — so `no_card` is the governance
        // gap worth reading. `no_agent` is a human, an ordinary integration key
        // or a tenant with the register off, and folding the two together would
        // make a tenant that runs no agents indistinguishable from one running
        // agents nobody has written a card for.
        recordPolicyCardEvaluation({
            outcome: inv.agentId === null ? 'no_agent' : 'no_card',
            surface,
        });
        return;
    }

    const deny = async (verdict: Exclude<ReturnType<typeof evaluateCardReach>, { allowed: true }>) => {
        recordPolicyCardEvaluation({ outcome: 'refused', surface });
        recordPolicyCardRefusal({
            // Non-null in practice: a binding exists only when the invocation
            // named an agent (`buildMcpInvocation` loads no card without one).
            // The fallback is a label, not a guess — it would show up as its own
            // series rather than silently joining another agent's.
            agentId: inv.agentId ?? 'unattributed',
            rule: verdict.rule,
            escalate: verdict.escalate,
            riskTier: inv.riskTier,
            surface,
        });
        return denyToolCall(inv.ctx, 'policy_card_denied', {
            tool: target,
            agentId: inv.agentId,
            message: verdict.message,
            extra: {
                // Per-rule detail FIRST, so the three fields an operator triages
                // on can never be shadowed by a detail key that happens to share
                // a name. None does today; the ordering is what keeps that from
                // being a fact somebody has to re-check when a rule is added.
                ...verdict.detail,
                policyCardRule: verdict.rule,
                policyCardVersion: verdict.cardVersion,
                escalate: verdict.escalate,
            },
        });
    };

    const reach = evaluateCardReach(binding.inForce, {
        tool,
        dataScope,
        requiredAutonomy,
        actionsThisRun: binding.actionsThisRun,
    });
    if (!reach.allowed) await deny(reach);

    const reserved = await reserveDailyAction(
        inv.ctx.tenantId,
        binding.inForce.cardId,
        inv.now(),
    );
    const budget = evaluateCardDailyBudget(binding.inForce, reserved);
    if (!budget.allowed) await deny(budget);

    // Counted only once the call is cleared, so a refused call does not consume
    // the run's budget either. The two budgets are spent on the same terms.
    binding.actionsThisRun += 1;
    recordPolicyCardEvaluation({ outcome: 'allowed', surface });
}

/**
 * The gate applied to the MCP RESOURCES surface.
 *
 * Resources used to be gated by `enforceApiKeyScope` alone — a throw that wrote
 * no audit row, applied no allowlist and consulted no ceiling. `/api/mcp` had
 * two doors and only one of them was fully gated. This closes the three checks
 * that DO apply cleanly to a surface with no catalogue entries of its own:
 * audience (resources have their own audience name, so a token minted for
 * `list_risks` cannot read them), liveness, and the autonomy ceiling. Every
 * refusal now writes the same one hash-chained row a tool refusal writes.
 *
 * The deny-by-default EXPOSURE allowlist is deliberately not applied here, and
 * the reason is that there is nothing to apply it to: `RegisteredAgentTool` rows
 * name tools from the grantable catalogue, resources have no entries in it, and
 * inventing a parallel grant vocabulary is a register change rather than a gate
 * change. Recorded rather than papered over — a resource read is scope-gated,
 * audience-gated, ceiling-gated and audited, but not allowlisted.
 */
export async function authorizeResourceRead(inv: McpInvocation): Promise<void> {
    await assertAudience(inv, MCP_RESOURCES_AUDIENCE);
    await assertCredentialLive(inv, MCP_RESOURCES_AUDIENCE);
    await assertAutonomy(inv, MCP_RESOURCES_AUDIENCE, 'read', undefined);
    // The policy card applies here too, minus the one rule that has nothing to
    // name: `tool: null` skips the permitted-TOOL list, for exactly the reason
    // the paragraph above gives for the exposure allowlist. The data rung, the
    // autonomy rung and BOTH budgets apply unchanged — a resource read is a
    // tenant-data read and it spends the agent's day like any other.
    await assertWithinPolicyCard(
        inv,
        MCP_RESOURCES_AUDIENCE,
        null,
        RESOURCE_READ_DATA_SCOPE,
        requiredAutonomyFor('read', undefined),
    );
}

/**
 * The gate. Throws `forbidden` — after exactly one audit row — when this
 * invocation may not call this tool.
 */
export async function authorizeToolCall(
    inv: McpInvocation,
    tool: {
        name: string;
        authorize: McpToolAuthorization;
        resourceScope: { resource: string; action: ScopeAction };
        /** Propose tools only — the MCP capability the credential must carry. */
        capability?: 'read' | 'propose' | 'orchestrate';
        /**
         * Which autonomy rung this tool's CLASS sits on. Passed by the two
         * funnels rather than derived from `capability`, which is a CREDENTIAL
         * check and is deliberately absent on read tools — deriving one from the
         * other would have made every read tool resolve to the orchestrate rung.
         */
        capabilityClass: McpCapabilityClass;
    },
    /**
     * The arguments as the caller sent them, UNVALIDATED.
     *
     * The data rung a call reaches can depend on an argument — see
     * `tool-data-scope.ts` — and the gate necessarily runs before the tool's Zod
     * schema, because nothing may run ahead of the gate. Only property PRESENCE
     * is read, and an argument rule can only RAISE the rung, so a caller cannot
     * reach a higher rung by sending something malformed.
     */
    rawArgs?: unknown,
): Promise<void> {
    // 1. Was this token minted for this tool?
    await assertAudience(inv, tool.name);

    // 2. Is the credential still live, right now?
    await assertCredentialLive(inv, tool.name);

    // 3. Deny-by-default exposure.
    if (!isToolExposed(inv, tool.name)) {
        await denyToolCall(inv.ctx, 'tool_not_granted', {
            tool: tool.name,
            agentId: inv.agentId,
            message:
                `This agent is not granted the "${tool.name}" tool. An administrator ` +
                'must grant it in the agent register before it can be called.',
        });
    }

    // 4. Is this rung within the agent's ceiling?
    await assertAutonomy(inv, tool.name, tool.capabilityClass, tool.authorize.autonomy);

    // 5. Is this call inside the agent's own versioned policy card? Evaluated
    //    HERE, before anything runs — a violation is a refusal, not a note.
    await assertWithinPolicyCard(
        inv,
        tool.name,
        tool.name,
        dataScopeForToolCall(tool.name, rawArgs),
        requiredAutonomyFor(tool.capabilityClass, tool.authorize.autonomy),
    );

    // 6. Credential capability (propose tools). Message preserved verbatim from
    //    `enforceMcpCapability` — it names a scope, not a permission key.
    if (tool.capability) {
        try {
            enforceMcpCapability(inv.ctx, tool.capability);
        } catch (err) {
            if (!isAppError(err)) throw err;
            await denyToolCall(inv.ctx, 'capability_denied', {
                tool: tool.name,
                agentId: inv.agentId,
                message: err.message,
                extra: { capability: tool.capability },
            });
        }
    }

    // 7. Credential resource scope. Same treatment: the existing message is the
    //    actionable one and is safe (it echoes scopes the caller already holds).
    try {
        enforceApiKeyScope(inv.ctx, tool.resourceScope.resource, tool.resourceScope.action);
    } catch (err) {
        if (!isAppError(err)) throw err;
        await denyToolCall(inv.ctx, 'scope_denied', {
            tool: tool.name,
            agentId: inv.agentId,
            message: err.message,
            extra: {
                resource: tool.resourceScope.resource,
                action: tool.resourceScope.action,
            },
        });
    }

    const { authorize } = tool;

    // 8. Permission keys — through the SAME `assertPermission` the human
    //    route's `requirePermission` calls. It audits its own denial and
    //    throws the generic 403, so nothing is added here.
    if (authorize.keys && authorize.keys.length > 0) {
        await assertPermission(
            { ...inv.ctx, appPermissions: permissionsFor(inv, authorize) },
            { keys: authorize.keys, mode: 'all' },
            MCP_SURFACE,
        );
    }

    // 9. The shared read/write policy, for a mirrored route that has no
    //    permission key to name. `assertCanRead` / `assertCanWrite` throw
    //    without auditing — which is precisely how an agent denial used to be
    //    invisible — so the throw is caught and turned into the one row.
    if (authorize.policy) {
        const permissions =
            authorize.basis === 'principal' ? inv.principal.permissions : inv.ctx.permissions;
        const probe: RequestContext = { ...inv.ctx, permissions };
        try {
            if (authorize.policy === 'write') assertCanWrite(probe);
            else assertCanRead(probe);
        } catch (err) {
            if (!isAppError(err)) throw err;
            await denyToolCall(inv.ctx, 'policy_denied', {
                tool: tool.name,
                agentId: inv.agentId,
                message: 'Permission denied',
                extra: { policy: authorize.policy, basis: authorize.basis },
            });
        }
    }
}

/**
 * Strip the sections of a result whose domain the acting context cannot see.
 *
 * Gating the CALL is not enough for a payload that aggregates several domains:
 * an agent whose principal cannot see risks must not receive risk counts because
 * the tool it called is nominally a controls tool. Paths are dotted and removed
 * from a structural copy; a path that does not exist is a no-op, so a payload
 * shape change degrades to "redacts nothing extra" rather than throwing.
 */
export function applyRedaction(
    inv: McpInvocation,
    rules: readonly { key: string; paths: readonly string[] }[] | undefined,
    data: unknown,
): unknown {
    if (!rules || rules.length === 0) return data;
    const perms = inv.ctx.appPermissions as unknown as Record<
        string,
        Record<string, boolean> | undefined
    >;
    const missing = rules.filter((r) => {
        const [domain, action] = r.key.split('.');
        return perms[domain]?.[action] !== true;
    });
    if (missing.length === 0) return data;

    // Structural clone via JSON: every tool result is already JSON-serialised
    // into the MCP text block one line later, so nothing survives this that
    // would have survived the wire.
    const copy = JSON.parse(JSON.stringify(data ?? null));
    for (const rule of missing) {
        for (const p of rule.paths) deletePath(copy, p);
    }
    // The marker tells the agent it is reading a PARTIAL answer. Without it a
    // redacted payload is indistinguishable from a tenant that has no risks,
    // and an agent reasoning over the difference would draw the opposite
    // conclusion from the right one.
    //
    // Only onto a plain object: spreading an array into an object literal turns
    // it into `{0: …, 1: …}` and silently breaks every consumer. No tool
    // declaring `redact` returns an array today; this is the guard against the
    // one that does.
    if (copy === null || typeof copy !== 'object' || Array.isArray(copy)) return copy;
    return { ...(copy as Record<string, unknown>), redactedDomains: missing.map((m) => m.key) };
}

/**
 * Drop rows the acting context may not see from the arrays a tool declares.
 *
 * Composed after `applyRedaction` — it takes that pass's OUTPUT and clones
 * again, rather than mutating a shared object, so a tool can declare both
 * without either pass depending on whether the other ran. A path that is not an
 * array is a no-op: a payload shape change degrades to "filters nothing extra"
 * rather than throwing mid-response.
 */
export function applyRowRedaction(
    inv: McpInvocation,
    rules: readonly { path: string; keyOf: (row: unknown) => string | null }[] | undefined,
    data: unknown,
): unknown {
    if (!rules || rules.length === 0) return data;
    const perms = inv.ctx.appPermissions as unknown as Record<
        string,
        Record<string, boolean> | undefined
    >;
    const granted = (key: string): boolean => {
        const [domain, action] = key.split('.');
        return perms[domain]?.[action] === true;
    };

    const copy = JSON.parse(JSON.stringify(data ?? null));
    for (const rule of rules) {
        const parts = rule.path.split('.');
        let parent: unknown = copy;
        for (let i = 0; i < parts.length - 1; i++) {
            if (parent === null || typeof parent !== 'object') { parent = null; break; }
            parent = (parent as Record<string, unknown>)[parts[i]];
        }
        if (parent === null || typeof parent !== 'object') continue;
        const leaf = parts[parts.length - 1];
        const arr = (parent as Record<string, unknown>)[leaf];
        if (!Array.isArray(arr)) continue;
        (parent as Record<string, unknown>)[leaf] = arr.filter((row) => {
            const key = rule.keyOf(row);
            return key === null || granted(key);
        });
    }
    return copy;
}

function deletePath(root: unknown, dotted: string): void {
    const parts = dotted.split('.');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
        if (node === null || typeof node !== 'object') return;
        node = (node as Record<string, unknown>)[parts[i]];
    }
    if (node === null || typeof node !== 'object') return;
    delete (node as Record<string, unknown>)[parts[parts.length - 1]];
}
