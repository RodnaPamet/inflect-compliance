/**
 * MCP read-tool contract.
 *
 * Every read tool is a THIN wrapper over an EXISTING read usecase — the same
 * usecase the REST API calls. A tool declares:
 *   - its MCP descriptor (name, description, JSON-schema for args);
 *   - a Zod `argsSchema` (validates/parses the agent's arguments);
 *   - a `resourceScope` — the API-key scope required IN ADDITION to the
 *     `mcp:read` capability gate (e.g. `risks:read`). A key scoped only to
 *     controls cannot call a risks tool;
 *   - an `authorize` block — the SAME authorization the equivalent HUMAN route
 *     applies, named as data rather than re-implemented as code. See
 *     `McpToolAuthorization` below;
 *   - optionally a `redact` projection — for a tool whose payload spans several
 *     domains, which sections fall away when the acting principal cannot see
 *     that domain;
 *   - `run(ctx, args)` — calls exactly one usecase with the tenant ctx. The
 *     usecase performs RLS (`runInTenantContext`) + its own permission check
 *     (`assertCanRead…`) internally, so the tool NEVER touches Prisma directly.
 *
 * All tools funnel through `runReadTool` (registry.ts), which resolves the
 * exposure allowlist, applies `authorize`, enforces the resource scope,
 * validates args, runs the usecase, applies `redact`, and audits the call. That
 * single funnel is what the `mcp-server-coverage` ratchet locks — and what makes
 * "no tool self-authorizes" checkable rather than aspirational.
 */
import type { ZodType } from 'zod';

import type { PermissionKey } from '@/lib/security/permission-key';
import type { RequestContext } from '@/app-layer/types';

/** The scope actions the api-key layer understands for a resource. */
export type ScopeAction = 'read' | 'write' | 'admin';

/**
 * Which permission set a tool's keys are evaluated against.
 *
 *   • `'effective'` — the principal's permissions INTERSECTED with the
 *     credential's scopes. Correct for every READ tool: a read credential holds
 *     the domain's read scope, so the intersection is exactly "both parties may
 *     view this domain".
 *
 *   • `'principal'` — the human's own permissions alone. Correct for a PROPOSE
 *     tool, and only because the credential scope vocabulary has no verb for
 *     proposing: a propose key carries `mcp:propose` plus a domain READ scope
 *     and deliberately NO `<domain>:write`, since propose-not-commit means the
 *     credential must be unable to write the entity directly. Evaluating
 *     `risks.create` against the intersection would deny every propose call. The
 *     credential's authority to propose is `mcp:propose` + the domain read
 *     scope, both enforced separately; the principal's is `risks.create`.
 *
 * See `src/lib/agentic/agent-authority.ts` for the two views and why they exist.
 */
export type McpAuthorizationBasis = 'effective' | 'principal';

export interface McpToolAuthorization {
    /**
     * The permission keys the equivalent human route demands. Checked through
     * `assertPermission` — the SAME function `requirePermission` calls — so
     * there is no second decision to drift.
     */
    keys?: readonly PermissionKey[];
    /**
     * The shared `assertCanRead` / `assertCanWrite` policy the equivalent human
     * route's usecase applies, for a domain `PermissionSet` has no key for.
     * Findings are the live example: the human `POST /findings` gate is
     * `assertCanWrite`, and there is no `findings.*` key to name instead.
     * Applied IN ADDITION to `keys` when both are present.
     */
    policy?: 'read' | 'write';
    basis: McpAuthorizationBasis;
    /**
     * The human route this mirrors, for the reader and for the guard's error
     * message. Where a tool has no human equivalent, say so here explicitly —
     * an empty string is not accepted.
     */
    mirrors: string;
}

/**
 * One redaction rule: when the acting context lacks `key`, the listed dotted
 * `paths` are removed from the tool's result.
 *
 * This is what makes a cross-domain read tool honest. Gating the CALL is not
 * enough for a payload that aggregates six domains — an agent whose principal
 * cannot see risks must not receive risk counts merely because the tool it
 * called is nominally a controls tool.
 */
export interface McpRedactionRule {
    key: PermissionKey;
    paths: readonly string[];
}

/**
 * A ROW-level filter: for an array inside the result, the permission key each
 * row needs to be visible. Rows whose key the acting context lacks are dropped.
 *
 * The stronger half of the same idea as `McpRedactionRule`. Deleting a whole
 * `riskBySeverity` block is enough when the block IS one domain; a recent-
 * activity feed interleaves every domain in one array, so it has to be filtered
 * per row or a risk-blind principal reads "Risk X created" out of a tool that
 * was never a risks tool.
 */
export interface McpRowRedactionRule {
    /** Dotted path to the array within the tool's result. */
    path: string;
    /**
     * The permission key this row requires, or `null` to keep it unconditionally.
     * Returning `null` for an unrecognised row is deliberate: the feed carries
     * entity kinds with no domain of their own (memberships, settings), and
     * dropping everything unrecognised would empty the feed rather than filter
     * it. Rows that DO name a governed domain must map to its key.
     */
    keyOf: (row: unknown) => PermissionKey | null;
}

export interface McpReadTool<TArgs = unknown> {
    /** MCP tool name (snake_case, stable — agents key off it). */
    name: string;
    /** Human/agent-facing description. */
    description: string;
    /** JSON Schema (draft-07 subset) for the tool arguments. */
    inputSchema: Record<string, unknown>;
    /** Zod schema mirroring `inputSchema` — the runtime validation. */
    argsSchema: ZodType<TArgs>;
    /**
     * The resource scope the caller's API key must hold (checked via
     * `enforceApiKeyScope`) IN ADDITION to `mcp:read`. Read tools always use
     * the `read` action.
     */
    resourceScope: { resource: string; action: ScopeAction };
    /** The human route's own authorization, reused rather than re-stated. */
    authorize: McpToolAuthorization;
    /** Domain sections that fall away when the principal cannot see them. */
    redact?: readonly McpRedactionRule[];
    /** Rows that fall away when the principal cannot see their domain. */
    redactRows?: readonly McpRowRedactionRule[];
    /**
     * Execute the tool. MUST call exactly one existing read usecase with `ctx`;
     * the usecase owns RLS + permission enforcement. Returns the structured
     * result the agent reasons over (serialised to a JSON text block).
     */
    run: (ctx: RequestContext, args: TArgs) => Promise<unknown>;
}
