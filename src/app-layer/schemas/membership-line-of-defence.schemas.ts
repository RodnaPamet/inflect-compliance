/**
 * The body of `PUT /api/t/:slug/admin/members/:membershipId/line-of-defence`
 * (#3675). `null` clears the declaration — "not declared", which never
 * satisfies a check that asks for a line. `.strict()`, so an undeclared key is
 * a 400 rather than silently dropped.
 */
import { z } from 'zod';

export const LINE_OF_DEFENCE_VALUES = ['FIRST', 'SECOND', 'THIRD'] as const;

export const SetLineOfDefenceSchema = z
    .object({
        lineOfDefence: z.enum(LINE_OF_DEFENCE_VALUES).nullable(),
    })
    .strict();
export type SetLineOfDefenceInput = z.infer<typeof SetLineOfDefenceSchema>;
