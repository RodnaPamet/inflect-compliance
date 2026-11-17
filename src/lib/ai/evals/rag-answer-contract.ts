/**
 * The answer contract between the Ragas harness and the product (Ragas Phase
 * 1.2, `docs/ai-architecture/ragas.md`): what the harness's answer stage
 * returns for one question, so the harness measures the product's composed
 * pipeline — `search_knowledge` through the funnel and its guards, then the
 * model's answer — and not a reimplementation of it.
 *
 * There is no route. The answer stage (`scripts/rag-eval/answer.ts`) asks
 * the assistant IN PROCESS, with `search_knowledge` mounted for its own
 * answer tenant by the evaluation's scoped decision
 * (`services/rag-evaluation-mount.ts`), and writes one response of exactly
 * this shape per case into an answers file (`RagAnswersFileSchema`, below),
 * which the judge reads. The harness's Python reader
 * (`evals/rag/inflect_rag/answers.py`) holds the same contract, and both are
 * held to `evals/rag/fixtures/answer-contract.json`.
 *
 *   answer     the product's answer, verbatim
 *   retrieved  what `search_knowledge` returned to the model, in rank order,
 *              with the chunk text it returned (seed text only)
 *   retriever  the embedding model and k the product searched with; the
 *              harness refuses a run whose answers were retrieved under another
 *              revision than the one its retrieval stage measured
 *   usage      the model tokens the answer's turns reported, summed (null
 *              when any turn reported none). Informational: every turn was
 *              already metered against the ragas share by the proxy it was
 *              sent through.
 *
 * Strict: an unknown member is a refusal, never ignored.
 */
import { z } from 'zod';

import { RagEvaluationRecordSchema } from './rag-record';

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

/**
 * THE ANSWERS FILE (`rag-answers@1`): what the answer stage hands the judge —
 * every case it answered, in the set's order, each with its response, and the
 * cases it did not reach.
 *
 *   status  COMPLETE: every case answered. BUDGET_EXHAUSTED: the ragas share
 *           refused an answer turn, so answering stopped; the judge leaves the
 *           unanswered cases out and the record it writes says
 *           BUDGET_EXHAUSTED, which never passes a floor or opens the gate.
 *
 * Bound to the set and the retriever revision the retrieval stage measured;
 * the judge refuses a file bound to anything else.
 */
export const RAG_ANSWERS_FILE_CONTRACT = 'rag-answers@1';

const CASE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_CASES = 200;

export const RagAnswersFileSchema = z
    .object({
        contract: z.literal(RAG_ANSWERS_FILE_CONTRACT),
        setHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
        retrieverRevision: RagEvaluationRecordSchema.shape.retrieverRevision,
        status: z.enum(['COMPLETE', 'BUDGET_EXHAUSTED']),
        answers: z
            .array(
                z
                    .object({
                        caseId: z.string().regex(CASE_ID),
                        question: RagAnswerRequestSchema.shape.question,
                        response: RagAnswerResponseSchema,
                    })
                    .strict(),
            )
            .max(MAX_CASES),
        unanswered: z.array(z.string().regex(CASE_ID)).max(MAX_CASES),
    })
    .strict()
    .superRefine((f, ctx) => {
        const ids = [...f.answers.map((a) => a.caseId), ...f.unanswered];
        if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'a case is listed twice' });
        if (f.status === 'COMPLETE' && f.unanswered.length > 0) {
            ctx.addIssue({ code: 'custom', message: 'a COMPLETE file leaves no case unanswered' });
        }
        if (f.status === 'BUDGET_EXHAUSTED' && f.unanswered.length === 0) {
            ctx.addIssue({ code: 'custom', message: 'a BUDGET_EXHAUSTED file names the cases it did not answer' });
        }
    });

export type RagAnswersFile = z.infer<typeof RagAnswersFileSchema>;
