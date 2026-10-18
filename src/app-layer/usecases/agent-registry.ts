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

import { assertCanRead } from '../policies/common';
import { assertAgentGovernanceWrite } from '../policies/agent-governance.policies';
import { runInTenantContext } from '@/lib/db-context';
import {
    AGENTIC_CHECK_IDS,
    AGENTIC_CHECKS,
    parseAgenticCheckConfig,
} from '@/app-layer/services/agent-control-tests';
import { getSampleAuditDisagreementRate } from '@/app-layer/usecases/agent-proposal-sample-audit';
import type { PrismaTx } from '@/lib/db-context';
import { badRequest, conflict, ConflictError, forbidden, notFound } from '@/lib/errors/types';
import { isClassifiedTier } from '@/lib/eu-ai-act/classification';
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
import { applyRetirementCascadeInTx, writeRetirementAuditRows } from './agent-retirement-cascade';
import { ceilingForRiskTier, DENY_CEILING } from '@/lib/agentic/autonomy-ceiling';
import {
    readConcurrencyCap,
    inFlightRunCount,
} from '@/lib/agentic/run-concurrency-policy';
import { isAgentRegistrationEnforced } from '@/lib/agentic/agent-registration-gate';
import { resolveDriverForTenant } from '@/lib/agentic/agent-driver-policy';
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
import { SYSTEM_PRINCIPAL } from '../context-system';

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
export async function assertVendorInTenant(db: PrismaTx, ctx: RequestContext, vendorId: string) {
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

/** One unbound credential, named — see `getAgentGovernanceStatus` below. */
export interface UnboundCredentialSample {
    id: string;
    name: string;
    keyPrefix: string;
}

/**
 * How many unbound credentials the banner names before it stops naming them.
 *
 * Five, because the banner is one sentence plus a list an operator reads in
 * passing. The REMAINDER is never dropped — it is `unboundCredentials` minus
 * this list's length, which the surface renders as an overflow line.
 */
const UNBOUND_CREDENTIAL_SAMPLE_LIMIT = 5;

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
 *
 * ── WHY THE UNBOUND STATE IS NAMED AND NOT MERELY COUNTED (#2565) ────────────
 *
 * "3 live MCP credentials are bound to no agent" tells an operator that
 * something is being refused and not WHICH integration stopped working, so the
 * next move is to open `/admin/api-keys` and compare rows by hand. The rows are
 * already in memory here; reducing them to a `.length` before anything can name
 * them is what turned an actionable warning into a number. So the read carries
 * the three identifying columns and the return carries a bounded HEAD of them
 * — `unboundCredentials` still carries the total, so a tenant with 500 unbound
 * keys gets a banner it can read rather than a wall.
 */
export async function getAgentGovernanceStatus(ctx: RequestContext): Promise<{
    enforcing: boolean;
    unboundCredentials: number;
    unboundCredentialSamples: UnboundCredentialSample[];
    /**
     * #3484 — the concurrent-run cap and how much of it is in use.
     *
     * Carried on THIS read rather than fetched separately by the panel: the
     * page already awaits this usecase, and a second client round trip for two
     * integers would make the control arrive after the page it sits in.
     *
     * `inFlight` is the REAL count, not the verdict's. `evaluateConcurrencyForRun`
     * short-circuits before counting when no cap is set — correct on the
     * run-start hot path, and a false zero as a reported figure.
     */
    concurrency: { cap: number | null; inFlight: number };
}> {
    assertCanReadAgentRegister(ctx);
    const now = new Date();
    const [enforcing, unbound, cap] = await Promise.all([
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
                // column is a Json array. Bounded read; the three identifying
                // columns are here so the banner can NAME what is refused,
                // and no secret material is among them — `keyHash` stays out.
                select: { id: true, name: true, keyPrefix: true, scopes: true },
                // Stable, so the five that get named are the same five on every
                // reload. An unordered head would make the banner's list churn
                // under an operator who is working through it.
                orderBy: [{ name: 'asc' }, { id: 'asc' }],
                take: 500,
            });
            // The population is UNCHANGED by the widened select: the same
            // `where`, the same capability filter, the same bound.
            return rows.filter((r) => hasMcpCapability(r.scopes));
        }),
        // Best-effort, and for the reason the page gives about the panels
        // beside this one: a reader who may see the register but not every
        // tenant setting still gets the register, and an absent figure is the
        // honest rendering of "this page cannot tell you" where a zeroed one
        // would not be.
        readConcurrencyCap(ctx).catch(() => null),
    ]);

    // THE COUNT IS CONDITIONAL ON THE CAP, and it was not.
    //
    // `inFlightRunCount` ran unconditionally in the `Promise.all` above, which
    // put a SECOND concurrent tenant-scoped transaction on every register page
    // load — `runInTenantContext` wraps its callback in a Prisma
    // `$transaction`, so the page held two pooled connections where it had held
    // one. For the overwhelming majority of tenants it bought nothing: a tenant
    // with no cap has no headroom to show, and the panel says "no cap" either
    // way.
    //
    // This mirrors the short-circuit `evaluateConcurrencyForRun` already makes
    // on the run-start path, and for the same reason: a NULL column is the
    // answer for every tenant until somebody sets a cap.
    const inFlight = cap === null ? 0 : await inFlightRunCount(ctx).catch(() => 0);
    return {
        enforcing,
        unboundCredentials: unbound.length,
        unboundCredentialSamples: unbound
            .slice(0, UNBOUND_CREDENTIAL_SAMPLE_LIMIT)
            .map((r) => ({ id: r.id, name: r.name, keyPrefix: r.keyPrefix })),
        concurrency: { cap, inFlight },
    };
}

/**
 * THE THREE ASSURANCE SIGNALS (#2451) — is the governance actually working?
 *
 * The register answers "what is registered" and the banner answers "is the
 * boundary switched on". Neither answers the question an assessor asks, which is
 * whether any of it is being CHECKED. All three of these existed, were computed,
 * and had no surface:
 *
 *   · RISK COVERAGE, tenant-wide. `riskTier === null` is UNSCORED, and an
 *     unscored agent's credential resolves to DENY_CEILING — so coverage is not
 *     a completeness metric, it is the share of the register that can do
 *     anything at all.
 *   · SAMPLE-AUDIT DISAGREEMENT. `getSampleAuditDisagreementRate` measures how
 *     often a second reviewer disagreed with an approval. A propose-not-commit
 *     queue whose approvals nobody re-checks is a rubber stamp with extra steps,
 *     and this is the only number that would say so.
 *   · SCHEDULED AGENTIC CONTROL TESTS. Four checks run on a schedule and write
 *     `ControlTestRun` rows. A check that has NEVER RUN is reported as such
 *     rather than omitted — "no result" and "passed" are the two things an
 *     assurance surface must never conflate, and omission reads as the latter.
 *
 * 4/4's assessor pack is built from these, which is why they land here first.
 */
export interface AgenticCheckStatus {
    checkId: string;
    title: string;
    /** `null` when the check has never produced a run — NOT a pass. */
    result: string | null;
    lastRunAt: Date | null;
}

export async function getAgenticAssuranceSignals(ctx: RequestContext): Promise<{
    riskCoverage: { scored: number; total: number };
    sampleAudit: { answered: number; dissented: number; disagreementRate: number | null };
    controlTests: AgenticCheckStatus[];
}> {
    assertCanReadAgentRegister(ctx);

    const [coverage, sampleAudit, controlTests] = await Promise.all([
        runInTenantContext(ctx, async (db) => {
            // Live agents only: a retired agent's tier says nothing about
            // whether the RUNNING register is assessed.
            const where = {
                tenantId: ctx.tenantId,
                deletedAt: null,
                status: { not: 'RETIRED' as const },
            };
            const [total, scored] = await Promise.all([
                db.registeredAgent.count({ where }),
                db.registeredAgent.count({ where: { ...where, riskTier: { not: null } } }),
            ]);
            return { scored, total };
        }),
        // Best-effort: the sample-audit read asserts its own permission, and a
        // reader who may see the register but not the audit trail should still
        // get the register. An absent number is honest; a zero would not be.
        getSampleAuditDisagreementRate(ctx, { sinceDays: 90 }).catch(() => null),
        runInTenantContext(ctx, async (db) => {
            const plans = await db.controlTestPlan.findMany({
                where: { tenantId: ctx.tenantId, deletedAt: null, automationType: 'INTEGRATION' },
                select: { id: true, automationConfig: true },
                take: 200,
            });
            const byCheck = new Map<string, string[]>();
            for (const plan of plans) {
                const cfg = parseAgenticCheckConfig(plan.automationConfig);
                if (!cfg) continue;
                byCheck.set(cfg.check, [...(byCheck.get(cfg.check) ?? []), plan.id]);
            }

            // ONE read for every check, not one per check. Four iterations is
            // still an N+1 — `query-shape-guardrails` counts the SHAPE, and it
            // is right to: the loop is over a constant today and over whatever
            // the check registry grows into tomorrow.
            //
            // Ordered newest-first and grouped in memory, so the first row seen
            // for a plan is that plan's latest run.
            const allPlanIds = [...byCheck.values()].flat();
            const runs = allPlanIds.length
                ? await db.controlTestRun.findMany({
                      where: { tenantId: ctx.tenantId, testPlanId: { in: allPlanIds } },
                      orderBy: { executedAt: 'desc' },
                      select: { testPlanId: true, result: true, executedAt: true },
                      take: 500,
                  })
                : [];
            const latestByPlan = new Map<string, (typeof runs)[number]>();
            for (const run of runs) {
                if (!latestByPlan.has(run.testPlanId)) latestByPlan.set(run.testPlanId, run);
            }

            return AGENTIC_CHECK_IDS.map((checkId) => {
                // A check can have more than one plan; the most recent run
                // across all of them is the answer.
                const candidates = (byCheck.get(checkId) ?? [])
                    .map((id) => latestByPlan.get(id))
                    .filter((r): r is (typeof runs)[number] => Boolean(r));
                const run = candidates.sort(
                    (a, b) => (b.executedAt?.getTime() ?? 0) - (a.executedAt?.getTime() ?? 0),
                )[0];
                return {
                    checkId,
                    title: AGENTIC_CHECKS[checkId].title,
                    result: run?.result ?? null,
                    lastRunAt: run?.executedAt ?? null,
                };
            });
        }),
    ]);

    return {
        riskCoverage: coverage,
        sampleAudit: sampleAudit
            ? {
                  answered: sampleAudit.answered,
                  dissented: sampleAudit.dissented,
                  disagreementRate: sampleAudit.disagreementRate,
              }
            : { answered: 0, dissented: 0, disagreementRate: null },
        controlTests,
    };
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
 *   • `runsInFlight` — how many workflow runs are executing RIGHT NOW. The
 *     other facts describe a fleet's configuration; this one is the only sign
 *     of life. Read from `WorkflowRun.status = RUNNING` rather than from
 *     `lib/agentic/in-flight-runs.ts`, whose Set is per-PROCESS by design and
 *     would report only the runs the instance that rendered the page happens
 *     to be executing.
 *
 * ── THE CENSUS: `totalRegistered` + `byStanding` (#2560) ────────────────────
 *
 * The four facts above all answer "is anything WRONG". None of them answers
 * "what is here", and a card that can only raise alarms reads identically over
 * a workspace with twelve SUSPENDED agents and one with a single ACTIVE one.
 * `activeUnscored` is not a substitute: it is a RISK-TIER fact that happens to
 * be restricted to one standing, not a census of standings.
 *
 * `totalRegistered` is also the number that decides whether the dashboard card
 * appears at all — the widget was asked for "when any agent is registered",
 * and without a count there was nothing to ask.
 *
 * Two rails, both borrowed from the `activeUnscored` count this runs beside,
 * and both of which produce a PLAUSIBLE wrong number rather than a crash when
 * they are missing:
 *
 *   • `deletedAt: null`. A census without it counts soft-deleted rows, so a
 *     register that has been tidied reports agents nobody can open.
 *   • ZERO-FILL. `groupBy` returns no row for a standing with no agents, so
 *     every member of `AgentStatus` is seeded at 0 before the rows are folded
 *     in. Without it `byStanding.SUSPENDED` is `undefined`, and a consumer
 *     that formats it renders a blank or `NaN` rather than "0".
 *
 * `totalRegistered` is the sum of the four buckets, never a second query: two
 * statements that could disagree about the same population is a bug waiting
 * for a concurrent write.
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
    totalRegistered: number;
    byStanding: Record<AgentStatus, number>;
    runsInFlight: number;
}> {
    assertCanReadAgentRegister(ctx);
    const [enforcing, kills, counts] = await Promise.all([
        isAgentRegistrationEnforced(ctx.tenantId),
        listKillSwitches(ctx, { inForceOnly: true, take: 200 }),
        runInTenantContext(ctx, async (db) => {
            const [activeUnscored, proposalsAwaitingReview, standingRows, runsInFlight] =
                await Promise.all([
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
                db.registeredAgent.groupBy({
                    by: ['status'],
                    where: { tenantId: ctx.tenantId, deletedAt: null },
                    _count: { _all: true },
                }),
                // RUNS IN FLIGHT — read from the ROW, not from the executing
                // process. `lib/agentic/in-flight-runs.ts` holds a Set that one
                // process writes as it walks a run's steps; it exists so a
                // SIGTERM can pause what THAT process is executing, and it is
                // deliberately process-local because no query can tell "my run"
                // from another pod's. A dashboard rendered by whichever
                // instance took the request would therefore report a fraction
                // of the fleet and call it the total.
                //
                // `status = RUNNING` is the tenant-wide answer, and it is the
                // same predicate the drain and the reaper both write against.
                // AWAITING_APPROVAL and PAUSED are excluded on purpose: both
                // are runs that exist and are NOT executing — one is waiting on
                // a human, the other was drained by a deploy — and folding
                // either into "in flight" would have an operator hunting for
                // work nothing is doing.
                db.workflowRun.count({
                    where: { tenantId: ctx.tenantId, status: 'RUNNING' },
                }),
            ]);
            const byStanding = Object.fromEntries(
                Object.values(AgentStatus).map((standing) => [standing, 0]),
            ) as Record<AgentStatus, number>;
            for (const row of standingRows) byStanding[row.status] = row._count._all;
            const totalRegistered = Object.values(byStanding).reduce((a, b) => a + b, 0);
            return {
                activeUnscored,
                proposalsAwaitingReview,
                byStanding,
                totalRegistered,
                runsInFlight,
            };
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
    const [agent, registrationEnforced, driverDecision] = await Promise.all([
        runInTenantContext(ctx, (db) => RegisteredAgentRepository.getById(db, ctx, id)),
        isAgentRegistrationEnforced(ctx.tenantId),
        // WHICH ENGINE this agent's runs would use, resolved the same way and in
        // the same breath as the registration flag above. Both are tenant-level
        // governance facts rather than columns on the agent, and the Overview
        // tab needs them together — a tab owns its own fetch, so the
        // alternative is a second endpoint for one enum.
        resolveDriverForTenant(ctx.tenantId),
    ]);
    // AFTER the trio resolves, not before the flag reads are started: a 404 pays
    // for two extra settings lookups, and the alternative — awaiting the agent
    // first — makes every successful read a second round trip.
    if (!agent) throw notFound('Registered agent not found');
    return {
        ...agent,
        registrationEnforced,
        driver: driverDecision.driver,
        // WHY it is not what was configured, when it is not. `null` means the
        // configured driver IS the one in force; every other value names the
        // term that narrowed it, so the chip can say "static, because this
        // build has no flue driver" rather than just "static".
        driverReason: driverDecision.reason,
    };
}

/**
 * THE REGISTER ROW'S WRITE RECIPE, inside an open transaction — the one place
 * a register row is assembled, shared by `createRegisteredAgent`,
 * `registerAgent` and the registration intake (#3669,
 * `agent-registration-intake.ts`).
 *
 * It sanitises the description, normalises the declared model and inserts the
 * row DRAFT and UNSCORED (the column defaults). It does NOT check the owner or
 * the vendor: each caller validates those BEFORE it writes anything, so a
 * refused registration leaves no half-authored AI-system entry behind, and the
 * intake names its own refusal for an owner who is not an active member.
 */
export async function insertRegisteredAgentInTx(
    db: PrismaTx,
    ctx: RequestContext,
    input: {
        aiSystemId: string;
        name: string;
        description?: string | null;
        autonomyLevel: number;
        dataAccessScope: AgentDataAccessScope;
        reversibility: 'REVERSIBLE' | 'COMPENSABLE' | 'TERMINAL';
        provenance: 'FIRST_PARTY' | 'THIRD_PARTY';
        modelRef?: string | null;
        ownerUserId: string;
        vendorId?: string | null;
        /** The registration intake's claim; every other caller leaves it out. */
        intakeDiscoveredAgentId?: string;
    },
) {
    return RegisteredAgentRepository.create(db, ctx, {
        aiSystemId: input.aiSystemId,
        name: input.name,
        description: input.description ? sanitizePlainText(input.description) : null,
        autonomyLevel: input.autonomyLevel,
        dataAccessScope: input.dataAccessScope,
        reversibility: input.reversibility,
        provenance: input.provenance,
        modelRef: normalizeModelRef(input.modelRef) ?? null,
        ownerUserId: input.ownerUserId,
        vendorId: input.vendorId ?? null,
        ...(input.intakeDiscoveredAgentId !== undefined
            ? { intakeDiscoveredAgentId: input.intakeDiscoveredAgentId }
            : {}),
    });
}

export async function createRegisteredAgent(ctx: RequestContext, input: unknown) {
    assertAgentGovernanceWrite(ctx, 'agent_registry');
    const parsed = CreateRegisteredAgentSchema.parse(input);

    return runInTenantContext(ctx, async (db) => {
        await assertAgentOwner(db, ctx, parsed.ownerUserId);
        if (parsed.vendorId) await assertVendorInTenant(db, ctx, parsed.vendorId);

        const created = await insertRegisteredAgentInTx(db, ctx, {
            aiSystemId: parsed.aiSystemId,
            name: parsed.name,
            description: parsed.description,
            autonomyLevel: parsed.autonomyLevel,
            dataAccessScope: parsed.dataAccessScope,
            reversibility: parsed.reversibility,
            provenance: parsed.provenance,
            modelRef: parsed.modelRef,
            ownerUserId: parsed.ownerUserId,
            vendorId: parsed.vendorId,
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
    assertAgentGovernanceWrite(ctx, 'agent_registry');
    const parsed = UpdateRegisteredAgentSchema.parse(input);

    return runInTenantContext(ctx, async (db) => {
        // The supplier check applies to an UPDATE as much as a create. The
        // OWNER is not amendable at all: the schema refuses `ownerUserId` by
        // name, because ownership moves only by a two-step transfer (#3698,
        // `agent-ownership-transfer.ts`).
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
 * The gate retirement takes: `admin.agent_registry`, and no narrower key.
 *
 * Decided in step 0e: retirement is one act under one key, because every effect
 * of its cascade takes authority away (revoke keys, drop grants, expire
 * proposals, freeze the card), and a holder of a narrower key keeps the
 * standalone verb they hold today. The route already requires the key with a
 * literal `requirePermission`; it is asserted here too so a second caller of the
 * usecase cannot reach the cascade with `canWrite` alone. For the built-in roles
 * this changes nothing — the ones that may write and hold the key are the ones
 * the route admits.
 */
function assertCanRetireAgent(ctx: RequestContext) {
    assertAgentGovernanceWrite(ctx, 'agent_registry');
    if (!ctx.appPermissions?.admin?.agent_registry) {
        throw forbidden(
            'Retiring an agent requires permission to manage the agent register. ' +
                'Retirement revokes its credentials and its tool grants, so it is the ' +
                'register key that decides it.',
        );
    }
}

/**
 * Retire an agent — and take its authority apart in the same transaction.
 *
 * ## What changed, and why the old refusal went
 *
 * Until #3698 this usecase REFUSED while any proposal was PENDING and flipped
 * the status alone. Its docstring rejected cascading on purpose: expiring a
 * human review queue as the side effect of a lifecycle action would surprise the
 * reviewer mid-decision. Two facts outweighed that. Every other piece of the
 * agent's authority — the API keys bound to it, its tool grants, its card —
 * survived the flip: in a workspace that does not enforce registration a
 * retired agent's key kept working, and the register said "retired" about an
 * agent that could still act. And the refusal made the permanent decommission
 * conditional on a queue nobody may have been working, while SUSPEND stood in
 * for it indefinitely. So 0e decided retirement is ONE act: it revokes, drops,
 * expires and freezes, and it says exactly what it did.
 *
 * ## The cascade (`agent-retirement-cascade.ts`)
 *
 *   • every `TenantApiKey` bound to the agent revoked (`revokedAt`), and every
 *     harness scanner signing key it holds;
 *   • every `RegisteredAgentTool` grant deleted;
 *   • every PENDING `AgentProposal` moved to EXPIRED — the expiry sweep's write,
 *     so a reviewer opening one is refused exactly as for a lapsed window, and
 *     the row stays as the record of what the agent asked for;
 *   • its policy card FROZEN: no further version can be written for a retired
 *     agent (refused at the card's write seam and by a trigger), and its history
 *     stays readable;
 *   • its open ownership transfer, if any, closed — CANCELLED while live (a
 *     retired agent can never be completed into), EXPIRED once lapsed
 *     (`agent-ownership-transfer.ts`);
 *   • its PER-AGENT evidence artefacts of the periods still open withdrawn,
 *     reason `AGENT_RETIRED` (#3700, the owner's decision of 2026-10-18 to add
 *     evidence a retirement can withdraw). Tenant-wide artefacts describe every
 *     agent and are never touched; closed periods keep their evidence; nothing
 *     is deleted (`RETIREMENT_EVIDENCE_BASIS`).
 *
 * ## The order is load-bearing
 *
 *   1. Resolve the agent — not found, or already RETIRED (one cascade per agent;
 *      a second retirement is a 409, not a second pass).
 *   2. STATUS FIRST. The UPDATE takes the agent row's lock, and every trigger
 *      that refuses an authority-bearing insert for a retired agent — a PENDING
 *      proposal, a card version, an ownership transfer, an unrevoked API key or
 *      scanner key, a tool grant — takes `FOR SHARE` on that row. So anything
 *      inserted for the agent concurrently, by the agent or by a person, either
 *      committed before this UPDATE — and the cascade below takes it apart — or
 *      waits for this commit, reads RETIRED, and is refused. Nothing slips
 *      between. (The minting usecases read the status unlocked, and an FK
 *      check's `FOR KEY SHARE` does not wait on this UPDATE, so without those
 *      triggers a key minted at this moment would survive it, unrevoked.)
 *   3. The effects, written directly under this one key (see
 *      `assertCanRetireAgent`).
 *   4. AUDIT LAST. `logEvent` writes on its own connection, outside this
 *      transaction, so a row written before an effect that then threw would
 *      describe a retirement that was rolled back.
 *
 * RETIRED is terminal from here: `setStatus` matches no retired row and a
 * trigger refuses the move from any writer, so activate and suspend both refuse
 * a retired agent. SUSPEND remains the REVERSIBLE stop, and the one to reach for
 * when the agent must stop now and its file is not yet to be closed.
 */
export async function retireRegisteredAgent(ctx: RequestContext, id: string) {
    assertCanRetireAgent(ctx);
    const now = new Date();
    return runInTenantContext(ctx, async (db) => {
        const agent = await RegisteredAgentRepository.getLifecycleState(db, ctx, id);
        // Same shape whether absent or foreign, so a caller learns nothing
        // about another tenant's id space.
        if (!agent) throw notFound('Registered agent not found');
        if (agent.status === 'RETIRED') {
            throw conflict(
                'This agent is already retired. Retirement is permanent and is applied once; ' +
                    'its credentials, tool grants and open proposals were dealt with then.',
            );
        }

        const moved = await RegisteredAgentRepository.setStatus(db, ctx, id, 'RETIRED');
        if (moved === 0) {
            // The pre-read saw a live, unretired row; zero now means it was
            // retired or removed while this request was in flight.
            throw conflict(
                'This agent was retired or removed while this request was in flight. ' +
                    'Nothing further was changed; reload it to see its state.',
            );
        }

        const effects = await applyRetirementCascadeInTx(db, ctx, id, now);
        const cascade = await writeRetirementAuditRows(db, ctx, agent, effects);

        return { id, status: 'RETIRED' as const, cascade };
    });
}

/**
 * Resolve an agent for a REVERSIBLE lifecycle move, refusing a retired one.
 *
 * Retirement is permanent (#3698): it revoked the agent's credentials, dropped
 * its grants and froze its card. Moving it back to ACTIVE would put a register
 * row into service whose authority had been taken apart, and would lift the card
 * freeze; moving it to SUSPENDED would make the permanent state reversible
 * through the kill switch's own route. Neither takes authority AWAY, so refusing
 * both is consistent with "taking authority away is never the move to refuse".
 */
async function assertLifecycleMovable(
    db: PrismaTx,
    ctx: RequestContext,
    id: string,
    move: AgentLifecycleMove,
) {
    const agent = await RegisteredAgentRepository.getLifecycleState(db, ctx, id);
    if (!agent) throw notFound('Registered agent not found');
    if (agent.status === 'RETIRED') {
        throw conflict(
            move === 'ACTIVE'
                ? 'This agent is retired, and retirement is permanent: its credentials were ' +
                      'revoked, its tool grants dropped and its policy card frozen, so it cannot ' +
                      'be put back into service. Register a new agent instead.'
                : 'This agent is retired, which already stops it permanently. There is ' +
                      'nothing to suspend.',
        );
    }
    return agent;
}

/**
 * The kill switch. Reversible, unlike retirement, and carrying no precondition
 * on a LIVE agent: this is the control an operator reaches for when an agent is
 * doing something it should not be, and a check that could refuse it would be a
 * check that refuses the emergency stop.
 *
 * The one refusal is a retired agent (#3698), and it refuses no emergency stop:
 * a retired agent is already stopped, with its credentials revoked. Suspending it
 * would only make the permanent state reversible.
 */
export async function suspendRegisteredAgent(ctx: RequestContext, id: string) {
    assertAgentGovernanceWrite(ctx, 'agent_registry');
    return runInTenantContext(ctx, async (db) => {
        await assertLifecycleMovable(db, ctx, id, 'SUSPENDED');
        return applyRegisteredAgentStatus(db, ctx, id, 'SUSPENDED', 'AGENT_SUSPENDED');
    });
}

/**
 * Suspend an ACTIVE agent because its accountable owner has left — the
 * owner-orphan pass's half of the containment (#3670). The kill switch is the
 * other half, engaged first by the pass through `engageOwnerDepartedKill`.
 *
 * NOT reachable by a person: the context must be the system principal with
 * actor type JOB, so the `AGENT_SUSPENDED` audit row carries no user and names
 * nobody, and records `reasonCode: OWNER_DEPARTED` so the trail says why.
 * Conditional on ACTIVE (`suspendIfActive`), so a person's concurrent move —
 * a retirement, a suspension of their own — stands, and `suspended: false`
 * reports it. Reactivating the agent afterwards is the ordinary
 * `activateRegisteredAgent`, by whoever holds the register key; the kill stays
 * in force until the new owner lifts it.
 */
export async function suspendAgentForOwnerDeparture(
    ctx: RequestContext,
    input: { agentId: string },
): Promise<{ suspended: boolean }> {
    if (ctx.actorType !== 'JOB' || ctx.userId !== SYSTEM_PRINCIPAL) {
        throw forbidden('An agent is suspended for its owner\'s departure only by the owner-orphan pass.');
    }
    return runInTenantContext(ctx, async (db) => {
        const moved = await RegisteredAgentRepository.suspendIfActive(db, ctx, input.agentId);
        if (moved === 0) return { suspended: false };
        await logEvent(db, ctx, {
            action: 'AGENT_SUSPENDED',
            entityType: 'RegisteredAgent',
            entityId: input.agentId,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'RegisteredAgent',
                operation: 'update',
                summary: 'Registered agent moved to SUSPENDED because its owner left (OWNER_DEPARTED)',
                before: { status: 'ACTIVE' },
                after: { status: 'SUSPENDED', reasonCode: 'OWNER_DEPARTED' },
            },
        });
        return { suspended: true };
    });
}

/**
 * Move an agent into service — and REFUSE while its AI-system entry is
 * unclassified or nobody has risk-assessed it.
 *
 * This is the moment the MCP gate begins letting its credentials through, so it
 * is a deliberate human act and never a side effect of registration —
 * `createRegisteredAgent`, `registerAgent` and the registration intake all
 * land DRAFT.
 *
 * The two refusals carry `details.reason`: `AI_SYSTEM_UNCLASSIFIED` for an agent
 * registered through a provisional entry nobody has classified yet (#3669), and
 * `UNSCORED`. They are asked in that order, by `assertActivatable`.
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
 * away is never the move to refuse. A RETIRED agent is refused here outright —
 * retirement is permanent (#3698), see `assertLifecycleMovable`.
 */
export async function activateRegisteredAgent(ctx: RequestContext, id: string) {
    assertAgentGovernanceWrite(ctx, 'agent_registry');
    return runInTenantContext(ctx, async (db) => {
        // A retired agent is refused before anything else is read: retirement
        // is permanent, and "classify it" or "complete its assessment" would be
        // the wrong fix. The two preconditions on going into service are the
        // status writer's own (`assertActivatable`), so they hold for every
        // path that asks it for ACTIVE, not just this one.
        await assertLifecycleMovable(db, ctx, id, 'ACTIVE');
        return applyRegisteredAgentStatus(db, ctx, id, 'ACTIVE', 'AGENT_ACTIVATED');
    });
}

/**
 * The named reasons an agent is refused activation, carried as
 * `details.reason` beside a sentence written for the operator.
 */
export type AgentActivationRefusal = 'AI_SYSTEM_UNCLASSIFIED' | 'UNSCORED';

/**
 * What an agent must have before it goes into service, in the order it is
 * asked. Called by `applyRegisteredAgentStatus` whenever the move is to ACTIVE,
 * so a second caller of the status writer cannot reach ACTIVE around either.
 *
 *   1. A CLASSIFIED EU AI Act register entry (#3669). The registration intake
 *      registers a shadow agent through a provisional entry at UNCLASSIFIED,
 *      and decision 1 of the agentic IAM roadmap is that such an agent cannot
 *      become ACTIVE until somebody classifies it. Asked FIRST: an intake agent
 *      is also unscored, and the regulatory classification of the system is the
 *      fact the register cannot otherwise state. It is read through
 *      `isClassifiedTier`, so a tier this build does not know is not classified
 *      either. No race reaches ACTIVE past it: the only write of UNCLASSIFIED is
 *      an INSERT of a new entry, `aiSystemId` is not amendable, and the one move
 *      an existing entry makes is OUT of the value.
 *   2. A SCORED operational tier — see `activateRegisteredAgent`.
 */
async function assertActivatable(db: PrismaTx, ctx: RequestContext, id: string) {
    const entry = await RegisteredAgentRepository.getAiActClassification(db, ctx, id);
    if (!entry) throw notFound('Registered agent not found');
    const tier = entry.aiSystem?.riskTier;
    if (!tier || !isClassifiedTier(tier)) {
        throw new ConflictError(
            "This agent's EU AI Act register entry has not been classified. The agent was " +
                'registered through a provisional AI-system entry, and an agent cannot go into ' +
                'service until that entry is classified. Answer the EU AI Act questionnaire for ' +
                'its AI system first, then activate it.',
            {
                reason: 'AI_SYSTEM_UNCLASSIFIED' satisfies AgentActivationRefusal,
                aiSystemId: entry.aiSystem?.id ?? null,
            },
        );
    }

    const agent = await RegisteredAgentRepository.getScoringState(db, ctx, id);
    if (!agent) throw notFound('Registered agent not found');
    if (agent.riskTier === null) {
        throw new ConflictError(
            'This agent has not been risk-assessed. Complete its agent risk ' +
                'assessment before activating it — an unassessed agent is refused ' +
                'every tool at the boundary anyway, so activating it would put a ' +
                'row in the register that cannot act.',
            { reason: 'UNSCORED' satisfies AgentActivationRefusal },
        );
    }
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
    assertAgentGovernanceWrite(ctx, 'agent_registry');
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

        const agent = await insertRegisteredAgentInTx(db, ctx, {
            aiSystemId: aiSystem.id,
            name: parsed.name,
            description: parsed.description,
            autonomyLevel: parsed.autonomyLevel,
            dataAccessScope: parsed.dataAccessScope,
            reversibility: parsed.reversibility,
            provenance: parsed.provenance,
            modelRef: parsed.modelRef,
            ownerUserId: parsed.ownerUserId,
            vendorId: parsed.vendorId,
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

/** The two REVERSIBLE moves. RETIRED is not one — it has its own act above. */
type AgentLifecycleMove = 'ACTIVE' | 'SUSPENDED';

/**
 * The status write for a reversible move, taking an open transaction so the
 * caller's pre-read (`assertLifecycleMovable`) and the write are one snapshot of
 * intent. Retirement does NOT come through here: it writes its status itself,
 * then its cascade, then a summary audit row that carries what the cascade did.
 */
async function applyRegisteredAgentStatus(
    db: PrismaTx,
    ctx: RequestContext,
    id: string,
    status: AgentLifecycleMove,
    action: string,
) {
    // Going INTO service has preconditions; taking an agent out of it never
    // does. Checked here, at the status writer, rather than only in
    // `activateRegisteredAgent`, so no caller reaches ACTIVE around them.
    if (status === 'ACTIVE') await assertActivatable(db, ctx, id);
    const count = await RegisteredAgentRepository.setStatus(db, ctx, id, status);
    // The pre-read found a live, unretired row, so zero here means it was
    // retired or removed while this request was in flight.
    if (count === 0) {
        throw conflict(
            'This agent was retired or removed while this request was in flight. ' +
                'Nothing was changed; reload it to see its state.',
        );
    }

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
