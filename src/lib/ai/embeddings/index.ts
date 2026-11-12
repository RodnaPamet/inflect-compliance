/**
 * The embedding and rerank seam (Layer 4). Server-only: the providers dial
 * addresses inside the deployment's perimeter, and nowhere else.
 *
 * @module lib/ai/embeddings
 */
export * from './types';
export {
    getEmbeddingProvider,
    getRerankProvider,
    resolveEmbeddingRoute,
    resolveRerankRoute,
    MAX_EMBEDDING_DIMENSIONS,
} from './select';
export type {
    EmbeddingSelection,
    EmbeddingRouteRefusal,
    RerankRouteRefusal,
    EmbeddingRouteChoice,
    RerankRouteChoice,
    EmbeddingProviderChoice,
    RerankProviderChoice,
} from './select';
export {
    StubEmbeddingProvider,
    StubRerankProvider,
    STUB_EMBEDDING_MODEL,
    STUB_RERANK_MODEL,
    STUB_DEFAULT_DIMENSIONS,
    stubVector,
} from './stub-provider';
export { checkPerimeterUrl, isPerimeterAddress } from '@/lib/ai/in-deployment-service';
export type { PerimeterRefusal } from '@/lib/ai/in-deployment-service';
export { rerankOrKeepHybridOrder } from './rerank-fallback';
export type { RerankOrder } from './rerank-fallback';
export {
    retrieverRevisionKey,
    sameRetrieverRevision,
    InvalidRetrieverRevisionError,
    MAX_RETRIEVER_K,
} from './revision';
export type { RetrieverRevision } from './revision';
export type { EmbeddingOperation, EmbeddingOutcome } from './metrics';
