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
 * failure would look exactly like a tenant that had done no work. Both
 * representations carry the SAME `Framework.sourceUrn` (the seed writes the
 * library's urn verbatim), so the family is derived from data rather than from
 * a hand-maintained alias table; the key list below is a fallback for rows
 * predating that convention.
 *
 * The same expansion is applied to the SOURCE side of every cross-framework
 * mapping. Mapping-set YAML resolves refs against library keys
 * (`ISO42001-2023`), while a seeded tenant's ISO 42001 controls hang off the
 * seed row (`ISO42001`). Matching mapping edges by requirement id alone would
 * make inherited coverage silently, permanently zero on every seeded database
 * — which is the commercial claim quietly not being true rather than visibly
 * broken.
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
    MAPPING_STRENGTH_RANK,
    type MappingStrengthValue,
} from '../domain/requirement-mapping.types';
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

/**
 * The identity of a framework ACROSS representations. `sourceUrn` when the row
 * has one (both representations do); the key otherwise, which degrades to
 * "this row is its own family" rather than to a wrong join.
 */
function familyOf(fw: CatalogueEntry): string {
    return fw.sourceUrn ?? `key:${fw.key}`;
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
    covered: [],
    partiallyCovered: [],
    reviewNeeded: [],
    uncovered: [],
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

        const agentView = {
            id: agent.id,
            name: agent.name,
            status: String(agent.status),
            riskTier: agent.riskTier === null ? null : String(agent.riskTier),
            aiSystemId: agent.aiSystemId,
        };

        const catalogue: CatalogueEntry[] = await db.framework.findMany({
            select: { id: true, key: true, name: true, sourceUrn: true },
            take: FRAMEWORK_CATALOGUE_CAP,
        });

        const asiFrameworks = catalogue.filter(
            (f) => f.sourceUrn === ASI_LIBRARY_URN || ASI_FRAMEWORK_KEYS.includes(f.key),
        );
        if (asiFrameworks.length === 0) {
            return {
                agent: agentView,
                frameworkInstalled: false,
                framework: null,
                entries: [],
                summary: EMPTY_SUMMARY,
            };
        }

        const risks = await loadAgenticRisks(db, asiFrameworks.map((f) => f.id));
        if (risks.length === 0) {
            return {
                agent: agentView,
                frameworkInstalled: true,
                framework: { key: asiFrameworks[0].key, name: asiFrameworks[0].name },
                entries: [],
                summary: EMPTY_SUMMARY,
            };
        }

        const riskRequirementIds = risks.flatMap((r) => r.requirementIds);

        const [scopedRequirementIds, directControlsByRequirement, inheritedByRiskCode] =
            await Promise.all([
                loadAgentScope(db, ctx, agent.aiSystemId, riskRequirementIds),
                loadControlsByRequirement(db, ctx, riskRequirementIds),
                loadInheritedCoverage(db, ctx, catalogue, risks),
            ]);

        const entries = risks.map((risk) =>
            classifyAgentRiskCoverage({
                code: risk.code,
                title: risk.title,
                section: risk.section,
                scopedToAgent: risk.requirementIds.some((id) => scopedRequirementIds.has(id)),
                directControls: dedupeControls(
                    risk.requirementIds.flatMap((id) => directControlsByRequirement.get(id) ?? []),
                ),
                inheritedFrom: inheritedByRiskCode.get(risk.code) ?? [],
            }),
        );

        return {
            agent: agentView,
            frameworkInstalled: true,
            framework: { key: asiFrameworks[0].key, name: asiFrameworks[0].name },
            entries,
            summary: summariseAgentRiskCoverage(entries),
        };
    });
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

/** The agent's own scope: `AiSystemRequirementLink` rows for its AI system. */
async function loadAgentScope(
    db: PrismaTx,
    ctx: RequestContext,
    aiSystemId: string,
    requirementIds: string[],
): Promise<Set<string>> {
    const links = await db.aiSystemRequirementLink.findMany({
        where: { tenantId: ctx.tenantId, aiSystemId, requirementId: { in: requirementIds } },
        select: { requirementId: true },
    });
    return new Set(links.map((l) => l.requirementId));
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
        if (fw) wantedFamilies.add(familyOf(fw));
    }
    const familyFrameworkIds = catalogue
        .filter((f) => wantedFamilies.has(familyOf(f)))
        .map((f) => f.id);

    const sourceCodes = [...new Set(edges.map((e) => e.sourceRequirement.code))];
    const siblingRows = await db.frameworkRequirement.findMany({
        where: {
            frameworkId: { in: familyFrameworkIds },
            code: { in: sourceCodes },
            deprecatedAt: null,
        },
        select: { id: true, code: true, frameworkId: true },
    });

    // (family, code) → every requirement row that means the same obligation.
    const siblingsByFamilyCode = new Map<string, string[]>();
    for (const row of siblingRows) {
        const fw = catalogueById.get(row.frameworkId);
        if (!fw) continue;
        const key = `${familyOf(fw)}::${row.code}`;
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

        const routeKey = `${familyOf(fw)}::${edge.sourceRequirement.code}`;
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
    return [...byId.values()].sort((a, b) => a.code.localeCompare(b.code));
}
