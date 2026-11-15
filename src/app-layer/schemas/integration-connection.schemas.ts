/**
 * The body `POST /api/t/:tenantSlug/admin/integrations` takes to create or
 * update an integration connection.
 *
 * `name` is refused when it carries a control character or a lone surrogate
 * (#5317, owner decision 2026-11-15) — see `src/lib/text/connection-name.ts`
 * for the set and the reason. The refusal is a 400 whose issue sits at path
 * `['name']` with the message `CONNECTION_NAME_INVALID_CHARACTERS`, which the
 * form reads to put the reason beside the name field.
 *
 * `name` is REQUIRED on a create and OPTIONAL on an update (a body with `id`).
 * Labels already stored are left alone, so an update that does not send the
 * name — the enable action, or an edit that did not change it — succeeds
 * whatever the stored name holds. A name that IS sent is judged.
 */
import { z } from 'zod';
import {
    CONNECTION_NAME_INVALID_CHARACTERS,
    connectionNameHasInvalidCharacters,
} from '@/lib/text/connection-name';

export const IntegrationConnectionNameSchema = z
    .string()
    .min(1, 'name is required')
    .refine((name) => !connectionNameHasInvalidCharacters(name), {
        message: CONNECTION_NAME_INVALID_CHARACTERS,
    });

export const SaveIntegrationConnectionSchema = z
    .object({
        id: z.string().min(1).optional(),
        provider: z.string().min(1, 'provider is required'),
        name: IntegrationConnectionNameSchema.optional(),
        configJson: z.record(z.string(), z.unknown()).nullish(),
        secrets: z.record(z.string(), z.unknown()).nullish(),
        isEnabled: z.boolean().optional(),
    })
    .superRefine((body, ctx) => {
        if (body.id === undefined && body.name === undefined) {
            ctx.addIssue({ code: 'custom', path: ['name'], message: 'name is required' });
        }
    });

export type SaveIntegrationConnectionInput = z.infer<typeof SaveIntegrationConnectionSchema>;
