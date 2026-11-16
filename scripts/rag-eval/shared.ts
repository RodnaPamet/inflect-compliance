/**
 * What the Ragas nightly's TypeScript stages share (Ragas Phase 1,
 * `docs/ai-architecture/ragas.md`): argument parsing, the loopback guard, and
 * the one switch between the deployment's embedding route and the
 * deterministic stub.
 */
import { createVectorRepository, getVectorRepository, type VectorRepository } from '@/app-layer/repositories/VectorRepository';
import { createPgvectorStore } from '@/app-layer/repositories/vector/pgvector-store';
import type { KnowledgeIndexDeps } from '@/app-layer/services/knowledge-index';
import { StubEmbeddingProvider } from '@/lib/ai/embeddings';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Refuse production and any database off loopback (the inspect-seed rule): the
 * corpus stage creates tenants and people, and both stages read every tenant's
 * row counts. They belong on the nightly's service container or a developer's
 * local test database, nowhere else.
 */
export function assertLoopbackDatabase(env: NodeJS.ProcessEnv): void {
    if (env.NODE_ENV === 'production') throw new Error('rag-eval refuses to run with NODE_ENV=production.');
    const urls = (['DATABASE_URL', 'DIRECT_DATABASE_URL'] as const).filter((k) => typeof env[k] === 'string' && env[k] !== '');
    if (!urls.includes('DATABASE_URL')) throw new Error('rag-eval needs DATABASE_URL (the CI or local test database).');
    for (const k of urls) {
        let host: string;
        try {
            host = new URL(env[k]!).hostname;
        } catch {
            throw new Error(`rag-eval: ${k} is not a URL it can read.`);
        }
        if (!LOOPBACK.has(host)) throw new Error(`rag-eval refuses ${k} on host "${host}": loopback only.`);
    }
}

/** `--name value` pairs; an unknown name is refused rather than ignored. */
export function parseArgs(argv: readonly string[], known: readonly string[]): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) throw new Error(`rag-eval: unexpected argument ${a}`);
        const [name, inline] = a.slice(2).split('=', 2);
        if (!known.includes(name)) throw new Error(`rag-eval: unknown option --${name}`);
        out[name] = inline ?? argv[++i];
    }
    return out;
}

/**
 * `deployment`: the deployment's embedding route and vector repository, as the
 * product indexes and searches (the nightly). `stub`: the deterministic
 * feature-hash embedder and the pgvector backend, for tests and a local run
 * with no TEI. A stub run's model id is the stub's, so nothing it produces can
 * be mistaken for a record of the real retriever.
 */
export type EmbedderMode = 'deployment' | 'stub';

export function embedderDeps(mode: EmbedderMode, stubDimensions = 384): KnowledgeIndexDeps {
    if (mode === 'deployment') return {};
    if (mode !== 'stub') throw new Error(`rag-eval: --embedder is deployment or stub, not ${String(mode)}`);
    return {
        vectors: createVectorRepository(createPgvectorStore()),
        embedder: () => ({ ok: true as const, provider: new StubEmbeddingProvider(stubDimensions) }),
    };
}

/** The vector repository a stage searches: the deps' own, or the deployment's (null when the store is off). */
export function vectorsOf(deps: KnowledgeIndexDeps): VectorRepository | null {
    return deps.vectors === undefined ? getVectorRepository() : deps.vectors;
}
