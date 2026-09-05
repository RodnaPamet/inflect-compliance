/**
 * Zod schema for the RFC 8693 token-exchange request.
 *
 * The field names are the RFC's, not ours (`grant_type`, `subject_token`,
 * `audience`, `requested_token_type`), because a standard endpoint that renames
 * its parameters is a bespoke endpoint wearing a citation. An off-the-shelf
 * OAuth client should be able to talk to this.
 *
 * `subject_token` travels in the BODY, where §2.1 puts it — deliberately not in
 * the Authorization header, so the one place a long-lived key appears on this
 * endpoint is the field the standard names for it and no middleware treats it as
 * ambient authentication.
 *
 * `actor_token` is REFUSED rather than ignored. It is the RFC's delegation
 * chain — "A acting for B" — and this server has no delegation model. Silently
 * dropping it would let a client believe it had constrained something; a 400
 * that says so is the honest answer, and it is the same principle as refusing
 * to re-exchange an already-exchanged token.
 */
import { z } from 'zod';

import {
    ACCESS_TOKEN_TYPE,
    MAX_AUDIENCE_ENTRIES,
    MAX_TOKEN_TTL_SECONDS,
    TOKEN_EXCHANGE_GRANT_TYPE,
} from '@/lib/mcp/token-exchange';

export const McpTokenExchangeRequestSchema = z
    .object({
        grant_type: z.string(),
        subject_token: z.string().min(1, 'subject_token is required'),
        subject_token_type: z.string().optional(),
        /**
         * The target(s) this token may be used against — MCP tool names, and/or
         * the resources-surface audience. A single string or an array: the RFC
         * allows the parameter to repeat, which a JSON body expresses as a list.
         */
        audience: z.union([
            z.string().min(1),
            z.array(z.string().min(1)).min(1).max(MAX_AUDIENCE_ENTRIES),
        ]),
        requested_token_type: z.string().optional(),
        /** Seconds. The server maximum is enforced here and again at mint. */
        expires_in: z.number().int().positive().max(MAX_TOKEN_TTL_SECONDS).optional(),
        actor_token: z.string().optional(),
    })
    .superRefine((value, ctx) => {
        if (value.grant_type !== TOKEN_EXCHANGE_GRANT_TYPE) {
            ctx.addIssue({
                code: 'custom',
                path: ['grant_type'],
                message: `grant_type must be "${TOKEN_EXCHANGE_GRANT_TYPE}"`,
            });
        }
        if (
            value.requested_token_type !== undefined &&
            value.requested_token_type !== ACCESS_TOKEN_TYPE
        ) {
            ctx.addIssue({
                code: 'custom',
                path: ['requested_token_type'],
                message: `This server issues only "${ACCESS_TOKEN_TYPE}".`,
            });
        }
        if (value.actor_token !== undefined) {
            ctx.addIssue({
                code: 'custom',
                path: ['actor_token'],
                message:
                    'actor_token is not supported: this server has no delegation model, ' +
                    'and accepting the field would imply a constraint it does not enforce.',
            });
        }
    })
    .transform((value) => ({
        subjectToken: value.subject_token,
        audience: Array.isArray(value.audience) ? value.audience : [value.audience],
        expiresIn: value.expires_in,
    }));

export type McpTokenExchangeRequest = z.infer<typeof McpTokenExchangeRequestSchema>;
