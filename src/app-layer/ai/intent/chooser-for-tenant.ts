/**
 * WHICH CHOOSER, IF ANY, MAY READ A TYPED GRANT REQUEST FOR THIS TENANT.
 *
 * The intent layer (#3351) sends the operator's phrase to a model to pick
 * among OFFERED options. That phrase is tenant content — it routinely names a
 * person ("give ivan the vpn package until friday") — so where it may be sent
 * is a residency question, and the owner's decision was that this layer runs
 * on Laya for a `LOCAL_ONLY` tenant and not at all otherwise.
 *
 * ── WHY THIS DEFERS TO `resolveFlueModel` INSTEAD OF READING THE GATE ───────
 *
 * Reading `aiResidency === 'LOCAL_ONLY'` and dialling `aiLocalBaseUrl` is the
 * obvious implementation and it is wrong, for a reason recorded at
 * `model-selection.ts:112-130`: the `inflect-local` provider is built ONCE AT
 * BOOT from `AI_LOCAL_BASE_URL` alone, so a per-tenant `aiLocalBaseUrl`
 * decides that a call may proceed and then DOES NOT CARRY. Flue refuses that
 * configuration as `LOCAL_GATEWAY_NOT_SERVED`. A surface that instead honoured
 * the per-tenant value would send the phrase to a host only a tenant admin
 * typed — not one the deployment operator nominated — under the very setting
 * whose purpose is that content stays put.
 *
 * So the decision is taken by the one exported function that already encodes
 * it, and the base URL dialled is the deployment's, never the column's. The
 * two surfaces then agree about a given configuration by construction rather
 * than by coincidence.
 *
 * The three-column mapping is shared via `residencyTermsFrom` (#3384); the
 * read itself stays here, because each consumer holds a different `db`.
 */
import { env } from '@/env';
import type { RequestContext } from '@/app-layer/types';
import { runInTenantContext } from '@/lib/db-context';
import {
    FLUE_PROVIDER_IDS,
    RESIDENCY_SELECT,
    residencyTermsFrom,
    resolveFlueModel,
    type FlueModelRefusal,
} from '@/lib/agentic/flue/model-selection';

import type { IntentChooser } from './grant-intent';
import { createLayaIntentChooser } from './laya-chooser';

/**
 * Why no chooser is available. `FlueModelRefusal` is reused verbatim so an
 * operator reading this refusal and one reading a refused Flue run are told
 * the same thing about the same misconfiguration.
 */
export type IntentChooserRefusal =
    | FlueModelRefusal
    /** Configured fine, but EXTERNAL — the intent layer is LOCAL_ONLY-only. */
    | 'RESIDENCY_NOT_LOCAL_ONLY';

export type IntentChooserOutcome =
    | { readonly ok: true; readonly chooser: IntentChooser }
    | { readonly ok: false; readonly reason: IntentChooserRefusal };

export async function intentChooserForTenant(
    ctx: RequestContext,
    opts: { readonly deadlineAt: number },
): Promise<IntentChooserOutcome> {
    const settings = await runInTenantContext(ctx, (db) =>
        db.tenantSecuritySettings.findUnique({
            where: { tenantId: ctx.tenantId },
            select: RESIDENCY_SELECT,
        }),
    );

    const choice = resolveFlueModel(residencyTermsFrom(settings));
    if (!choice.ok) return { ok: false, reason: choice.reason };

    // An absent settings row resolves to EXTERNAL, the same default
    // `tenant-security-settings.ts` applies — so a tenant that never chose a
    // posture gets no intent layer rather than a local one by accident.
    if (choice.residency !== 'LOCAL_ONLY') {
        return { ok: false, reason: 'RESIDENCY_NOT_LOCAL_ONLY' };
    }

    // The specifier is `<provider>/<model>`, and the model may itself contain
    // a slash, so this takes everything after the known prefix rather than
    // splitting on the separator.
    const prefix = `${FLUE_PROVIDER_IDS.local}/`;
    const model = choice.specifier.startsWith(prefix)
        ? choice.specifier.slice(prefix.length)
        : '';

    // Both checks below are UNREACHABLE while `resolveFlueModel` holds its
    // LOCAL_ONLY invariant: it returns `ok` only with a local-prefixed
    // specifier, a non-empty model, and a gateway equal to the deployment's.
    // They are kept because that guarantee lives in another module which can
    // change without this one failing to compile, and the cost of being wrong
    // is an outbound request to an empty host carrying tenant content. They
    // are deliberately NOT mutation-proved: no input reaches them.
    if (!model) return { ok: false, reason: 'LOCAL_MODEL_NOT_CONFIGURED' };
    const baseUrl = env.AI_LOCAL_BASE_URL;
    if (!baseUrl) return { ok: false, reason: 'LOCAL_GATEWAY_NOT_CONFIGURED' };

    return {
        ok: true,
        chooser: createLayaIntentChooser({
            baseUrl,
            model,
            // REQUIRED, not defaulted. `LayaChooserOptions.deadlineAt` is
            // mandatory because the caller owns the budget — a default here
            // would be this module inventing a latency ceiling for a request
            // whose own deadline it cannot see.
            deadlineAt: opts.deadlineAt,
        }),
    };
}
