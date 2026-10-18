/**
 * Agent ownership transfer — the request shapes of its two steps (#3698).
 *
 * Every schema is `.strict()`. A transfer moves an agent's accountability, so a
 * field the server does not recognise is a client that believes it is saying
 * something the server is not hearing — refused as a 400, never stripped.
 */
import { z } from 'zod';

/** A cuid-sized id. Bounded so an id field cannot carry a payload. */
const id = z.string().trim().min(1).max(64);

/** Step one: who should become the owner. The agent is the path's. */
export const ProposeAgentOwnershipTransferSchema = z
    .object({
        toOwnerUserId: id,
    })
    .strict();
export type ProposeAgentOwnershipTransferInput = z.infer<typeof ProposeAgentOwnershipTransferSchema>;

/**
 * Step two: the transfer being accepted, by id. The completer names the row they
 * read, rather than accepting "whatever is open for this agent": a cancel
 * followed by a fresh proposal must not swap what they agree to underneath them.
 */
export const CompleteAgentOwnershipTransferSchema = z
    .object({
        transferId: id,
    })
    .strict();
export type CompleteAgentOwnershipTransferInput = z.infer<typeof CompleteAgentOwnershipTransferSchema>;

/** Cancel (or decline) one transfer. A query string: DELETE carries no body. */
export const CancelAgentOwnershipTransferQuerySchema = z
    .object({
        transferId: id,
    })
    .strict();
export type CancelAgentOwnershipTransferQuery = z.infer<typeof CancelAgentOwnershipTransferQuerySchema>;
