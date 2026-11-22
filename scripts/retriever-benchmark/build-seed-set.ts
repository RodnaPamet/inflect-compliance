/**
 * Rebuild the retriever seed set's corpus and content hash from the seed.
 *
 *   npx tsx scripts/retriever-benchmark/build-seed-set.ts           # check only
 *   npx tsx scripts/retriever-benchmark/build-seed-set.ts --write   # rewrite the file
 *
 * The CASES are authored by hand in the set file and are kept as they are;
 * the CORPUS is derived from the seed (`corpus.ts`) and the HASH from both.
 * Run `--write` after a seed policy changes, and expect every record made
 * against the old hash to stop counting — that is the point of the hash.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { buildCorpus, loadSeedSources } from './corpus';
import { setContentHash, type RetrieverSeedSet } from './scoring';

export const SEED_SET_FILE = 'tests/fixtures/rag/retriever-seed-set.json';

export function readSeedSet(repoRoot: string): RetrieverSeedSet {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, SEED_SET_FILE), 'utf-8')) as RetrieverSeedSet;
}

/** The set as it should be: its cases, the corpus the seed gives today, and their hash. */
export function rebuildSeedSet(repoRoot: string, existing: RetrieverSeedSet): RetrieverSeedSet {
    const corpus = buildCorpus(loadSeedSources(repoRoot));
    const body = {
        id: existing.id,
        version: existing.version,
        provenance: existing.provenance,
        corpus,
        cases: existing.cases,
    };
    return {
        id: body.id,
        version: body.version,
        provenance: body.provenance,
        contentHash: setContentHash(body),
        corpus,
        cases: body.cases,
    };
}

export function serialiseSeedSet(set: RetrieverSeedSet): string {
    return `${JSON.stringify(set, null, 2)}\n`;
}

function main(): void {
    const root = path.resolve(__dirname, '../..');
    const existing = readSeedSet(root);
    const rebuilt = rebuildSeedSet(root, existing);
    const text = serialiseSeedSet(rebuilt);
    const current = fs.readFileSync(path.join(root, SEED_SET_FILE), 'utf-8');
    if (process.argv.includes('--write')) {
        fs.writeFileSync(path.join(root, SEED_SET_FILE), text);
        process.stdout.write(`${SEED_SET_FILE}: ${rebuilt.corpus.length} chunks, ${rebuilt.cases.length} cases, ${rebuilt.contentHash}\n`);
        return;
    }
    if (text !== current) {
        process.stderr.write(`${SEED_SET_FILE} is stale; run with --write\n`);
        process.exit(1);
    }
    process.stdout.write(`${SEED_SET_FILE} is current: ${rebuilt.contentHash}\n`);
}

if (require.main === module) main();
