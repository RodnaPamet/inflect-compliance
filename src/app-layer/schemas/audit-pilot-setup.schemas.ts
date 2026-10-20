/**
 * The body of `POST /api/t/:slug/admin/agents/audit-pilot` (#3807): run the
 * pilot set-up as the caller, as a dry run or for real.
 *
 * `.strict()`, so a key the server does not know is a 400 rather than silently
 * dropped. `controls` names the control a procedure's plan should run on; a
 * procedure the library does not have is refused by the usecase by name
 * (`UNKNOWN_PROCEDURE`), so the key is a bounded string here, not an enum.
 */
import { z } from 'zod';

const id = z.string().trim().min(1).max(64);

/** Library v1 has five procedures; a body naming more than this is not a set-up. */
const MAX_NAMED_CONTROLS = 10;

export const AuditPilotSetupSchema = z
    .object({
        apply: z.boolean(),
        agentName: z.string().trim().min(1).max(200).optional(),
        controls: z
            .record(z.string().trim().min(1).max(64), id)
            .refine((o) => Object.keys(o).length <= MAX_NAMED_CONTROLS, {
                message: `At most ${MAX_NAMED_CONTROLS} procedures may name a control.`,
            })
            .optional(),
    })
    .strict();
export type AuditPilotSetupInput = z.infer<typeof AuditPilotSetupSchema>;
