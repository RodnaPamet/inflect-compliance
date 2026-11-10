/**
 * The body of `POST /api/t/:slug/admin/agents/assurance-checks` (#5014): schedule
 * the four agent assurance checks, as a dry run or for real.
 *
 * `.strict()`, so a key the server does not know is a 400 rather than silently
 * dropped. `controls` names the control a check's plan should run on; a check
 * that does not exist is refused by the usecase by name (`UNKNOWN_CHECK`), so the
 * key is a bounded string here, not an enum.
 */
import { z } from 'zod';

/** There are four checks; a body naming more than this is not a set-up. */
const MAX_NAMED_CONTROLS = 8;

export const AgentAssuranceChecksSetupSchema = z
    .object({
        apply: z.boolean(),
        controls: z
            .record(z.string().trim().min(1).max(64), z.string().trim().min(1).max(64))
            .refine((o) => Object.keys(o).length <= MAX_NAMED_CONTROLS, {
                message: `At most ${MAX_NAMED_CONTROLS} checks may name a control.`,
            })
            .optional(),
    })
    .strict();
export type AgentAssuranceChecksSetupInput = z.infer<typeof AgentAssuranceChecksSetupSchema>;
