/**
 * Per-agent agentic-risk coverage — the query.
 *
 * Measured fact this module exists to fix: before it, `AiSystemRequirementLink`
 * had ZERO read sites anywhere in `src/`, and `usecases/framework/coverage.ts`
 * joins `ControlRequirementLink` and never touches the AI-system link. So the
 * product could register an agent, link its AI-system entry to obligations, and
 * had no way to answer "which agentic risks is this agent covered for". This is
 * that query.
 *
 * THE FRAMEWORK IS RESOLVED AS A FAMILY, NOT A KEY, AND THAT IS LOAD-BEARING.
 * Every framework in this repo exists in up to TWO representations with
 * DIFFERENT `Framework.key` values — the seed row (`OWASP-ASI`) and the YAML
 * library row (`OWASP-ASI-TOP10`) — because `key` is `@unique` and one shared
 * key would make `prisma/seed.ts` and `syncAllLibraries` fight over one row.
 * A tenant's controls may hang off either. A single-key lookup would therefore
 * report a tenant with a full ASI control set as covering nothing, and the
 * failure would look exactly like a tenant that had done no work.
 *
 * The same expansion is applied to the SOURCE side of every cross-framework
 * mapping. Mapping-set YAML resolves refs against library keys
 * (`ISO42001-2023`), while a seeded tenant's ISO 42001 controls hang off the
 * seed row (`ISO42001`). Matching mapping edges by requirement id alone would
 * make inherited coverage silently, permanently zero on every seeded database
 * — which is the commercial claim quietly not being true rather than visibly
 * broken.
 *
 * BOTH HALVES OF THAT RECONCILIATION LIVE IN `domain/framework-representation.ts`
 * — the family id AND the requirement-code spelling. They are separate
 * failures and fixing one alone delivers nothing: the ISO 27001 route was
 * inert on every seeded database because the seeded row carried no
 * `sourceUrn` (so the family never collapsed) AND because the seed numbers
 * Annex A `5.15` where the library numbers it `A.5.15` (so a code-equality
 * join would have reached nothing even after the family collapsed).
 *
 * `loadAgentScopes` IS NO LONGER THE GATE, AND THE NEXT READER MUST KNOW IT.
 * `AiSystemRequirementLink` gated applicability until this module derived it
 * instead, and the gate could only ever be false: the table's only production
 * writer links EU-AI-ACT / ISO 42001 obligation ids, which are disjoint from
 * the ASI rows, so COVERED was unreachable and every risk read "not scoped" on
 * every real tenant. Applicability now comes from the agent's own declared
 * exposure profile (`services/agent-risk-applicability.ts`), and a link onto an
 * ASI requirement survives as an explicit OPERATOR OVERRIDE that forces the
 * risk back in scope — a recorded human decision beats a derivation. Nothing
 * here writes that table, and nothing should start: it is the EU AI-Act
 * obligation table, its rows land in the Annex IV / Article 9 / Annex V
 * conformity drafts, and ten OWASP rows in there would change what an already
 * hash-chained `obligationsLinked` figure means.
 *
 * Read-only. No audit event: this reads existing links, it changes nothing.
 */
import { notFound } from '@/lib/errors/types';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { assertCanRead } from '../policies/common';
import { RegisteredAgentRepository } from '../repositories/RegisteredAgentRepository';
import {
    classifyAgentRiskCoverage,
    summariseAgentRiskCoverage,
    type AgentRiskCoverageEntry,
    type AgentRiskCoverageSummary,
    type CoveringControl,
    type InheritedCoverage,
} from '../services/agent-risk-coverage';
import {
    agentRiskApplicability,
    APPLIES,
    type AgentExposureProfile,
} from '../services/agent-risk-applicability';
import { isAgentRegistrationEnforced } from '@/lib/agentic/agent-registration-gate';
import {
    MAPPING_STRENGTH_RANK,
    type MappingStrengthValue,
} from '../domain/requirement-mapping.types';
import {
    canonicalRequirementCode,
    frameworkFamilyId,
    requirementCodeSpellings,
} from '../domain/framework-representation';
import type { RequestContext } from '../types';

/**
 * The library URN both representations of the OWASP Agentic AI Top 10 carry.
 * `prisma/seed.ts` writes it as `sourceUrn` on the seeded row and
 * `library-importer.ts` writes `library.urn` on the imported one, so this
 * single constant identifies the family without an alias table.
 */
const ASI_LIBRARY_URN = 'urn:inflect:library:owasp-agentic-top10';

/** Fallback for rows that predate the `sourceUrn` convention. */
const ASI_FRAMEWORK_KEYS: readonly string[] = ['OWASP-ASI', 'OWASP-ASI-TOP10'];

/**
 * The framework catalogue is a small GLOBAL table (tens of rows, no tenantId,
 * no RLS). It is loaded whole and grouped in memory so the family expansion
 * costs one query rather than one per mapping edge.
 */
const FRAMEWORK_CATALOGUE_CAP = 500;

/** Bound on mapping edges landing on the ten agentic requirements. */
const MAPPING_EDGE_CAP = 2000;

interface CatalogueEntry {
    id: string;
    key: string;
    name: string;
    sourceUrn: string | null;
}

export interface AgentRiskCoverageReport {
    readonly agent: {
        readonly id: string;
        readonly name: string;
        readonly status: string;
        readonly riskTier: string | null;
        readonly aiSystemId: string;
    };
    /**
     * FALSE when neither representation of the framework is present in the
     * catalogue. Distinguished from "installed and nothing covered" on purpose:
     * an absence is ambiguous, and a 0% readout for a framework nobody has
     * installed is a different instruction to the operator.
     */
    readonly frameworkInstalled: boolean;
    readonly framework: { readonly key: string; readonly name: string } | null;
    readonly entries: readonly AgentRiskCoverageEntry[];
    readonly summary: AgentRiskCoverageSummary;
}

const EMPTY_SUMMARY: AgentRiskCoverageSummary = {
    total: 0,
    applicableTotal: 0,
    covered: [],
    partiallyCovered: [],
    reviewNeeded: [],
    uncovered: [],
    notApplicable: [],
    coveragePercent: 0,
};

/**
 * Which of the OWASP agentic risks does this registered agent have controls
 * for, and — the part an assessor reads — which does it not?
 */
export async function computeAgentRiskCoverage(
    ctx: RequestContext,
    agentId: string,
): Promise<AgentRiskCoverageReport> {
    assertCanRead(ctx);

    return runInTenantContext(ctx, async (db) => {
        const agent = await RegisteredAgentRepository.getById(db, ctx, agentId);
        if (!agent) throw notFound('Registered agent not found');

        const { agents } = await buildCoverageReports(db, ctx, [agent]);
        return agents[0];
    });
}

/**
 * The same question asked of EVERY registered agent at once — the matrix an
 * assessor reads rather than the row an operator opens.
 *
 * It shares `buildCoverageReports` with the single-agent path above, and that
 * sharing is the point rather than a tidiness. The family expansion this module
 * carries (two representations of the framework, two spellings of a requirement
 * code) is the hard-won part; a second copy of it computed per-agent in a loop
 * would be both an N+1 and, far worse, a place where the two copies could
 * disagree about what a tenant covers. The only per-agent input is the agent's
 * own `AiSystemRequirementLink` scope, and that is loaded for all agents in one
 * query.
 *
 * `agents` may legitimately be EMPTY, and an empty result is not zero coverage —
 * it is no population. The caller distinguishes them; this function just
 * returns nothing to classify.
 */
export async function computeTenantAgentRiskCoverage(
    ctx: RequestContext,
    opts: { take?: number } = {},
): Promise<TenantAgentRiskCoverage> {
    assertCanRead(ctx);

    return runInTenantContext(ctx, async (db) => {
        const agents = await RegisteredAgentRepository.list(db, ctx, { take: opts.take });
        return buildCoverageReports(db, ctx, agents);
    });
}

/**
 * The tenant-wide answer.
 *
 * `frameworkInstalled` and `risks` are properties of the CATALOGUE, not of the
 * agent list, and they are returned separately for that reason: a tenant with no
 * agents can still have the framework installed, and folding the two facts
 * together made an agentless tenant report the framework as absent — which is a
 * different finding, aimed at a different person, than "nobody has registered an
 * agent yet".
 */
export interface TenantAgentRiskCoverage {
    readonly frameworkInstalled: boolean;
    readonly framework: { readonly key: string; readonly name: string } | null;
    /** The distinct risk codes the installed framework carries, in sort order. */
    readonly risks: readonly { readonly code: string; readonly title: string }[];
    readonly agents: readonly AgentRiskCoverageReport[];
}

/**
 * The shape both entry points hand in — a subset of the repository's select.
 *
 * `autonomyLevel` and `isLegacyPlaceholder` are here because applicability is
 * derived from them. No repository change was needed: `listSelect` already
 * carries both and `getById` spreads it.
 */
interface CoverageSubject {
    id: string;
    name: string;
    status: unknown;
    riskTier: unknown;
    aiSystemId: string;
    autonomyLevel: number;
    isLegacyPlaceholder: boolean;
}

/**
 * One coverage classification pass over N agents, inside an already-open tenant
 * transaction. Every load below is tenant-wide except `loadAgentScopes`, which
 * is batched over the agents' AI-system ids.
 */
async function buildCoverageReports(
    db: PrismaTx,
    ctx: RequestContext,
    agents: readonly CoverageSubject[],
): Promise<TenantAgentRiskCoverage> {
    const views = agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        status: String(agent.status),
        riskTier: agent.riskTier === null || agent.riskTier === undefined
            ? null
            : String(agent.riskTier),
        aiSystemId: agent.aiSystemId,
        autonomyLevel: agent.autonomyLevel,
        isLegacyPlaceholder: agent.isLegacyPlaceholder,
    }));

    const catalogue: CatalogueEntry[] = await db.framework.findMany({
        select: { id: true, key: true, name: true, sourceUrn: true },
        take: FRAMEWORK_CATALOGUE_CAP,
    });

    const asiFrameworks = catalogue.filter(
        (f) => f.sourceUrn === ASI_LIBRARY_URN || ASI_FRAMEWORK_KEYS.includes(f.key),
    );
    if (asiFrameworks.length === 0) {
        return {
            frameworkInstalled: false,
            framework: null,
            risks: [],
            agents: views.map((agent) => ({
                agent,
                frameworkInstalled: false,
                framework: null,
                entries: [],
                summary: EMPTY_SUMMARY,
            })),
        };
    }

    const framework = { key: asiFrameworks[0].key, name: asiFrameworks[0].name };
    const risks = await loadAgenticRisks(db, asiFrameworks.map((f) => f.id));
    if (risks.length === 0) {
        return {
            frameworkInstalled: true,
            framework,
            risks: [],
            agents: views.map((agent) => ({
                agent,
                frameworkInstalled: true,
                framework,
                entries: [],
                summary: EMPTY_SUMMARY,
            })),
        };
    }

    const riskRequirementIds = risks.flatMap((r) => r.requirementIds);

    const [
        scopeByAiSystem,
        directControlsByRequirement,
        inheritedByRiskCode,
        toolGrantCounts,
        registrationEnforced,
    ] = await Promise.all([
        loadAgentScopes(db, ctx, views.map((a) => a.aiSystemId), riskRequirementIds),
        loadControlsByRequirement(db, ctx, riskRequirementIds),
        loadInheritedCoverage(db, ctx, catalogue, risks),
        loadToolGrantCounts(db, ctx, views.map((a) => a.id)),
        // Tenant-wide, so it joins the same fan-out rather than the per-agent
        // map. It is a precondition of the ASI02 exemption, not a lifecycle
        // flag: the grant allowlist is only consulted for a credential bound to
        // a live ACTIVE agent, so in a tenant that has switched the register
        // off an empty grant list denies nothing and the exemption's premise
        // does not hold. See `agent-risk-applicability.ts`.
        isAgentRegistrationEnforced(ctx.tenantId),
    ]);

    // The two derivation inputs are destructured OUT of the reported `agent`
    // rather than carried on it. They are inputs to the classification, not
    // part of this endpoint's response shape, and spreading a view that holds
    // them would widen the wire contract by two undeclared fields — the kind
    // of drift nobody notices until a consumer starts depending on it.
    const reports = views.map(({ autonomyLevel, isLegacyPlaceholder, ...agent }) => {
        const scopedRequirementIds = scopeByAiSystem.get(agent.aiSystemId) ?? new Set<string>();
        // Built ONCE per agent, outside the per-risk map: the profile is a
        // property of the agent, and rebuilding it ten times would invite
        // somebody to move a read in here later.
        const profile: AgentExposureProfile = {
            autonomyLevel,
            toolGrantCount: toolGrantCounts.get(agent.id) ?? 0,
            isLegacyPlaceholder,
            registrationEnforced,
        };
        const entries = risks.map((risk) => {
            const explicitlyScoped = risk.requirementIds.some((id) => scopedRequirementIds.has(id));
            return classifyAgentRiskCoverage({
                code: risk.code,
                title: risk.title,
                section: risk.section,
                explicitlyScoped,
                // A human's recorded decision beats a derivation. An operator
                // who linked this agent's AI system to an ASI requirement has
                // said the risk applies; nothing derived may overrule that.
                applicability: explicitlyScoped
                    ? APPLIES
                    : agentRiskApplicability(risk.code, profile),
                directControls: dedupeControls(
                    risk.requirementIds.flatMap((id) => directControlsByRequirement.get(id) ?? []),
                ),
                inheritedFrom: inheritedByRiskCode.get(risk.code) ?? [],
            });
        });

        return {
            agent,
            frameworkInstalled: true,
            framework,
            entries,
            summary: summariseAgentRiskCoverage(entries),
        };
    });

    return {
        frameworkInstalled: true,
        framework,
        risks: risks.map((r) => ({ code: r.code, title: r.title })),
        agents: reports,
    };
}

// ─── Loaders ─────────────────────────────────────────────────────────

interface AgenticRisk {
    code: string;
    title: string;
    section: string | null;
    sortOrder: number;
    /** Every requirement row carrying this code, across both representations. */
    requirementIds: string[];
}

/**
 * The ten risks, collapsed by CODE across every representation of the
 * framework. The code — `ASI04` — is the stable external identifier an
 * assessor cites; the row id is an implementation detail that differs between
 * a seeded and a library-synced database.
 */
async function loadAgenticRisks(db: PrismaTx, frameworkIds: string[]): Promise<AgenticRisk[]> {
    const rows = await db.frameworkRequirement.findMany({
        where: { frameworkId: { in: frameworkIds }, deprecatedAt: null },
        select: { id: true, code: true, title: true, section: true, sortOrder: true },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });

    const byCode = new Map<string, AgenticRisk>();
    for (const row of rows) {
        const existing = byCode.get(row.code);
        if (existing) {
            existing.requirementIds.push(row.id);
            continue;
        }
        byCode.set(row.code, {
            code: row.code,
            title: row.title,
            section: row.section,
            sortOrder: row.sortOrder,
            requirementIds: [row.id],
        });
    }

    return [...byCode.values()].sort(
        (a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code),
    );
}

/**
 * Each agent's own scope: `AiSystemRequirementLink` rows for its AI system.
 *
 * An OVERRIDE input, not the gate — see the module header. Nothing writes ASI
 * rows into this table, so on a real tenant it returns nothing and the derived
 * rule decides; a row that IS there is an operator's recorded decision and
 * forces the risk in scope.
 *
 * ONE query for every agent, keyed by AI-system id. A per-agent read here would
 * be the N+1 the matrix exists to avoid, and two agents can legitimately share
 * nothing — an AI-system id absent from the returned map has NO scoped
 * requirements, which is a different fact from "not looked up".
 */
async function loadAgentScopes(
    db: PrismaTx,
    ctx: RequestContext,
    aiSystemIds: readonly string[],
    requirementIds: string[],
): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>();
    if (aiSystemIds.length === 0 || requirementIds.length === 0) return out;

    const links = await db.aiSystemRequirementLink.findMany({
        where: {
            tenantId: ctx.tenantId,
            aiSystemId: { in: [...new Set(aiSystemIds)] },
            requirementId: { in: requirementIds },
        },
        select: { aiSystemId: true, requirementId: true },
    });
    for (const link of links) {
        const bucket = out.get(link.aiSystemId);
        if (bucket) bucket.add(link.requirementId);
        else out.set(link.aiSystemId, new Set([link.requirementId]));
    }
    return out;
}

/**
 * How many tools each agent holds a grant for.
 *
 * ONE `groupBy` for every agent, and it belongs in the shared `Promise.all`
 * rather than inside the per-agent map — a count read in that loop is the N+1
 * the matrix exists to avoid, and it is the one refactor that would trip the
 * query-shape guardrail. An agent ABSENT from the returned map has ZERO grants:
 * that is a fact the allowlist states outright ("EMPTY MEANS NONE… an agent
 * nobody has granted anything to can call nothing"), not a lookup miss, which
 * is why the caller reads it as `?? 0` rather than treating it as unknown.
 *
 * `RegisteredAgentTool` carries no `deletedAt` — a revoked grant is a deleted
 * row — so there is no soft-delete rail to add here.
 */
async function loadToolGrantCounts(
    db: PrismaTx,
    ctx: RequestContext,
    agentIds: readonly string[],
): Promise<Map<string, number>> {
    if (agentIds.length === 0) return new Map();

    const rows = await db.registeredAgentTool.groupBy({
        by: ['agentId'],
        where: { tenantId: ctx.tenantId, agentId: { in: [...new Set(agentIds)] } },
        _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.agentId, r._count._all]));
}

/**
 * Tenant controls per requirement id. `control.deletedAt: null` for the reason
 * `usecases/framework/coverage.ts` gives on the same join: without it coverage
 * drifts UPWARD as controls are deleted.
 */
async function loadControlsByRequirement(
    db: PrismaTx,
    ctx: RequestContext,
    requirementIds: string[],
): Promise<Map<string, CoveringControl[]>> {
    if (requirementIds.length === 0) return new Map();

    const links = await db.controlRequirementLink.findMany({
        where: {
            tenantId: ctx.tenantId,
            requirementId: { in: requirementIds },
            control: { deletedAt: null },
        },
        select: {
            requirementId: true,
            control: { select: { id: true, code: true, name: true, status: true } },
        },
    });

    const out = new Map<string, CoveringControl[]>();
    for (const link of links) {
        const control: CoveringControl = {
            id: link.control.id,
            code: link.control.code,
            name: link.control.name,
            status: String(link.control.status),
        };
        const bucket = out.get(link.requirementId);
        if (bucket) bucket.push(control);
        else out.set(link.requirementId, [control]);
    }
    return out;
}

/**
 * Inherited coverage: tenant controls on OTHER frameworks' requirements that
 * cross-map onto an agentic risk.
 *
 * Four queries, none of them in a loop. The family expansion in the middle is
 * what makes this work on a seeded database — see the module header.
 */
async function loadInheritedCoverage(
    db: PrismaTx,
    ctx: RequestContext,
    catalogue: CatalogueEntry[],
    risks: AgenticRisk[],
): Promise<Map<string, InheritedCoverage[]>> {
    const riskCodeByRequirementId = new Map<string, string>();
    for (const risk of risks) {
        for (const id of risk.requirementIds) riskCodeByRequirementId.set(id, risk.code);
    }

    const now = new Date();
    const edges = await db.requirementMapping.findMany({
        where: {
            targetRequirementId: { in: [...riskCodeByRequirementId.keys()] },
            // Audit Coherence S9 temporal window — a superseded mapping must
            // not keep answering for a control set nobody re-examined.
            OR: [{ validTo: null }, { validTo: { gt: now } }],
        },
        select: {
            targetRequirementId: true,
            strength: true,
            sourceRequirement: {
                select: { id: true, code: true, title: true, frameworkId: true },
            },
        },
        take: MAPPING_EDGE_CAP,
    });
    if (edges.length === 0) return new Map();

    // Expand each mapping's source framework to its whole family, so a control
    // linked to the seeded representation satisfies a mapping authored against
    // the library one.
    const catalogueById = new Map(catalogue.map((f) => [f.id, f]));
    const wantedFamilies = new Set<string>();
    for (const edge of edges) {
        const fw = catalogueById.get(edge.sourceRequirement.frameworkId);
        if (fw) wantedFamilies.add(frameworkFamilyId(fw));
    }
    const familyFrameworkIds = catalogue
        .filter((f) => wantedFamilies.has(frameworkFamilyId(f)))
        .map((f) => f.id);

    // Ask for every SPELLING of each source code, not just the one the mapping
    // was authored with. ISO 27001 Annex A control 5.15 is `A.5.15` in the
    // library the mapping cites and `5.15` in the seed a tenant's controls hang
    // off; `code: { in: [...] }` on one spelling reaches neither the other
    // representation's rows nor, therefore, that tenant's controls.
    const sourceCodes = [
        ...new Set(
            edges.flatMap((e) => {
                const fw = catalogueById.get(e.sourceRequirement.frameworkId);
                if (!fw) return [e.sourceRequirement.code];
                return requirementCodeSpellings(frameworkFamilyId(fw), e.sourceRequirement.code);
            }),
        ),
    ];
    const siblingRows = await db.frameworkRequirement.findMany({
        where: {
            frameworkId: { in: familyFrameworkIds },
            code: { in: sourceCodes },
            deprecatedAt: null,
        },
        select: { id: true, code: true, frameworkId: true },
    });

    // (family, canonical code) → every requirement row that means the same
    // obligation, across both representations AND both spellings.
    const siblingsByFamilyCode = new Map<string, string[]>();
    for (const row of siblingRows) {
        const fw = catalogueById.get(row.frameworkId);
        if (!fw) continue;
        const family = frameworkFamilyId(fw);
        const key = `${family}::${canonicalRequirementCode(family, row.code)}`;
        const bucket = siblingsByFamilyCode.get(key);
        if (bucket) bucket.push(row.id);
        else siblingsByFamilyCode.set(key, [row.id]);
    }

    const controlsBySourceRequirement = await loadControlsByRequirement(
        db,
        ctx,
        siblingRows.map((r) => r.id),
    );

    // Collapse edges by (risk code, source family, source code): the same
    // obligation reached through two representations is ONE inherited route,
    // and it keeps the strongest strength either edge claimed.
    const byRiskCode = new Map<string, Map<string, InheritedCoverage>>();
    for (const edge of edges) {
        const riskCode = riskCodeByRequirementId.get(edge.targetRequirementId);
        const fw = catalogueById.get(edge.sourceRequirement.frameworkId);
        if (!riskCode || !fw) continue;

        const family = frameworkFamilyId(fw);
        const routeKey = `${family}::${canonicalRequirementCode(family, edge.sourceRequirement.code)}`;
        const controls = dedupeControls(
            (siblingsByFamilyCode.get(routeKey) ?? []).flatMap(
                (id) => controlsBySourceRequirement.get(id) ?? [],
            ),
        );

        const routes = byRiskCode.get(riskCode) ?? new Map<string, InheritedCoverage>();
        const existing = routes.get(routeKey);
        const strength = edge.strength as MappingStrengthValue;
        if (!existing || MAPPING_STRENGTH_RANK[strength] > MAPPING_STRENGTH_RANK[existing.strength]) {
            routes.set(routeKey, {
                frameworkKey: fw.key,
                frameworkName: fw.name,
                requirementCode: edge.sourceRequirement.code,
                requirementTitle: edge.sourceRequirement.title,
                strength,
                controls,
            });
        }
        byRiskCode.set(riskCode, routes);
    }

    const out = new Map<string, InheritedCoverage[]>();
    for (const [riskCode, routes] of byRiskCode) out.set(riskCode, [...routes.values()]);
    return out;
}

/** One control can implement several requirement rows for the same risk. */
function dedupeControls(controls: readonly CoveringControl[]): CoveringControl[] {
    const byId = new Map<string, CoveringControl>();
    for (const control of controls) if (!byId.has(control.id)) byId.set(control.id, control);
    // Sort by code, falling back to the name for controls that have none —
    // `Control.code` is optional, and an uncoded control would otherwise sort
    // as an empty string and clump at the top of an assessor-facing list ahead
    // of everything with a real identifier.
    return [...byId.values()].sort((a, b) =>
        (a.code ?? a.name).localeCompare(b.code ?? b.name),
    );
}
