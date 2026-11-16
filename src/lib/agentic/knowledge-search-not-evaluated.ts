/**
 * WHAT A RUN SAYS WHEN `search_knowledge` WAS WITHHELD BY ITS MOUNT GATE.
 *
 * A leaf module with no imports, for the reason `flue/empty-toolset-message.ts`
 * gives: the sentence is read by the engines' empty-catalogue message and by
 * any surface that explains an omission, and two copies of it would drift.
 *
 * The tool is offered only while a committed RAG evaluation record for the
 * deployment's retriever revision passes the gate's floors (vector store Phase
 * 3.5, `app-layer/services/knowledge-search-mount.ts`; G11: no record, no
 * tool). The clause names the cause and where the remedy lives; it never names
 * a figure, because the gate's own reason is what an operator reads to act.
 */
export const KNOWLEDGE_SEARCH_NOT_EVALUATED =
    'knowledge search, which is offered only once a RAG evaluation record for this deployment’s ' +
    'retriever revision passes its floors, and none does yet (evals/rag/records)';
