/**
 * Is the vector store on? The deployment switch alone, with no backend
 * loaded (vector store Phase 1; `docs/ai-architecture/weaviate.md`).
 *
 * Only `VECTOR_STORE_BACKEND=pgvector` turns it on; any other value, a typo
 * included, is off. `getVectorRepository()` asks this, and so does the index
 * job's enqueue site on a usecase's write path, which must not load the
 * pgvector backend (and with it the database client) just to learn that the
 * store is off.
 */
import { env } from '@/env';

export function vectorStoreEnabled(): boolean {
    return env.VECTOR_STORE_BACKEND === 'pgvector';
}
