/**
 * Rebuild one tenant's knowledge vectors from `KnowledgeChunk` (vector store
 * Phase 2.3, `docs/ai-architecture/weaviate.md`).
 *
 * The rebuild itself is `reindexTenantKnowledge` in
 * `src/app-layer/services/knowledge-reindex.ts`, whose docstring is the
 * contract: what it reads (stored chunk text, nothing else), what it makes
 * true (one vector of the configured model per chunk, the content-hash set
 * exactly the chunks'), what a failure leaves (a superset, never less), and
 * what "the same vectors" means for a real model. This file resolves a tenant
 * by slug or id and prints the result.
 *
 * It uses the deployment's own configuration and nothing else: with
 * `VECTOR_STORE_BACKEND` unset, or no `AI_EMBED_LOCAL_*`, it reads and writes
 * nothing and exits 1 naming the switch. It is also how a new embedding model
 * is introduced: configure the new model and run it per tenant; the old
 * model's rows are left as they are.
 *
 * ## Usage
 *   npx tsx scripts/knowledge-reindex.ts --tenant=<slug-or-id>
 */
import { prisma } from '@/lib/prisma';
import { reindexTenantKnowledge, type KnowledgeReindexResult } from '@/app-layer/services/knowledge-reindex';

export async function run(argv: readonly string[]): Promise<number> {
    const tenantArg = argv.find((a) => a.startsWith('--tenant='))?.slice('--tenant='.length);
    if (!tenantArg) {
        console.error('usage: knowledge-reindex --tenant=<slug-or-id>');
        return 2;
    }
    const tenant = await prisma.tenant.findFirst({
        where: { OR: [{ id: tenantArg }, { slug: tenantArg }], deletedAt: null },
        select: { id: true, slug: true },
    });
    if (!tenant) {
        console.error(`[knowledge-reindex] REFUSED TENANT_NOT_FOUND: no live tenant ${tenantArg}`);
        return 1;
    }
    const result: KnowledgeReindexResult = await reindexTenantKnowledge({ tenantId: tenant.id });
    // Counts and reasons only: never chunk text, never a vector.
    console.info(JSON.stringify({ tenant: tenant.slug, ...result }));
    return result.outcome === 'REBUILT' ? 0 : 1;
}

if (require.main === module) {
    run(process.argv.slice(2))
        .then(async (code) => {
            await prisma.$disconnect();
            process.exit(code);
        })
        .catch(async (err) => {
            console.error('[knowledge-reindex] FAILED', err instanceof Error ? err.message : err);
            await prisma.$disconnect();
            process.exit(1);
        });
}
