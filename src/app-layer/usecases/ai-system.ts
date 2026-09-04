/**
 * EU AI Act AI-System Registry — usecase.
 *
 * Registers each AI system a tenant provides/deploys, runs the deterministic
 * risk-tier classifier (authored from the Regulation — see
 * src/lib/eu-ai-act/classification.ts), and links the system to the AI-Act /
 * ISO 42001 obligations that its tier pulls in (src/lib/eu-ai-act/obligations.ts).
 * The tier is NEVER taken from the client — it is computed here.
 *
 * PROVENANCE: all classification/obligation logic is authored from Regulation
 * (EU) 2024/1689. Nothing derives from any third-party (AGPL) source.
 */
import { assertCanRead, assertCanWrite } from '../policies/common';
import { runInTenantContext } from '@/lib/db-context';
import type { PrismaTx } from '@/lib/db-context';
import { notFound } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { logEvent } from '../events/audit';
import { classifyAiSystem } from '@/lib/eu-ai-act/classification';
import { TIER_OBLIGATIONS, type AiRiskTier } from '@/lib/eu-ai-act/obligations';
import { AiSystemRepository } from '../repositories/AiSystemRepository';
import { CreateAiSystemSchema, type CreateAiSystemInput } from '../schemas/ai-system.schemas';
import type { RequestContext } from '../types';

const AI_FRAMEWORK_KEYS = ['EU-AI-ACT', 'ISO42001'] as const;

/**
 * Resolve a tier's obligation refs (framework key + code) to concrete
 * FrameworkRequirement ids from the seeded AI-Act / ISO 42001 library. Reads
 * the GLOBAL catalog (Framework/FrameworkRequirement are not tenant-scoped, so
 * the tenant-bound `db` reads them without an RLS filter). Unresolved refs are
 * skipped defensively — the CI ratchet (tests/guards/ai-system-registry.test.ts)
 * guarantees the map has no dangling refs, so at runtime this resolves the set.
 */
async function resolveTierRequirementIds(db: PrismaTx, tier: AiRiskTier): Promise<string[]> {
    const refs = TIER_OBLIGATIONS[tier];
    if (!refs.length) return [];

    const frameworks = await db.framework.findMany({
        where: { key: { in: [...AI_FRAMEWORK_KEYS] } },
        select: { id: true, key: true },
    });
    const fwIdByKey = new Map(frameworks.map((f) => [f.key, f.id]));

    const requirements = await db.frameworkRequirement.findMany({
        where: {
            frameworkId: { in: frameworks.map((f) => f.id) },
            code: { in: refs.map((r) => r.code) },
        },
        select: { id: true, code: true, frameworkId: true },
    });
    // key requirements by `${frameworkId}:${code}` so an identical code in two
    // frameworks resolves to the right row.
    const reqIdByFwCode = new Map(
        requirements.map((r) => [`${r.frameworkId}:${r.code}`, r.id]),
    );

    const ids: string[] = [];
    for (const ref of refs) {
        const fwId = fwIdByKey.get(ref.framework);
        if (!fwId) continue;
        const id = reqIdByFwCode.get(`${fwId}:${ref.code}`);
        if (id) ids.push(id);
    }
    return ids;
}

/**
 * Author an AI-Act register entry inside an ALREADY-OPEN tenant transaction:
 * classify, create the row, link the tier's obligations. Returns the created id
 * alongside the classification so the caller can audit what the Act decided.
 *
 * Extracted so the agent register can reuse it (`registerAgent` creates the
 * register entry and the agent in ONE transaction). It takes `db` rather than
 * opening its own context precisely because of that: two `runInTenantContext`
 * calls would be two transactions, and a failure between them would leave an
 * orphan AI system in the register with no agent — a fabricated entry, which is
 * the thing running the real classifier was supposed to prevent.
 *
 * The free-text sanitisation lives HERE, at the write seam, so both callers get
 * it. Encryption protects the columns at rest and does nothing for the PDF
 * export or an SDK consumer that decrypts and renders the value verbatim.
 */
export async function authorAiSystemEntry(
    db: PrismaTx,
    ctx: RequestContext,
    parsed: CreateAiSystemInput,
) {
    // Deterministic, explainable classification — authored from the Act.
    const classification = classifyAiSystem(parsed.classification);
    const requirementIds = await resolveTierRequirementIds(db, classification.tier);

    const created = await AiSystemRepository.create(db, ctx, {
        name: parsed.name,
        // Free-text: sanitised on write; encrypted at rest (Epic B manifest).
        purpose: parsed.purpose ? sanitizePlainText(parsed.purpose) : null,
        useContext: parsed.useContext ? sanitizePlainText(parsed.useContext) : null,
        provider: parsed.provider ? sanitizePlainText(parsed.provider) : null,
        deploymentRole: parsed.deploymentRole,
        riskTier: classification.tier,
        classificationClauseId: classification.clauseId,
        classificationRationale: classification.rationale,
        ownerUserId: parsed.ownerUserId ?? null,
    });

    const obligationsLinked = await AiSystemRepository.linkRequirements(
        db,
        ctx,
        created.id,
        requirementIds,
    );

    return { created, classification, obligationsLinked };
}

export async function createAiSystem(ctx: RequestContext, input: unknown) {
    assertCanWrite(ctx);
    const parsed = CreateAiSystemSchema.parse(input);

    return runInTenantContext(ctx, async (db) => {
        const { created, classification, obligationsLinked } = await authorAiSystemEntry(
            db,
            ctx,
            parsed,
        );

        await logEvent(db, ctx, {
            action: 'AI_SYSTEM_REGISTERED',
            entityType: 'AiSystem',
            entityId: created.id,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'AiSystem',
                operation: 'create',
                summary: `Registered AI system "${parsed.name}" — ${classification.tier} (${classification.clauseId})`,
                after: {
                    riskTier: classification.tier,
                    clauseId: classification.clauseId,
                    obligationsLinked,
                },
            },
        });

        return {
            id: created.id,
            riskTier: classification.tier,
            clauseId: classification.clauseId,
            rationale: classification.rationale,
            obligationsLinked,
        };
    });
}

export async function listAiSystems(
    ctx: RequestContext,
    // Raw query-string values; `AiSystemRepository.list` validates both
    // against the real enum. Typing them here as the enum only invited the
    // route to `as`-cast a bare string in.
    options: { riskTier?: string; status?: string } = {},
) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, (db) =>
        AiSystemRepository.list(db, ctx, options),
    );
}

export async function getAiSystem(ctx: RequestContext, id: string) {
    assertCanRead(ctx);
    const system = await runInTenantContext(ctx, (db) =>
        AiSystemRepository.getById(db, ctx, id),
    );
    if (!system) throw notFound('AI system not found');
    return system;
}
