/**
 * The payload an EXTERNAL_WRITE proposal carries (#2861).
 *
 * The `PROPOSE_ONLY` rung queues a write to somebody else's system for human
 * approval. It reuses `AgentProposal` for the review machinery — the four-eyes
 * database trigger, the output guard, the expiry window, the sample audits —
 * but the payload cannot be one of our entity create-schemas, because the
 * subject is a record in a system we do not hold.
 *
 * ## What a reviewer needs in order to approve honestly
 *
 * Four things, and all four live here rather than being looked up at review
 * time:
 *
 *   · WHERE it goes — `connectionName` and `endpointUrl`, denormalised so the
 *     row stays readable after the connection is deleted or renamed, the same
 *     reason `ExternalWriteJournal` denormalises them;
 *   · WHAT is being called — the qualified `toolName` we address it by and the
 *     `advertisedToolName` the far end knows, which is the only one meaningful
 *     to somebody logging into that system to check;
 *   · WHAT WOULD CHANGE — `arguments`, post-narrowing and post-egress-scan;
 *   · WHAT IT REPLACES — `priorState`, read from the far end immediately before
 *     the proposal was queued, through the paired prior-state read.
 *
 * `priorState` being IN the payload is what makes this kind `operation: CREATE`
 * rather than `UPDATE`, and that is a measured choice rather than a semantic
 * one: `buildProposalDiff` resolves an UPDATE's `targetEntityId` against one of
 * OUR tables, so an external write shaped as an UPDATE always answers
 * TARGET_MISSING and cannot be approved at all. `CREATE` here means "there is no
 * internal record to diff against", which is exactly true.
 *
 * ## Sanitisation changes what is dispatched, and that is the point
 *
 * `createAgentProposal` runs `sanitizeDeep` over every payload, so the arguments
 * a reviewer sees are the sanitised ones — and those are the arguments the
 * dispatch later sends. That is not a compromise to work around: a human
 * approving a write must be approving what actually goes out, and a dispatch
 * that sent something other than what was displayed would be the real defect.
 * Review fidelity is the property; byte-preservation of agent-supplied strings
 * is not.
 */
import { z } from 'zod';

/**
 * A queued external write.
 *
 * `.strict()` deliberately: an unrecognised key here is a caller writing a field
 * the review surface will not render and the dispatch will not send, which is a
 * silent gap between what was approved and what happens.
 */
export const ExternalWriteProposalPayloadSchema = z
    .object({
        connectionId: z.string().min(1),
        connectionName: z.string().min(1),
        endpointUrl: z.string().min(1),
        /** Our qualified `mcp__<connectionId>__<tool>`. */
        toolName: z.string().min(1),
        /** What the SERVER calls it — the only name meaningful at the far end. */
        advertisedToolName: z.string().min(1),
        /** Exactly what would be sent, after parameter-set narrowing. */
        arguments: z.record(z.string(), z.unknown()),
        /**
         * What the paired read returned immediately before this was queued.
         *
         * `unknown` rather than a shape: it is whatever the far end answered, and
         * constraining it here would refuse proposals from any server whose read
         * tool does not answer in a shape we guessed.
         */
        priorState: z.unknown(),
    })
    .strict();

export type ExternalWriteProposalPayload = z.infer<typeof ExternalWriteProposalPayloadSchema>;
