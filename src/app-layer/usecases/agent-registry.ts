/**
 * Agent register — usecase.
 *
 * This is the STAGE-1 write seam: enough of a usecase layer to make the model
 * real (sanitisation before encryption, an audited create, a tenant-bound
 * conditional update, the kill switch) and to give the two-tenant isolation
 * suite real callers to drive. The HTTP surface, the risk scorer and the
 * per-agent coverage query land on top of this — they extend it, they do not
 * replace it.
 *
 * Two invariants worth stating here, because both are enforced in more than one
 * place on purpose:
 *
 *  • `description` is sanitised at THIS seam, not at each renderer. The column
 *    is encrypted at rest (Epic B manifest), and encryption protects
 *    confidentiality — it does nothing for the PDF export, the register export
 *    or an SDK consumer that decrypts the row and renders it verbatim.
 *  • A `riskTier` of NULL means UNSCORED, and every consumer must read UNSCORED
 *    as "deny". An agent nobody has assessed is exactly the one that should not
 *    be running, so `createRegisteredAgent` deliberately leaves the tier NULL
 *    and the status DRAFT rather than seeding a plausible-looking low tier.
 *  • THE SCORED TIER CAPS AUTONOMY, AND THE CAP IS ENFORCED HERE AS WELL AS AT
 *    THE TOOL BOUNDARY. `updateRegisteredAgent` refuses to RAISE an agent's
 *    registered autonomy above what its tier permits, and
 *    `activateRegisteredAgent` refuses an agent nobody has scored. Neither is
 *    the primary control — `resolveAutonomyCeiling` is, on every single tool
 *    call — but a register that records authority an agent provably cannot
 *    exercise is a register that lies to the person reading it, and the two
 *    refusals are the ones that put the fix in front of an operator at the
 *    moment they are asking for the thing.
 */
import { AgentDataAccessScope, AgentStatus, SuggestionItemStatus } from '@prisma/client';

import { assertCanRead, assertCanWrite } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';
import type { PrismaTx } from '@/lib/db-context';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { logEvent } from '../events/audit';
import {
    AGENT_TIER_FILTER_VALUES,
    RegisteredAgentRepository,
    type AgentKpiCounts,
    type AgentListFilters,
    type AgentTierFilterValue,
} from '../repositories/RegisteredAgentRepository';
import { reassessAgentAfterChangeInTx } from './agent-risk-assessment';
import { ceilingForRiskTier, DENY_CEILING } from '@/lib/agentic/autonomy-ceiling';
import { isAgentRegistrationEnforced } from '@/lib/agentic/agent-registration-gate';
import { KILL_SWITCH_DRILL_AGENT_ID } from '@/lib/agentic/kill-switch';
import { listKillSwitches } from './agent-kill-switch';
import { authorAiSystemEntry } from './ai-system';
import { assertOwnerInTenant } from './vendor-link-targets';
import {
    CreateRegisteredAgentSchema,
    isUnattributedThirdParty,
    RegisterAgentSchema,
    THIRD_PARTY_VENDOR_MESSAGE,
    UpdateRegisteredAgentSchema,
} from '../schemas/agent-registry.schemas';
import type { RequestContext } from '../types';

/**
 * Three-state preserving sanitiser: `undefined` means "leave the column alone",
 * `null` means "clear it", a string means "replace it". Collapsing the first two
 * is how a partial update silently wipes a field it never mentioned.
 */
function sanitizeOptional(value: string | null | undefined): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    return sanitizePlainText(value);
}

/**
 * The declared model reference, as it goes to the column.
 *
 * Sanitised because it is operator free text that the register export and the
 * assessment surface both render, and folded to `null` when it is empty:
 * "declared as nothing" and "never declared" are one fact, and the staleness
 * comparison normalises the same way, so a save of `''` over a NULL column must
 * not read back as a model change.
 */
function normalizeModelRef(value: string | null | undefined): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const clean = sanitizePlainText(value).trim();
    return clean === '' ? null : clean;
}

/**
 * Resolve the accountable owner.
 *
 * `User` is a GLOBAL table, so the FK on `RegisteredAgent.ownerUserId` is
 * satisfied by ANY user id in the system — including one belonging to another
 * tenant. The row is then stamped with `ctx.tenantId` and reads as entirely
 * legitimate: the agent has an owner who is not a member, cannot see it, and
 * will never act on it, while the register reports it as owned. That matters
 * more here than on an ordinary record, because this column is what the
 * downstream two-person rule compares against.
 *
 * Reuses the shared `assertOwnerInTenant` rather than growing a fourth copy of
 * the same `TenantMembership` lookup — it already refuses a merely-present
 * membership, requiring ACTIVE.
 */
async function assertAgentOwner(db: PrismaTx, ctx: RequestContext, ownerUserId: string) {
    await assertOwnerInTenant(db, ctx, ownerUserId);
}

/**
 * Resolve the supplier of a THIRD_PARTY agent.
 *
 * `RegisteredAgent.vendorId` is a PLAIN FK to `Vendor.id`, not the composite
 * `(id, tenantId)` shape the AI-system link uses — and Postgres runs FK checks
 * as the table owner, so RLS does not stop a row from naming another tenant's
 * vendor. Without this, "which supplier is accountable for this agent" could
 * resolve to a company the tenant has never heard of, and the read that would
 * expose it is hidden by the same RLS that failed to prevent it.
 */
async function assertVendorInTenant(db: PrismaTx, ctx: RequestContext, vendorId: string) {
    const vendor = await db.vendor.findFirst({
        where: { id: vendorId, tenantId: ctx.tenantId },
        select: { id: true },
    });
    // Same shape whether the vendor is absent or foreign, so a caller learns
    // nothing about another tenant's id space.
    if (!vendor) throw badRequest('The selected vendor does not exist in this tenant');
}

/**
 * The register's READ GATE — `admin.agent_registry`, not `assertCanRead`.
 *
 * ## Why the read is gated on the register key
 *
 * Until #2433 this read asserted only `assertCanRead`, which every role in the
 * tenant holds, and `admin.agent_registry` gated the ADD button alone. So the
 * key whose docstring says it decides "which autonomous agents may act inside
 * the tenant at all" governed a button, while the record of what is running —
 * every agent's name, its owner, how far into the data it reaches, how hard its
 * actions are to undo, its AI-Act classification and how many live credentials
 * are bound to it — was readable by anybody who could read anything.
 *
 * That was survivable while the page was a `/admin` leaf behind an ancestor
 * `admin.view` layout guard: the layout refused everyone the gate here let
 * through, so the weak assertion never decided anything. Moving the register
 * out to `/agents` removes that layout, which is exactly when the real gate has
 * to be the usecase's own. A move that silently widens a read is the worst kind
 * of routing change.
 *
 * ## Why it is not `assertCanAdmin`
 *
 * `admin.agent_registry` is delegable through a custom role and `admin.view` is
 * not. A tenant that has handed the agent register to an AI-governance owner
 * who is not a workspace admin must keep it; requiring the broader key would
 * take the register away from the person accountable for it.
 *
 * `assertCanRead` stays as the FIRST assertion, not as the only one. It is the
 * context-level "may this principal read anything here at all" check every
 * other list usecase makes, and dropping it would let a context with no read
 * permission but a stray permission bag through.
 */
function assertCanReadAgentRegister(ctx: RequestContext) {
    assertCanRead(ctx);
    if (!ctx.appPermissions?.admin?.agent_registry) {
        throw forbidden(
            'You do not have permission to view the agent register. It records which ' +
                'autonomous agents may act in this workspace.',
        );
    }
}

/**
 * Parse the register's filter query string into the repository's filter shape.
 *
 * Lives HERE rather than in the page so the page and the (unchanged) HTTP route
 * cannot disagree about what `?status=ACTIVE,SUSPENDED` means, and so an
 * unknown member is refused with a 400 by `parseEnumListFilter`'s own message
 * instead of reaching Prisma. Values are comma-joined, matching what
 * `FilterProvider`'s URL sync writes.
 */
export function parseAgentListFilters(
    raw: Record<string, string | string[] | undefined>,
): AgentListFilters {
    const members = (key: string): string[] => {
        const v = raw[key];
        const flat = Array.isArray(v) ? v.join(',') : v;
        if (!flat) return [];
        return flat
            .split(',')
            .map((m) => m.trim())
            .filter((m) => m !== '');
    };

    const pick = <T extends string>(key: string, allowed: readonly string[], label: string): T[] => {
        const got = members(key);
        for (const m of got) {
            if (!allowed.includes(m)) {
                throw badRequest(
                    `Invalid ${label} "${m}". Must be one of: ${allowed.join(', ')}.`,
                );
            }
        }
        return got as T[];
    };

    const filters: AgentListFilters = {};
    const status = pick<AgentStatus>('status', Object.values(AgentStatus), 'agent status');
    if (status.length > 0) filters.status = status;
    const scope = pick<AgentDataAccessScope>(
        'dataAccessScope',
        Object.values(AgentDataAccessScope),
        'agent data access scope',
    );
    if (scope.length > 0) filters.dataAccessScope = scope;
    const tier = pick<AgentTierFilterValue>(
        'riskTier',
        AGENT_TIER_FILTER_VALUES,
        'agent authority tier',
    );
    if (tier.length > 0) filters.riskTier = tier;
    return filters;
}

export async function listRegisteredAgents(
    ctx: RequestContext,
    options: { take?: number; status?: string; filters?: AgentListFilters } = {},
) {
    assertCanReadAgentRegister(ctx);
    return runInTenantContext(ctx, (db) => RegisteredAgentRepository.list(db, ctx, options));
}

/**
 * The four register KPI numbers, from the database.
 *
 * Same gate as the list, and that is load-bearing rather than tidy: these four
 * counts are tenant-wide aggregates over the register, so a caller who may not
 * read the register may not count it either. "47 agents, 12 unscored" is the
 * shape of the answer somebody was refused.
 */
export async function listAgentKpiCounts(
    ctx: RequestContext,
    filters: AgentListFilters = {},
): Promise<AgentKpiCounts> {
    assertCanReadAgentRegister(ctx);
    return runInTenantContext(ctx, (db) =>
        RegisteredAgentRepository.kpiCounts(db, ctx, filters),
    );
}

/**
 * Is the register load-bearing in this tenant, and if so, is anything about to
 * be refused by it?
 *
 * THREE STATES, and the middle one is the reason this exists (#2431):
 *
 *   • NOT ENFORCING — `requireRegisteredAgent` is off. Every row in the
 *     register is a record and nothing else: a SUSPENDED agent is suspended in
 *     the register and still reaches `/api/mcp`. A page that showed the rows
 *     without saying this is a page whose central claim ("an agent must be
 *     ACTIVE here before a credential bound to it may act") is false.
 *
 *   • ENFORCING WITH N UNBOUND CREDENTIALS — the gate is on AND there are live
 *     MCP credentials that name no agent. Each one is refused at
 *     `/api/mcp` with `no_agent_binding`. This is the state an operator needs
 *     warned about, because it presents as an integration that has stopped
 *     working for no visible reason, and the fix is on this page.
 *
 *   • ENFORCING — on, with nothing unbound.
 *
 * The count is of LIVE credentials only (not revoked, not expired), because a
 * revoked key being refused is the system working. `checkCredentialLiveness`
 * is the definition the boundary re-asks once per tool call; this restates its
 * two clauses, and the same warning that sits on `RegisteredAgentRepository`'s
 * live-key count applies — a column added there must be added here.
 *
 * "MCP credential" is the capability scope the endpoint gate reads
 * (`mcp:read` / `mcp:propose` / `mcp:*` / `*`), not every API key in the
 * tenant: an ordinary integration key that cannot talk to `/api/mcp` at all is
 * not something the agent register is about to refuse, and counting it would
 * put a warning in front of an operator with no action behind it.
 */
export async function getAgentGovernanceStatus(ctx: RequestContext): Promise<{
    enforcing: boolean;
    unboundCredentials: number;
}> {
    assertCanReadAgentRegister(ctx);
    const now = new Date();
    const [enforcing, unboundCredentials] = await Promise.all([
        isAgentRegistrationEnforced(ctx.tenantId),
        runInTenantContext(ctx, async (db) => {
            const rows = await db.tenantApiKey.findMany({
                where: {
                    tenantId: ctx.tenantId,
                    agentId: null,
                    revokedAt: null,
                    // NULL expiry is "no expiry", not "expired at the epoch" —
                    // Prisma drops the row from a bare `gt`.
                    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
                },
                // The scope test cannot be expressed as a Prisma filter: the
                // column is a Json array. Bounded read, scopes only.
                select: { scopes: true },
                take: 500,
            });
            return rows.filter((r) => hasMcpCapability(r.scopes)).length;
        }),
    ]);
    return { enforcing, unboundCredentials };
}

/**
 * THE DASHBOARD'S AGENTIC SUMMARY (#2440).
 *
 * Four facts, chosen because each is an incident-shaped answer that was
 * previously visible on exactly one page nobody was looking at:
 *
 *   • `tenantKillInForce` / `agentsKilled` — A KILL SWITCH IN FORCE. This was
 *     the real gap. A kill switch is the loudest state the agentic subsystem
 *     has: it stops runs already in flight at the tool boundary, and engaging
 *     it does NOT change `RegisteredAgent.status`, so the register still reads
 *     ACTIVE. Until this existed, the only surface that said so was the header
 *     of THAT agent's detail page — you had to already know which agent, and
 *     then go and look. A tenant-wide kill was invisible from anywhere except
 *     an arbitrary agent's page.
 *   • `activeUnscored` — an ACTIVE agent with no scored tier. Its credential
 *     resolves to `DENY_CEILING`, so it reaches nothing while the register
 *     advertises it as running.
 *   • `enforcing` — whether any of the above decides anything.
 *   • `proposalsAwaitingReview` — a queue with a human at the end of it.
 *
 * The DRILL CANARY is filtered out, for the reason the detail page's own
 * filter records: the nightly drill engages and lifts a kill against an id
 * that resolves to no registered agent, so an unfiltered count reports one per
 * tenant per day and a dashboard card would permanently read "1 agent
 * stopped". The constant is imported from the kill-switch module rather than
 * re-spelled — a second copy of that id is a second thing to keep in step.
 */
export async function getAgenticDashboardSummary(ctx: RequestContext): Promise<{
    enforcing: boolean;
    tenantKillInForce: boolean;
    agentsKilled: number;
    activeUnscored: number;
    proposalsAwaitingReview: number;
}> {
    assertCanReadAgentRegister(ctx);
    const [enforcing, kills, counts] = await Promise.all([
        isAgentRegistrationEnforced(ctx.tenantId),
        listKillSwitches(ctx, { inForceOnly: true, take: 200 }),
        runInTenantContext(ctx, async (db) => {
            const [activeUnscored, proposalsAwaitingReview] = await Promise.all([
                db.registeredAgent.count({
                    where: {
                        tenantId: ctx.tenantId,
                        deletedAt: null,
                        status: AgentStatus.ACTIVE,
                        riskTier: null,
                    },
                }),
                db.agentProposal.count({
                    where: { tenantId: ctx.tenantId, status: SuggestionItemStatus.PENDING },
                }),
            ]);
            return { activeUnscored, proposalsAwaitingReview };
        }),
    ]);

    const real = kills.inForce.filter((k) => k.agentId !== KILL_SWITCH_DRILL_AGENT_ID);
    return {
        enforcing,
        // `agentId === null` IS the tenant arm — `killScopeOf` says so. Widest
        // scope wins at the boundary, so a tenant-wide kill is reported as
        // such rather than folded into a count of agents: telling an operator
        // "3 agents stopped" when the answer is "every agent is stopped" would
        // send them to lift three rows and leave the one that matters.
        tenantKillInForce: real.some((k) => k.agentId === null),
        agentsKilled: new Set(real.filter((k) => k.agentId !== null).map((k) => k.agentId))
            .size,
        ...counts,
    };
}

/**
 * The endpoint gate's own capability test, restated over a stored `scopes`
 * column. Mirrors `src/lib/mcp/auth.ts`: `*`, `mcp:*`, `mcp:read` or
 * `mcp:propose`. Kept beside its only caller rather than imported, because the
 * MCP auth module reaches request-scoped machinery this read has no business in.
 */
function hasMcpCapability(scopes: unknown): boolean {
    if (!Array.isArray(scopes)) return false;
    return scopes.some(
        (s) => s === '*' || s === 'mcp:*' || s === 'mcp:read' || s === 'mcp:propose',
    );
}

/**
 * One agent, plus the tenant-wide fact that decides what its status MEANS.
 *
 * `registrationEnforced` is not a property of the agent and is returned with it
 * anyway, because every sentence a surface can write about a suspended agent is
 * conditional on it: `evaluateAgentRegistration` refuses a non-ACTIVE agent only
 * when `requireRegisteredAgent` is on, so in a tenant that has switched the
 * register off, suspending records the state and stops nothing. Without this the
 * detail page could only hedge — "if this workspace requires registered agents,
 * …" on every claim — and a hedge is what an operator reads during an incident.
 *
 * It cannot be fetched by the client instead: `GET /admin/security-settings` is
 * gated on `admin.manage`, while this page only guarantees
 * `admin.agent_registry`, so the fetch would 403 for exactly the operators who
 * live on this tab.
 *
 * Read through the module-level `prisma` rather than the tenant-bound `db`, and
 * OUTSIDE the tenant transaction — the same way `agent-coverage` reads it for
 * the ASI02 applicability gate. It is one tenant-wide boolean keyed by
 * `ctx.tenantId`, not a row this agent's read is entitled to and another's is
 * not, so joining the same fan-out is what it costs.
 */
export async function getRegisteredAgent(ctx: RequestContext, id: string) {
    assertCanRead(ctx);
    const [agent, registrationEnforced] = await Promise.all([
        runInTenantContext(ctx, (db) => RegisteredAgentRepository.getById(db, ctx, id)),
        isAgentRegistrationEnforced(ctx.tenantId),
    ]);
    // AFTER the pair resolves, not before the flag read is started: a 404 pays
    // for one extra settings lookup, and the alternative — awaiting the agent
    // first — makes every successful read a second round trip.
    if (!agent) throw notFound('Registered agent not found');
    return { ...agent, registrationEnforced };
}

export async function createRegisteredAgent(ctx: RequestContext, input: unknown) {
    assertCanWrite(ctx);
    const parsed = CreateRegisteredAgentSchema.parse(input);

    return runInTenantContext(ctx, async (db) => {
        await assertAgentOwner(db, ctx, parsed.ownerUserId);
        if (parsed.vendorId) await assertVendorInTenant(db, ctx, parsed.vendorId);

        const created = await RegisteredAgentRepository.create(db, ctx, {
            aiSystemId: parsed.aiSystemId,
            name: parsed.name,
            description: parsed.description ? sanitizePlainText(parsed.description) : null,
            autonomyLevel: parsed.autonomyLevel,
            dataAccessScope: parsed.dataAccessScope,
            reversibility: parsed.reversibility,
            provenance: parsed.provenance,
            modelRef: normalizeModelRef(parsed.modelRef) ?? null,
            ownerUserId: parsed.ownerUserId,
            vendorId: parsed.vendorId ?? null,
        });

        await logEvent(db, ctx, {
            action: 'AGENT_REGISTERED',
            entityType: 'RegisteredAgent',
            entityId: created.id,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'RegisteredAgent',
                operation: 'create',
                summary: `Registered agent "${parsed.name}" — autonomy ${parsed.autonomyLevel}, ${parsed.dataAccessScope}, ${parsed.reversibility}`,
                after: {
                    autonomyLevel: parsed.autonomyLevel,
                    dataAccessScope: parsed.dataAccessScope,
                    reversibility: parsed.reversibility,
                    provenance: parsed.provenance,
                    status: created.status,
                    // Recorded explicitly so the trail shows the agent arrived
                    // UNSCORED rather than leaving the reader to infer it.
                    riskTier: created.riskTier,
                },
            },
        });

        return created;
    });
}

/**
 * Refuse a RAISE of the registered autonomy level beyond what the assessed tier
 * permits.
 *
 * ## Why a RAISE and not the resulting VALUE
 *
 * An agent declared at rung 6 and later scored HIGH (cap 2) is an ordinary,
 * expected state: registration is a declaration, scoring is a judgement about
 * it, and the judgement is allowed to disagree. Requiring every update to land
 * at or below the cap would then refuse an operator LOWERING 6 → 4, which is a
 * move toward the cap — the check would be fighting the person fixing the
 * thing. So the rule is one-directional, exactly as the staleness triggers are:
 * moving toward more authority is checked, moving away from it never is.
 *
 * ## Why an UNSCORED agent cannot be raised at all
 *
 * `ceilingForRiskTier(null)` is `DENY_CEILING`, which is below rung 0, so every
 * raise fails the comparison. That is the intended reading and not an accident
 * of the arithmetic: an agent nobody has assessed has no established authority
 * for a raise to be relative to. The refusal names the assessment as the fix,
 * because raising a number that the tool boundary is already ignoring would
 * leave the operator convinced they had changed something.
 */
function assertRaiseWithinTier(
    current: { autonomyLevel: number; riskTier: Parameters<typeof ceilingForRiskTier>[0] },
    next: number,
): void {
    if (next <= current.autonomyLevel) return; // lowering, or no change

    const cap = ceilingForRiskTier(current.riskTier);
    if (next <= cap) return;

    if (cap === DENY_CEILING) {
        throw badRequest(
            `This agent has not been risk-assessed, so its autonomy cannot be raised ` +
                `from ${current.autonomyLevel} to ${next}. Complete its agent risk ` +
                `assessment first — the assessed tier is what decides how far it may go.`,
        );
    }
    throw badRequest(
        `Autonomy ${next} is above what this agent's assessed risk tier ` +
            `(${current.riskTier}) permits, which is ${cap}. Lower the request, or ` +
            `re-assess the agent — reducing its data access or making its actions ` +
            `reversible is what lowers the tier, and the tier is what lifts the cap.`,
    );
}

export async function updateRegisteredAgent(ctx: RequestContext, id: string, input: unknown) {
    assertCanWrite(ctx);
    const parsed = UpdateRegisteredAgentSchema.parse(input);

    return runInTenantContext(ctx, async (db) => {
        // Both checks apply to an UPDATE as much as a create — reassigning
        // ownership to a non-member is the same hole arrived at later.
        if (parsed.ownerUserId !== undefined) await assertAgentOwner(db, ctx, parsed.ownerUserId);
        if (parsed.vendorId) await assertVendorInTenant(db, ctx, parsed.vendorId);

        // The supplier attribution is a MERGED-ROW rule, and the schema can only
        // see a PAYLOAD.
        //
        // `UpdateRegisteredAgentSchema`'s refinement asks "does what the caller
        // sent describe an unattributed third party". `{ vendorId: null }` names
        // no provenance, so the answer is no — and the row it lands on can be
        // THIRD_PARTY. The DB's CHECK constraint asks the other question, about
        // the row that results, and it was the ONLY thing asking it: an edit
        // that stripped the supplier off a third-party agent passed validation
        // and surfaced as a raw constraint violation, which is a 500 where the
        // create path gives a 400 naming the field.
        //
        // So the same predicate is applied here to the merge, inside the
        // transaction the write lands in, and the DDL goes back to being the
        // backstop it was meant to be rather than the enforcement.
        const touchesAttribution =
            parsed.provenance !== undefined || parsed.vendorId !== undefined;

        // Read the live row BEFORE the write, in the same transaction, so the
        // tier the cap is computed from — and the attribution the merge is
        // computed against — is the one the update lands against.
        if (parsed.autonomyLevel !== undefined || touchesAttribution) {
            const current = await RegisteredAgentRepository.getScoringState(db, ctx, id);
            if (!current) throw notFound('Registered agent not found');
            if (parsed.autonomyLevel !== undefined) {
                assertRaiseWithinTier(current, parsed.autonomyLevel);
            }
            if (
                touchesAttribution &&
                isUnattributedThirdParty({
                    provenance: parsed.provenance ?? current.provenance,
                    // `undefined` is "not in the payload"; an explicit `null` is
                    // "clear it". Those are different edits and the merge has to
                    // keep them apart, which `??` would not.
                    vendorId:
                        parsed.vendorId !== undefined ? parsed.vendorId : current.vendorId,
                })
            ) {
                throw badRequest(THIRD_PARTY_VENDOR_MESSAGE);
            }
        }

        const count = await RegisteredAgentRepository.update(db, ctx, id, {
            ...(parsed.name !== undefined ? { name: parsed.name } : {}),
            ...(parsed.description !== undefined
                ? { description: sanitizeOptional(parsed.description) ?? null }
                : {}),
            ...(parsed.autonomyLevel !== undefined ? { autonomyLevel: parsed.autonomyLevel } : {}),
            ...(parsed.dataAccessScope !== undefined
                ? { dataAccessScope: parsed.dataAccessScope }
                : {}),
            ...(parsed.reversibility !== undefined ? { reversibility: parsed.reversibility } : {}),
            ...(parsed.provenance !== undefined ? { provenance: parsed.provenance } : {}),
            ...(parsed.modelRef !== undefined
                ? { modelRef: normalizeModelRef(parsed.modelRef) ?? null }
                : {}),
            ...(parsed.ownerUserId !== undefined ? { ownerUserId: parsed.ownerUserId } : {}),
            ...(parsed.vendorId !== undefined ? { vendorId: parsed.vendorId ?? null } : {}),
        });
        // Zero rows means the id was not this tenant's (or is soft-deleted).
        // Reported as notFound, never as a silent success.
        if (count === 0) throw notFound('Registered agent not found');

        await logEvent(db, ctx, {
            action: 'AGENT_UPDATED',
            entityType: 'RegisteredAgent',
            entityId: id,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'RegisteredAgent',
                operation: 'update',
                summary: `Updated registered agent ${id}`,
                changedFields: Object.keys(parsed),
            },
        });

        // An amendment can move a scorer input, so the standing assessment is
        // reconciled HERE rather than by a nightly sweep — and reconciling
        // means two things, not one:
        //
        //   • the tier is RE-SCORED from the answers already on file, so a
        //     widening of any axis the scorer reads narrows the ceiling in the
        //     SAME transaction that recorded it. Without this an agent could
        //     move READ_TENANT_DATA → EXTERNAL_EGRESS, keep a LOW tier and the
        //     full ladder, and be running at an authority a fresh score of the
        //     very same agent would have refused;
        //   • the run is stamped STALE, which now means only "the questionnaire
        //     answers may be out of date" — a genuine warning rather than a
        //     euphemism for "the tier is wrong".
        //
        // Same transaction on both counts: a sweep leaves a window in which the
        // register says an assessment is current when it is not, and opening a
        // second transaction from inside this one would hold two connections
        // against a transaction-mode pooler.
        const staleness = await reassessAgentAfterChangeInTx(db, ctx, id);

        return { id, updated: true, staleness };
    });
}

/**
 * Retire an agent — and REFUSE while it has proposals awaiting a human.
 *
 * ## The choice, and why refusing beats cascading
 *
 * A PENDING `AgentProposal` is not a record of something that happened; it is a
 * request that, when a human approves it, runs the REAL create-usecase. So an
 * agent with a pending queue still has reach into the tenant's data — its
 * authority outlives the click that retired it. Two ways to close that:
 *
 *   • CASCADE — reject every pending proposal as a side effect of retirement.
 *     Rejected. It is a bulk mutation of a HUMAN REVIEW QUEUE performed by a
 *     lifecycle action, and the reviewer who was mid-decision on one of those
 *     proposals is never told. "I retired an agent and my review queue emptied"
 *     is a worse surprise than any error message.
 *
 *   • REFUSE — say what is in the way and let the operator clear it. Chosen.
 *
 * The refusal is only tolerable because there is an immediate answer to the
 * emergency it might otherwise block: SUSPEND. `suspendRegisteredAgent` is the
 * kill switch, it takes effect at the MCP gate on the next request, it is
 * reversible, and it has no precondition at all. So the pairing is: SUSPEND
 * stops an agent NOW, RETIRE closes its file once its queue is settled. An
 * operator who has to make it stop is never blocked by this refusal — they are
 * one route away from the control that actually stops it, which is the one they
 * wanted.
 *
 * "Open" means `PENDING` only. ACCEPTED / REJECTED / EDITED are decided; they
 * are history, and history is exactly what the register must keep.
 */
export async function retireRegisteredAgent(ctx: RequestContext, id: string) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const openProposals = await db.agentProposal.count({
            where: { tenantId: ctx.tenantId, agentId: id, status: 'PENDING' },
        });
        if (openProposals > 0) {
            throw conflict(
                `This agent has ${openProposals} proposal(s) still awaiting review. ` +
                    'Approve or reject them first, or suspend the agent — suspension ' +
                    'stops it immediately and is reversible.',
            );
        }
        return applyRegisteredAgentStatus(db, ctx, id, 'RETIRED', 'AGENT_RETIRED');
    });
}

/**
 * The kill switch. Reversible, unlike retirement, and — deliberately — carrying
 * no precondition whatsoever: this is the control an operator reaches for when
 * an agent is doing something it should not be, and a check that could refuse it
 * would be a check that refuses the emergency stop.
 */
export async function suspendRegisteredAgent(ctx: RequestContext, id: string) {
    return setRegisteredAgentStatus(ctx, id, 'SUSPENDED', 'AGENT_SUSPENDED');
}

/**
 * Move an agent into service — and REFUSE while nobody has risk-assessed it.
 *
 * This is the moment the MCP gate begins letting its credentials through, so it
 * is a deliberate human act and never a side effect of registration —
 * `createRegisteredAgent` and `registerAgent` both land DRAFT.
 *
 * ## Why the score is required HERE and not at registration
 *
 * Registration deliberately leaves the tier NULL: an agent arrives unassessed,
 * and a tier invented at insert time would be a judgement nobody made. But
 * activation is the act that makes the agent's credentials LIVE, and an agent
 * nobody has assessed becoming live is the state this whole subsystem exists to
 * prevent. Putting the requirement at the transition rather than at the insert
 * keeps both true: an operator can register, describe, own and prepare an agent
 * without being interrogated, and cannot switch it on without an assessment.
 *
 * ## What this buys over the tool-boundary deny
 *
 * `riskTierCeilingFor` already refuses an unscored agent every tool. That
 * refusal is correct and is the enforcement; it is also invisible until
 * somebody's integration starts failing. This one arrives at the moment the
 * operator is asking for the thing, names the fix, and means the ACTIVE state
 * in the register stops containing agents that provably cannot act.
 *
 * SUSPEND and RETIRE carry no such precondition, and must not: taking authority
 * away is never the move to refuse.
 */
export async function activateRegisteredAgent(ctx: RequestContext, id: string) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        const agent = await RegisteredAgentRepository.getScoringState(db, ctx, id);
        if (!agent) throw notFound('Registered agent not found');
        if (agent.riskTier === null) {
            throw conflict(
                'This agent has not been risk-assessed. Complete its agent risk ' +
                    'assessment before activating it — an unassessed agent is refused ' +
                    'every tool at the boundary anyway, so activating it would put a ' +
                    'row in the register that cannot act.',
            );
        }
        return applyRegisteredAgentStatus(db, ctx, id, 'ACTIVE', 'AGENT_ACTIVATED');
    });
}

/**
 * Register an agent AND the EU AI Act entry that covers it, in ONE transaction.
 *
 * The register entry is AUTHORED, not fabricated: `authorAiSystemEntry` runs the
 * deterministic classifier from `@/lib/eu-ai-act/classification` over the
 * operator's Art 5 / Annex III / Art 50 answers and links the obligations that
 * tier pulls in. The tier is never accepted from the client — `RegisterAgentSchema`
 * has no field for it.
 *
 * One transaction because the link is NOT NULL in both directions of meaning: an
 * AI-system row with no agent is a register entry for a thing that does not
 * exist, and an agent with no entry cannot be created at all. Splitting them
 * would make the first failure mode reachable.
 */
export async function registerAgent(ctx: RequestContext, input: unknown) {
    assertCanWrite(ctx);
    const parsed = RegisterAgentSchema.parse(input);

    return runInTenantContext(ctx, async (db) => {
        // Validate the two caller-supplied ids BEFORE writing anything. Both
        // are cheap reads, and doing them first means a rejected registration
        // leaves no half-authored register entry behind even if the transaction
        // semantics were ever to change under us.
        await assertAgentOwner(db, ctx, parsed.ownerUserId);
        if (parsed.vendorId) await assertVendorInTenant(db, ctx, parsed.vendorId);

        const { created: aiSystem, classification, obligationsLinked } =
            await authorAiSystemEntry(db, ctx, {
                name: parsed.name,
                purpose: parsed.purpose ?? null,
                useContext: parsed.useContext ?? null,
                provider: parsed.provider ?? null,
                deploymentRole: parsed.deploymentRole,
                ownerUserId: parsed.ownerUserId,
                classification: parsed.classification,
            });

        const agent = await RegisteredAgentRepository.create(db, ctx, {
            aiSystemId: aiSystem.id,
            name: parsed.name,
            description: parsed.description ? sanitizePlainText(parsed.description) : null,
            autonomyLevel: parsed.autonomyLevel,
            dataAccessScope: parsed.dataAccessScope,
            reversibility: parsed.reversibility,
            provenance: parsed.provenance,
            modelRef: normalizeModelRef(parsed.modelRef) ?? null,
            ownerUserId: parsed.ownerUserId,
            vendorId: parsed.vendorId ?? null,
        });

        await logEvent(db, ctx, {
            action: 'AGENT_REGISTERED',
            entityType: 'RegisteredAgent',
            entityId: agent.id,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'RegisteredAgent',
                operation: 'create',
                summary:
                    `Registered agent "${parsed.name}" — autonomy ${parsed.autonomyLevel}, ` +
                    `${parsed.dataAccessScope}, ${parsed.reversibility}; ` +
                    `AI Act ${classification.tier} (${classification.clauseId})`,
                after: {
                    autonomyLevel: parsed.autonomyLevel,
                    dataAccessScope: parsed.dataAccessScope,
                    reversibility: parsed.reversibility,
                    provenance: parsed.provenance,
                    status: agent.status,
                    // Recorded explicitly so the trail shows the agent arrived
                    // UNSCORED rather than leaving the reader to infer it. The
                    // AI-Act tier beside it is a DIFFERENT taxonomy —
                    // regulatory classification, not operational authority.
                    riskTier: agent.riskTier,
                    aiSystemId: aiSystem.id,
                    aiActRiskTier: classification.tier,
                    aiActClauseId: classification.clauseId,
                    obligationsLinked,
                },
            },
        });

        return {
            id: agent.id,
            status: agent.status,
            riskTier: agent.riskTier,
            aiSystemId: aiSystem.id,
            aiActRiskTier: classification.tier,
            aiActClauseId: classification.clauseId,
            aiActRationale: classification.rationale,
            obligationsLinked,
        };
    });
}

type AgentLifecycleStatus = 'ACTIVE' | 'RETIRED' | 'SUSPENDED';

async function setRegisteredAgentStatus(
    ctx: RequestContext,
    id: string,
    status: AgentLifecycleStatus,
    action: string,
) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, (db) => applyRegisteredAgentStatus(db, ctx, id, status, action));
}

/**
 * The status write itself, taking an open transaction so a caller that has
 * already read something in the same transaction (retirement, which counts the
 * open proposal queue first) does not have to open a second one and race itself.
 */
async function applyRegisteredAgentStatus(
    db: PrismaTx,
    ctx: RequestContext,
    id: string,
    status: AgentLifecycleStatus,
    action: string,
) {
    const count = await RegisteredAgentRepository.setStatus(db, ctx, id, status);
    if (count === 0) throw notFound('Registered agent not found');

    await logEvent(db, ctx, {
        action,
        entityType: 'RegisteredAgent',
        entityId: id,
        detailsJson: {
            category: 'entity_lifecycle',
            entityName: 'RegisteredAgent',
            operation: 'update',
            summary: `Registered agent ${id} moved to ${status}`,
            after: { status },
        },
    });

    return { id, status };
}
