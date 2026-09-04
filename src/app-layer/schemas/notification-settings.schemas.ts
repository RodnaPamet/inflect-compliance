/**
 * Zod schema for the tenant notification-settings PUT body (#2296).
 *
 * The route had NO schema, and the absence was load-bearing rather than
 * merely untidy. It built all four keys unconditionally from a raw
 * `await req.json()`, so a body omitting `defaultFromEmail` produced the key
 * PRESENT with the value `undefined`. `updateTenantNotificationSettings`
 * spreads its `data` argument AFTER `defaults()`, so that undefined overwrote
 * the resolved sender; Prisma then drops undefined arguments
 * (`strictUndefinedChecks` is a preview feature this repo does not enable), so
 * the column was omitted from the INSERT and the DATABASE default supplied the
 * value — the placeholder address PR #2286 had removed from the code path,
 * reachable again on any tenant's first partial save.
 *
 * Every field is optional because this is a partial update, and zod OMITS an
 * absent optional key from its output rather than setting it to undefined,
 * which is exactly what that spread needed.
 */
import { z } from 'zod';

/** Addresses are capped at the RFC 5321 maximum reverse-path length. */
const EmailAddress = z.string().trim().email().max(320);

export const UpdateNotificationSettingsSchema = z
    .object({
        enabled: z.boolean().optional(),
        defaultFromName: z.string().trim().min(1).max(200).optional(),

        /**
         * Becomes the `From` header on every message the outbox sends for this
         * tenant. It was previously any string an admin cared to post.
         */
        defaultFromEmail: EmailAddress.optional(),

        /**
         * Nullable and NOT defaulted. The route previously read
         * `body.complianceMailbox || null` unconditionally, so a partial body
         * silently wiped an existing tenant's BCC address. An absent key now
         * leaves it alone; an explicit `null` clears it, which is what the
         * admin UI sends for an empty field.
         */
        complianceMailbox: EmailAddress.nullable().optional(),
    })
    .strict();

export type UpdateNotificationSettingsInput = z.infer<typeof UpdateNotificationSettingsSchema>;
