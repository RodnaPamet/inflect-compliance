/**
 * MCP request authentication — the single entry gate for /api/mcp.
 *
 * INHERITS the existing machine-to-machine auth exactly: a Bearer TenantApiKey
 * is verified by `verifyApiKey` (the SAME function every public `/api/**` route
 * uses via `getLegacyCtx`), producing a full RLS-scoped `RequestContext`
 * (tenantId, userId = key creator, role, appPermissions derived from scopes,
 * apiKeyId, apiKeyScopes). There is NO parallel auth path — the MCP server is a
 * thin adapter over this.
 *
 * On top of key verification, MCP access requires the `mcp:read` CAPABILITY
 * scope — a key valid for the REST API cannot reach the agent surface unless it
 * was explicitly minted with `mcp:read`. Individual tools then additionally
 * enforce their RESOURCE scope (e.g. `risks:read`) + the usecase's own
 * permission check + RLS. `mcp:read` is the "may talk to MCP at all" gate;
 * resource scopes gate individual tools.
 *
 * THIRD GATE, and it asks a different question from the other two. Scope asks
 * what a credential may do; the agent-registration gate asks WHO IS ACTING. A
 * tenant with `requireRegisteredAgent` on refuses a key that does not name an
 * ACTIVE `RegisteredAgent`, however widely scoped that key is — so the register
 * is what decides which agents may run, and suspending an agent there actually
 * stops its traffic. Refusals write a hash-chained `AUTHZ_DENIED` row.
 *
 * The gate runs LAST, after key verification and the capability check, for the
 * same reason the read-tier rate limiter sits after the JWT gate: an
 * unauthenticated or unscoped caller should get the cheaper refusal, and the
 * expensive one should not be reachable by anyone holding no valid key.
 *
 * FOURTH GATE (Epic Agentic 2), and it asks the question the other three cannot:
 * WHOSE AUTHORITY IS THIS? `verifyApiKey` derives `role` and `appPermissions`
 * from the KEY'S SCOPES alone, so a key minted with `risks:write` by a READER
 * resolves to EDITOR with `risks.create` — reach its principal never had. That
 * is the confused deputy exactly as documented: ambient scope, no per-action
 * check against the requesting identity. `resolveAgentAuthority` resolves the
 * principal through the SAME `resolveTenantContext` a signed-in human goes
 * through and intersects the two, so the credential can never exceed the person
 * it speaks for. A principal that no longer resolves is a refusal, audited with
 * a reason naming the credential to rebind — see `agent-authority.ts`.
 *
 * ## TWO CREDENTIAL SHAPES REACH THIS DOOR, AND ONLY THIS DOOR
 *
 *   • `iflk_…` — the long-lived `TenantApiKey`. No audience: it may reach any
 *     tool its agent is granted, exactly as before.
 *   • `ifxt_…` — an RFC 8693 EXCHANGED token, minted at `POST /api/mcp/token`
 *     from one of those keys and scoped to a named audience (a set of tool
 *     names, or the resources surface). Short-lived, signed, and refused at
 *     anything outside its audience — see `token-exchange.ts`.
 *
 * An exchanged token is accepted HERE and nowhere else. `getTenantCtx`'s API-key
 * path recognises `iflk_` only, so an `ifxt_` presented at `/api/t/**` is a 401.
 * That is deliberate and is half of the audience property: a credential minted
 * for one MCP tool is not a credential for the REST surface either. It also
 * means the workflow engine — which enters through `resolveMcpInvocation` with a
 * ctx built by `getTenantCtx` — can never be started with an exchanged token, so
 * there is no path where orchestration launders a narrow audience into a wide
 * one.
 *
 * The exchanged token names its issuing key by ID and carries no copy of it.
 * Resolution goes through `resolveApiKeyById`, which runs the IDENTICAL
 * revocation / expiry / tenant-liveness checks `verifyApiKey` runs — the same
 * function tail, not a second implementation — so a key revoked after exchange
 * cannot be used through the token it minted.
 */
import type { NextRequest } from 'next/server';

import { extractBearerToken, resolveApiKeyById, verifyApiKey } from '@/lib/auth/api-key-auth';
import {
    assertRegisteredAgent,
    evaluateAgentRegistration,
    type AgentGateVerdict,
} from '@/lib/agentic/agent-registration-gate';
import {
    resolveAutonomyCeiling,
    riskTierCeilingFor,
} from '@/lib/agentic/autonomy-ceiling';
import {
    isExchangedToken,
    mintExchangedToken,
    verifyExchangedToken,
    MCP_RESOURCES_AUDIENCE,
    type Clock,
    type MintedToken,
    systemClock,
} from './token-exchange';
import { isKnownMcpTool, MCP_TOOL_NAMES } from './tool-catalogue';
import {
    resolveAgentAuthority,
    PrincipalUnresolvedError,
    type AgentPrincipal,
    type PrincipalDenialReason,
} from '@/lib/agentic/agent-authority';
import { listGrantedToolNames } from '@/lib/agentic/agent-tool-exposure';
import { loadPolicyCardInForce } from '@/lib/agentic/policy-card-store';
import { appendAuditEntry } from '@/lib/audit';
import { logger } from '@/lib/observability/logger';
import { unauthorized, forbidden, badRequest } from '@/lib/errors/types';
import type { RequestContext } from '@/app-layer/types';

import { denyToolCall, type McpInvocation } from './authorize';

/**
 * Enforce an MCP capability scope (`mcp:read` or `mcp:propose`). Mirrors
 * `enforceApiKeyScope`'s grant logic (`*` / `mcp:*` / `mcp:<cap>`). `mcp:read`
 * is the endpoint gate; `mcp:propose` gates the propose-not-commit write tools
 * and is strictly more privileged. Throws `forbidden` when the key lacks it.
 */
export function enforceMcpCapability(ctx: RequestContext, capability: 'read' | 'propose' | 'orchestrate'): void {
    const scopes = ctx.apiKeyScopes;
    // Session-auth (no api key) — MCP is API-key only, but be defensive.
    if (!scopes) return;
    if (scopes.includes('*') || scopes.includes('mcp:*') || scopes.includes(`mcp:${capability}`)) return;
    throw forbidden(`API key does not have the "mcp:${capability}" capability scope.`);
}

export interface McpAuthResult {
    /**
     * The EFFECTIVE context — principal ∧ credential. Every tool runs on this,
     * never on the raw key context, which is why it is the only `ctx` this
     * module returns.
     */
    ctx: RequestContext;
    /** Everything one tool call is authorized against. */
    invocation: McpInvocation;
}

const PRINCIPAL_DENIAL_MESSAGE: Record<PrincipalDenialReason, string> = {
    principal_not_a_member:
        'The user this API key was created by is no longer a member of this tenant. An agent holds its principal\'s authority and no more, so the key must be re-minted by a current member.',
    principal_deactivated:
        'The user this API key was created by has been deactivated. An agent holds its principal\'s authority and no more.',
    principal_removed:
        'The user this API key was created by has been removed from this tenant. An agent holds its principal\'s authority and no more.',
    principal_tenant_unavailable:
        'This API key\'s principal could not be resolved in this tenant.',
};

/**
 * The refusal when a credential\'s principal no longer resolves. ONE
 * hash-chained `AUTHZ_DENIED` row, best-effort, then the 403 — the same shape
 * the registration gate uses, because it is the same class of event.
 */
async function denyUnresolvedPrincipal(
    ctx: RequestContext,
    reason: PrincipalDenialReason,
    surface: { method: string; path: string },
): Promise<never> {
    try {
        await appendAuditEntry({
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            actorType: 'API_KEY',
            // The KEY, not the user — the credential is the thing an operator
            // has to act on, and the user is already in `userId`.
            entity: 'TenantApiKey',
            entityId: ctx.apiKeyId ?? 'unknown-api-key',
            action: 'AUTHZ_DENIED',
            details: `Agent principal unresolved for ${surface.method} ${surface.path}`,
            detailsJson: {
                category: 'access',
                event: 'authz_denied',
                gate: 'agent_principal',
                reason,
                apiKeyId: ctx.apiKeyId ?? null,
                agentId: ctx.agentId ?? null,
                method: surface.method,
                path: surface.path,
            },
            requestId: ctx.requestId,
            metadataJson: { apiKeyId: ctx.apiKeyId ?? null, reason },
        });
    } catch (err) {
        logger.warn('audit: failed to record agent-principal AUTHZ_DENIED', {
            requestId: ctx.requestId,
            tenantId: ctx.tenantId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
    throw forbidden(PRINCIPAL_DENIAL_MESSAGE[reason]);
}

/**
 * Authenticate an MCP HTTP request. Returns the tenant-scoped RequestContext
 * on success. Throws `unauthorized` if the Bearer key is missing/invalid,
 * `forbidden` if the key lacks an MCP capability scope, and `forbidden` again
 * (with a hash-chained `AUTHZ_DENIED` row) if the tenant requires registered
 * agents and this key does not name an ACTIVE one.
 */
export async function authenticateMcpRequest(
    req: NextRequest,
    options: { now?: Clock } = {},
): Promise<McpAuthResult> {
    const now = options.now ?? systemClock;
    const token = extractBearerToken(req.headers.get('authorization'));
    if (!token) {
        throw unauthorized('MCP requires a Bearer TenantApiKey');
    }

    const clientIp =
        req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
        req.headers.get('x-real-ip') ??
        null;

    // Two credential shapes, ONE resolution tail. An exchanged token is verified
    // (signature, server, expiry — all on the injected clock) and then resolves
    // its ISSUING KEY through the same checks a directly-presented key gets, so
    // there is no second set of liveness rules for the token path to drift from.
    let audience: readonly string[] | null = null;
    let tokenExpiresAt: Date | null = null;
    let result;
    if (isExchangedToken(token)) {
        const claims = verifyExchangedToken(token, { now });
        audience = claims.audience;
        tokenExpiresAt = claims.expiresAt;
        result = await resolveApiKeyById(claims.apiKeyId, clientIp);
        // A token whose tenant no longer matches the key's is refused rather
        // than trusted: the claim is signed, but the KEY is the authority on
        // which tenant it belongs to, and a mismatch means one of them moved.
        if (result.valid && result.ctx.tenantId !== claims.tenantId) {
            throw unauthorized('MCP token does not match its issuing credential.');
        }
    } else {
        result = await verifyApiKey(token, clientIp);
    }
    if (!result.valid) {
        throw unauthorized(`API key authentication failed: ${result.reason}`);
    }

    // Capability gate: the key must carry an MCP capability — `mcp:read`
    // (read tools) or `mcp:propose` (propose tools), or `mcp:*` / `*`. Individual
    // read tools still require `mcp:read`; propose tools require `mcp:propose`.
    const scopes = result.ctx.apiKeyScopes ?? [];
    const hasMcp = scopes.includes('*') || scopes.includes('mcp:*') || scopes.includes('mcp:read') || scopes.includes('mcp:propose');
    if (!hasMcp) {
        throw forbidden('API key does not have an MCP capability scope (mcp:read / mcp:propose).');
    }

    // Agent-registration gate. Throws (and audits) when this tenant requires
    // every agent to be in the register and this credential is not bound to an
    // ACTIVE one.
    //
    // Its return value is the LIVE ACTIVE agent, or null — a narrower thing than
    // `ctx.agentId`, and the two are used for different jobs. This value keys the
    // deny-by-default tool allowlist, which must apply only to an agent the
    // register currently vouches for. `ctx.agentId` remains the ATTRIBUTION: a
    // proposal made by an agent whose tenant does not enforce the gate is still
    // that agent's proposal, and narrowing the attribution to "only when ACTIVE"
    // would write those rows unattributed. The gate decides whether the request
    // runs and what it may reach; it does not decide who made it.
    const surface = { method: req.method, path: new URL(req.url).pathname };
    const verdict = await assertRegisteredAgent(result.ctx, surface);

    const invocation = await buildMcpInvocation(result.ctx, verdict, surface, {
        audience,
        tokenExpiresAt,
        now,
    });
    return { ctx: invocation.ctx, invocation };
}

/**
 * Assemble everything one tool call is authorized against.
 *
 * Exported because `/api/mcp` is not the only caller of the tool funnel: the
 * agentic workflow engine composes the same tools under a run model, and its
 * whole premise is that it "adds orchestration, NOT new authority". That is only
 * true while it enters through this door. `resolveMcpInvocation` below is the
 * engine's entry point.
 *
 * Throws `forbidden` — after exactly one hash-chained `AUTHZ_DENIED` row — when
 * the credential's principal no longer resolves.
 */
export interface BuildInvocationOptions {
    /**
     * The RFC 8693 audience of the presented token, or `null` for a caller
     * holding the long-lived key itself. `null` and `[]` are different — see
     * `McpInvocation.audience`.
     */
    audience?: readonly string[] | null;
    /** The exchanged token's expiry, re-checked at every tool boundary. */
    tokenExpiresAt?: Date | null;
    /** Injected clock, threaded onto the invocation for the funnel to use. */
    now?: Clock;
    /**
     * Tool calls this run has ALREADY made, for the policy card's per-run
     * budget.
     *
     * The workflow engine resolves a fresh invocation for each execution
     * SEGMENT — a run that pauses at a human checkpoint and resumes gets a
     * second one — so a counter that started at zero every time would hand a run
     * a full budget per checkpoint, and the per-run cap would bound a segment
     * rather than a run. The engine passes its resume position; a direct tool
     * call has nothing before it and correctly starts at zero.
     */
    actionsAlready?: number;
}

export async function buildMcpInvocation(
    keyCtx: RequestContext,
    verdict: AgentGateVerdict,
    surface: { method: string; path: string },
    options: BuildInvocationOptions = {},
): Promise<McpInvocation> {
    // Authority: resolve the human this credential speaks for and narrow the
    // context to what BOTH of them hold. A SESSION context has already been
    // through `resolveTenantContext` in `getTenantCtx`, so it IS its own
    // principal and re-resolving would be a second identical query — the
    // narrowing only has anything to do when a credential is involved.
    let ctx = keyCtx;
    let principal: AgentPrincipal = {
        userId: keyCtx.userId,
        role: keyCtx.role,
        appPermissions: keyCtx.appPermissions,
        permissions: keyCtx.permissions,
    };

    if (keyCtx.apiKeyId) {
        try {
            const authority = await resolveAgentAuthority(keyCtx);
            ctx = authority.ctx;
            principal = authority.principal;
        } catch (err) {
            if (err instanceof PrincipalUnresolvedError) {
                await denyUnresolvedPrincipal(keyCtx, err.reason, surface);
            }
            throw err;
        }
    }

    // Deny-by-default exposure list, read fresh per request so a revoke takes
    // effect on the next call. `null` when the caller is bound to no live ACTIVE
    // agent — a signed-in human, or a tenant that has switched the register off.
    // See `agent-tool-exposure.ts` for why that is not an exposure bypass.
    const agentId = verdict.agentId;
    const grantedTools = agentId ? await listGrantedToolNames(ctx.tenantId, agentId) : null;

    // The agent's policy card, read fresh per request for the same reason the
    // grants are: an operator who narrows a card has to see the NEXT call
    // refused, not the next deploy. `null` when there is no agent, and `null`
    // when the agent has no card — two different states with the same answer
    // here, because in both of them there is no declared policy to apply, and a
    // card that does not exist must never read as a card that forbids
    // everything.
    const inForce = agentId ? await loadPolicyCardInForce(ctx.tenantId, agentId) : null;

    // The autonomy ceiling: min(key max, agent's registered level, tier cap).
    //
    // The tier term is 3/10's, and it is the one that can DENY outright: an
    // agent that resolved but has never been scored gets `DENY_CEILING`, which
    // is below rung 0, so no tool reaches it. An agent that did NOT resolve —
    // a human, an ordinary integration key, a tenant with the register switched
    // off — contributes no term at all. Those two states are both spelled
    // `null` on the verdict and mean opposite things, so the object below is
    // built once, by name, rather than by passing `verdict.riskTier` to a
    // function that cannot tell them apart.
    const resolvedAgentTier = verdict.agentId === null ? null : { riskTier: verdict.riskTier };
    const autonomyCeiling = resolveAutonomyCeiling({
        keyMax: keyCtx.apiKeyMaxAutonomy,
        agentAutonomy: verdict.autonomyLevel,
        riskTierCeiling: riskTierCeilingFor(resolvedAgentTier),
    });

    return {
        ctx,
        principal,
        agentId,
        grantedTools,
        // The catalogue SNAPSHOT — a copy, taken now, of what this build offers.
        //
        // `MCP_TOOL_NAMES` is the leaf mirror of the two registries, pinned
        // equal to them by `tests/guards/mcp-tools-use-shared-authz.test.ts`;
        // reading it here is what keeps this module from importing the whole
        // tool graph to learn fourteen strings. The COPY is the point: from here
        // on, resolution enumerates this array and never the live registry, so a
        // tool that becomes offered after this line runs is not loadable by this
        // invocation — no detection required. See `loadable-tools.ts`.
        offeredTools: [...MCP_TOOL_NAMES],
        audience: options.audience ?? null,
        autonomyCeiling,
        policyCard: inForce
            ? { inForce, actionsThisRun: options.actionsAlready ?? 0 }
            : null,
        // Carried so a refusal can say WHY the ceiling is where it is. A
        // denial reading `ceiling: -1` with no tier beside it sends an operator
        // to the agent's autonomy level, which is not the thing refusing.
        riskTier: verdict.agentId === null ? null : verdict.riskTier,
        credential: {
            apiKeyId: keyCtx.apiKeyId ?? null,
            tokenExpiresAt: options.tokenExpiresAt ?? null,
        },
        now: options.now ?? systemClock,
    };
}

/**
 * The workflow engine's entry point into the tool funnel.
 *
 * Uses `evaluateAgentRegistration` rather than `assertRegisteredAgent`: the
 * engine's own route has already decided whether the caller may start a run, and
 * re-running the registration REFUSAL here would add a second, differently-timed
 * denial to a path that already has one. What it needs from the register is the
 * resolved agent id, so the deny-by-default tool allowlist applies to an
 * agent-driven run exactly as it does to a direct tool call — otherwise
 * orchestration would be a way around it, which is the one thing the engine
 * promises it is not.
 */
export async function resolveMcpInvocation(
    ctx: RequestContext,
    options: { now?: Clock; actionsAlready?: number } = {},
): Promise<McpInvocation> {
    const verdict = await evaluateAgentRegistration(ctx);
    return buildMcpInvocation(
        ctx,
        verdict,
        { method: 'POST', path: '/api/mcp (workflow engine)' },
        {
            // No audience: a run cannot be STARTED with an exchanged token
            // (`getTenantCtx` does not accept one), so there is never an
            // audience to carry here. Stated rather than left implicit, because
            // if that ever changes this is the line that has to change with it.
            audience: null,
            now: options.now,
            // How many steps of this run have already executed. See
            // `BuildInvocationOptions.actionsAlready`: without it the per-run
            // action budget would reset at every human checkpoint, and a run
            // with three checkpoints would get four budgets.
            actionsAlready: options.actionsAlready,
        },
    );
}

// ─── RFC 8693 token exchange ─────────────────────────────────────────

export interface McpTokenExchangeResult extends MintedToken {
    /** The agent the minted token speaks for, for the response body. */
    agentId: string | null;
}

/**
 * Exchange a long-lived `TenantApiKey` for a short-lived, audience-scoped token.
 *
 * ## What it refuses, and why each refusal is here rather than at first use
 *
 *   • A SUBJECT TOKEN THAT IS ITSELF AN EXCHANGED TOKEN. No chaining: a token
 *     minted for `list_risks` cannot be re-exchanged for `list_controls`, which
 *     would make the audience a suggestion. Refusing at exchange also means
 *     there is no code path where this function holds two tokens at once.
 *   • AN AUDIENCE NAMING SOMETHING THAT IS NOT A TOOL. Validated against the
 *     live catalogue, so a typo is a 400 at mint rather than a token that
 *     silently works for nothing.
 *   • AN AUDIENCE THE AGENT IS NOT GRANTED. Deny-by-default exposure composes
 *     with the audience rather than sitting beside it: exchange can only ever
 *     narrow what the agent may already reach, never widen it. This refusal
 *     writes the same hash-chained `AUTHZ_DENIED` row an ungranted tool CALL
 *     writes, because it is the same finding one step earlier.
 *
 * ## What it never does
 *
 * It never forwards the subject token. `mintExchangedToken` takes ids, not
 * tokens, so the long-lived credential cannot be embedded in, echoed by, or
 * carried alongside the short-lived one — that is a property of the signature,
 * not a promise in a comment.
 */
export async function exchangeMcpToken(
    subjectToken: string,
    request: { audience: readonly string[]; expiresIn?: number },
    surface: { method: string; path: string },
    options: { clientIp?: string | null; now?: Clock } = {},
): Promise<McpTokenExchangeResult> {
    const now = options.now ?? systemClock;

    if (isExchangedToken(subjectToken)) {
        throw badRequest(
            'An exchanged MCP token cannot be exchanged again. Present the ' +
                'original API key: re-exchange would let a narrow audience be ' +
                'traded for a wider one.',
        );
    }

    const result = await verifyApiKey(subjectToken, options.clientIp ?? null);
    if (!result.valid) {
        throw unauthorized(`API key authentication failed: ${result.reason}`);
    }

    // The same endpoint gate `authenticateMcpRequest` applies: a key with no MCP
    // capability has nothing to exchange FOR.
    const scopes = result.ctx.apiKeyScopes ?? [];
    const hasMcp =
        scopes.includes('*') ||
        scopes.includes('mcp:*') ||
        scopes.includes('mcp:read') ||
        scopes.includes('mcp:propose');
    if (!hasMcp) {
        throw forbidden('API key does not have an MCP capability scope (mcp:read / mcp:propose).');
    }

    // The registration gate, unchanged — and it audits its own refusal.
    const verdict = await assertRegisteredAgent(result.ctx, surface);

    // The principal must still resolve. Reusing `buildMcpInvocation` rather than
    // re-deriving means the token is minted against exactly the authority a tool
    // call would have run on, including the deny-by-default grant list.
    const invocation = await buildMcpInvocation(result.ctx, verdict, surface, { now });

    const audience = [...new Set(request.audience)];
    for (const entry of audience) {
        if (entry === MCP_RESOURCES_AUDIENCE) continue;
        if (!isKnownMcpTool(entry)) {
            throw badRequest(
                `"${entry}" is not an MCP tool. An audience names tool names, or ` +
                    `"${MCP_RESOURCES_AUDIENCE}" for the resources surface.`,
            );
        }
        if (invocation.grantedTools !== null && !invocation.grantedTools.has(entry)) {
            await denyToolCall(invocation.ctx, 'tool_not_granted', {
                tool: entry,
                agentId: invocation.agentId,
                message:
                    `This agent is not granted the "${entry}" tool, so no token can be ` +
                    'issued for it. An administrator must grant it in the agent register first.',
                extra: { stage: 'token_exchange' },
            });
        }
    }

    // `verifyApiKey` always sets this on a valid result; asserting it rather
    // than `!`-ing it means a future refactor that stops setting it fails here
    // instead of minting a token whose `kid` names nothing — a token that would
    // then fail the per-call liveness re-read as `missing` and be very hard to
    // trace back to its issuer.
    const apiKeyId = result.ctx.apiKeyId;
    if (!apiKeyId) {
        throw unauthorized('This credential cannot be exchanged for an MCP token.');
    }

    const minted = mintExchangedToken({
        tenantId: invocation.ctx.tenantId,
        apiKeyId,
        agentId: invocation.agentId,
        audience,
        ttlSeconds: request.expiresIn,
        now,
    });

    // Issuance is an authority event and is audited as one — the row names the
    // audience, so an incident review can answer "what was this token for"
    // without the token.
    await appendAuditEntry({
        tenantId: invocation.ctx.tenantId,
        userId: invocation.ctx.userId,
        actorType: 'API_KEY',
        entity: 'TenantApiKey',
        entityId: apiKeyId,
        action: 'MCP_TOKEN_EXCHANGED',
        details: `Issued an audience-scoped MCP token for [${audience.join(', ')}]`,
        detailsJson: {
            category: 'access',
            event: 'mcp_token_exchanged',
            audience,
            agentId: invocation.agentId,
            apiKeyId,
            expiresAt: minted.expiresAt.toISOString(),
        },
        requestId: invocation.ctx.requestId,
        metadataJson: { apiKeyId, audience },
    }).catch((err) => {
        logger.warn('audit: failed to record MCP token exchange', {
            requestId: invocation.ctx.requestId,
            tenantId: invocation.ctx.tenantId,
            error: err instanceof Error ? err.message : String(err),
        });
    });

    return { ...minted, agentId: invocation.agentId };
}
