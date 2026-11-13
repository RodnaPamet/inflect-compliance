/**
 * Container-start step: recompute stored lookup hashes under the current
 * lookup-hash key (#5071).
 *
 *   tsx scripts/recompute-lookup-hashes.ts      (npm run db:recompute-lookup-hashes)
 *   node dist/recompute-lookup-hashes.mjs       (the entrypoint, every start)
 *
 * Does nothing unless the deploy sets `LOOKUP_HASH_KEY`: without it,
 * `hashForLookup` keeps the master-derived key and every stored hash already
 * matches. With it, the first start after the variable is set rewrites every
 * hash, and later starts find nothing to rewrite.
 *
 * FATAL on failure, unlike the seeds beside it in the entrypoint: with the
 * dedicated key set and the hashes not recomputed, no sign-in by email can
 * find its account, so serving would be worse than not starting.
 */
import { prisma } from '@/lib/prisma';
import { runWithoutRls } from '@/lib/db/rls-middleware';
import { lookupHashKeyIsDedicated } from '@/lib/security/encryption';
import { recomputeLookupHashes } from '@/lib/security/lookup-hash-recompute';

async function main(): Promise<number> {
    if (!lookupHashKeyIsDedicated()) {
        console.log('  ✓ LOOKUP_HASH_KEY is not set: lookup hashes stay on the master-derived key.');
        return 0;
    }
    console.log('🔑 Recomputing lookup hashes under LOOKUP_HASH_KEY...');
    const result = await runWithoutRls({ reason: 'admin-script' }, (db) => recomputeLookupHashes(db));
    for (const column of Object.keys(result.scanned)) {
        console.log(`  ✓ ${column}: ${result.rewritten[column]} rewritten of ${result.scanned[column]}`);
    }
    console.log('✅ Lookup hashes match the lookup-hash key.');
    return 0;
}

main()
    .catch((err) => {
        console.error('❌ Lookup-hash recompute failed:', err);
        return 1;
    })
    .then(async (code) => {
        await prisma.$disconnect();
        process.exit(code);
    });
