/**
 * The answer contract between the Ragas harness and the product (Ragas Phase
 * 1.2, `docs/ai-architecture/ragas.md`): what the harness's answer route
 * returns for one question, so the harness measures the product's composed
 * pipeline — `search_knowledge` through the funnel and its guards, then the
 * model's answer — and not a reimplementation of it.
 *
 * The route itself is built with the vector store's Phase 3.3–3.5 (the tool,
 * the assistant offering it, the mount gate and its test-mode bypass for the
 * harness tenant); it answers with exactly this shape. The harness's Python
 * reader (`evals/rag/inflect_rag/answers.py`) holds the same contract, and
 * both are held to `evals/rag/fixtures/answer-contract.json`.
 *
 *   answer     the product's answer, verbatim
 *   retrieved  what `search_knowledge` returned to the model, in rank order,
 *              with the chunk text it returned (seed text only)
 *   retriever  the embedding model and k the product searched with; the
 *              harness refuses a run whose answers were retrieved under another
 *              revision than the one its retrieval stage measured
 *   usage      the model tokens the answer cost, settled against the
 *              reservation the harness made before asking (null keeps the
 *              reservation's worst case)
 *
 * Strict: an unknown member is a refusal, never ignored.
 */
import { z } from 'zod';

export const RAG_ANSWER_CONTRACT = 'rag-answer@1';

export const RagAnswerRequestSchema = z.object({ question: z.string().min(1).max(2_048) }).strict();

export const RagAnswerResponseSchema = z
    .object({
        answer: z.string().max(8_192),
        retrieved: z
            .array(
                z
                    .object({
                        sourceModel: z.string().min(1).max(64),
                        sourceId: z.string().min(1).max(128),
                        chunkIndex: z.number().int().min(0),
                        text: z.string().max(8_192),
                    })
                    .strict(),
            )
            .max(50),
        retriever: z.object({ embeddingModel: z.string().min(1).max(128), k: z.number().int().min(1).max(50) }).strict(),
        usage: z
            .object({ inputTokens: z.number().int().min(0), outputTokens: z.number().int().min(0) })
            .strict()
            .nullable(),
    })
    .strict();

export type RagAnswerRequest = z.infer<typeof RagAnswerRequestSchema>;
export type RagAnswerResponse = z.infer<typeof RagAnswerResponseSchema>;
