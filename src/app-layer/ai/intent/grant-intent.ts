/**
 * FREE TEXT TO AN APPROVED TEMPLATE, WITH THE MODEL ONLY EVER CHOOSING (#3351).
 *
 * "Give Ada access to the finance package until Friday" becomes the SAME
 * `{ parameterSetId, openFieldValues }` a human types into the compose form,
 * and is then narrowed by exactly the same code — `parseOpenFields`,
 * `refusalForValue`, `checkTargetInPopulation` — before becoming a proposal
 * two humans still approve. This layer gains no authority; it only fills a
 * form faster.
 *
 * ═══ THE CONTAINMENT ARGUMENT: IT CANNOT GENERATE A VALUE ═══
 *
 * #3351 asks what the model is allowed to be WRONG about, and the answer here
 * is narrower than the issue assumed. The model is never asked to produce a
 * string. It answers two questions, each a choice from a set this product
 * built:
 *
 *   1. which approved template, from the tenant's own list, plus NONE;
 *   2. which subject, from the population that template resolved, plus NONE.
 *
 * So it cannot name a subject outside the population, cannot invent a template,
 * and cannot write a date — because the date does not come from it at all (see
 * `relative-date.ts`). A wrong answer is a different APPROVED template or a
 * different subject from a reviewed population, both of which two humans then
 * see. `NONE` is decision 4's refusal, arriving as the protocol's own answer
 * rather than something bolted on afterwards.
 *
 * An answer naming an option we did not offer is `model_unreadable`, not a
 * guess at what was meant. The identity-match wire says why in its own words:
 * offering an option that was never sent "invites a verdict naming a candidate
 * the model never saw, and the parser could not tell that from a real answer".
 *
 * ═══ TEMPLATES IT DOES NOT FULLY UNDERSTAND ARE REFUSED ═══
 *
 * An open field is constrained as `regex`, `enum`, `integer`, `length` or
 * `target` — there is no date kind. This layer understands exactly two shapes:
 * the target marker, and a field named `endDateTime`, which is the grant
 * tool's own required argument. ANY other open field makes the whole template
 * unresolvable here and sends the operator to the form.
 *
 * That refusal is the point rather than a limitation. A template growing a
 * third field must not start receiving a silently-omitted or invented value;
 * it must stop being eligible until somebody teaches this layer the field. The
 * failure mode is "use the form", which costs a click, against "a value nobody
 * chose reached a directory write".
 *
 * ═══ EVERY READING IS RESTATED FOR THE REVIEWER ═══
 *
 * `readings` carries a plain-English line per decision — which template, which
 * subject, which instant and from what phrase. Decision 1 puts the operator's
 * words on the proposal; these are what make them checkable, because "until
 * Friday" and `2026-10-23T23:59:59.999Z` are not obviously the same claim and
 * the reviewer is the person who can catch the difference.
 */
import type { RequestContext } from '@/app-layer/types';
import { guardUntrustedInput } from '@/app-layer/ai/guard';
import { listParameterSets } from '@/app-layer/usecases/external-tool-parameters';
import {
    listComposeOffer,
    describeComposeRefusal,
} from '@/app-layer/usecases/external-write-compose';

import {
    readEndDatePhrase,
    findEndDatePhrase,
    describeDatePhraseRefusal,
    type DatePhraseRefusal,
} from './relative-date';

/**
 * The only non-target open field this layer can fill.
 *
 * The grant tool declares `endDateTime` required in its own input schema, and
 * `tests/unit/intent-grant-resolver.test.ts` cross-checks this constant
 * against that schema by glob — a rename there would otherwise make every
 * grant template silently unresolvable here, which reads as "the feature
 * stopped working" rather than as a rename.
 */
export const END_DATE_FIELD = 'endDateTime';

/** One question put to the model. Always a choice; never an instruction. */
export interface IntentChoice {
    readonly question: string;
    readonly phrase: string;
    readonly options: ReadonlyArray<{ readonly id: string; readonly label: string }>;
}

/**
 * The model seam.
 *
 * Injected so every refusal below is testable without a model, and so the
 * Laya-backed implementation (System One `choice` over `/v1/systemone`) is
 * swappable without touching this logic. Returns the chosen option's `id`, or
 * `null` for NONE.
 */
export interface IntentChooser {
    choose(choice: IntentChoice): Promise<string | null>;
}

export type IntentRefusal =
    /** The guard blocked the text. Decision 2: everything goes through it. */
    | { readonly kind: 'guard_blocked'; readonly ruleIds: readonly string[] }
    /** The tenant has no approved templates, so there is nothing to choose. */
    | { readonly kind: 'no_templates' }
    /** The model answered NONE. Decision 4: refuse, never the nearest. */
    | { readonly kind: 'no_template_matched' }
    /** It named something we did not offer, which is not an answer. */
    | { readonly kind: 'model_unreadable'; readonly detail: string }
    /** The model could not be reached. Not a refusal of the request. */
    | { readonly kind: 'model_unavailable'; readonly detail: string }
    /** The chosen template has a field this layer must not fill. */
    | { readonly kind: 'field_not_understood'; readonly field: string }
    /** The population could not be resolved, so there are no candidates. */
    | { readonly kind: 'target_unavailable'; readonly detail: string }
    /** The model answered NONE for the subject. */
    | { readonly kind: 'no_subject_matched' }
    /** No recognised date phrase, or one that will not do. */
    | { readonly kind: 'date'; readonly refusal: DatePhraseRefusal };

export interface ResolvedIntent {
    readonly parameterSetId: string;
    readonly openFieldValues: Record<string, unknown>;
    /** Verbatim, for the proposal. Rendered as TEXT, never as markup. */
    readonly phrase: string;
    /** One line per reading made, for the reviewer to check. */
    readonly readings: readonly string[];
}

export type IntentOutcome =
    | { readonly ok: true; readonly resolved: ResolvedIntent }
    | { readonly ok: false; readonly refusal: IntentRefusal };

/** The operator-facing sentence. Names what to do next, never a guess. */
export function describeIntentRefusal(r: IntentRefusal): string {
    switch (r.kind) {
        case 'guard_blocked':
            return (
                'That text was held by the content guard and nothing was proposed'
                + (r.ruleIds.length > 0 ? ` (${r.ruleIds.join(', ')})` : '')
                + '. Rephrase it, or fill the form directly.'
            );
        case 'no_templates':
            return (
                'There are no approved templates to choose from, so nothing could be '
                + 'composed. An administrator approves a template before this can be used.'
            );
        case 'no_template_matched':
            return (
                'That could not be matched to one of your approved templates. Nothing was '
                + 'proposed — pick a template on the form rather than have it guessed.'
            );
        case 'model_unreadable':
            return `The answer could not be read (${r.detail}), so nothing was proposed.`;
        case 'model_unavailable':
            return (
                `The local model could not be reached (${r.detail}). Nothing was proposed; `
                + 'the form still works.'
            );
        case 'field_not_understood':
            return (
                `That template has a field this cannot fill ("${r.field}"), so it is not `
                + 'available here. Fill it on the form, where every field is shown.'
            );
        case 'target_unavailable':
            return `The eligible subjects could not be listed (${r.detail}).`;
        case 'no_subject_matched':
            return (
                'No eligible subject in that template\'s population matched. Nothing was '
                + 'proposed — the form lists who is eligible.'
            );
        case 'date':
            return describeDatePhraseRefusal(r.refusal);
        default: {
            const unreachable: never = r;
            return unreachable;
        }
    }
}

/**
 * Resolve an operator's sentence into a compose input, or refuse.
 *
 * Nothing here writes. The result is handed to
 * `composeExternalWriteProposal`, which re-checks every value against the
 * approved bound as though a human had typed it — so a defect in this
 * function cannot widen a bound, only waste a click.
 */
export async function resolveGrantIntent(
    ctx: RequestContext,
    phrase: string,
    deps: { readonly chooser: IntentChooser; readonly now?: Date },
): Promise<IntentOutcome> {
    const now = deps.now ?? new Date();

    // DECISION 2, FIRST. Before the text reaches a model, and before it is
    // used to look anything up. An operator's own typing is a different trust
    // class from a customer's table right up until they paste something
    // somebody sent them, which collapses the distinction.
    const guard = await guardUntrustedInput(ctx, phrase, { source: 'grant-intent' });
    if (guard.blocked) {
        return { ok: false, refusal: { kind: 'guard_blocked', ruleIds: guard.ruleIds } };
    }

    const sets = await listParameterSets(ctx);
    if (sets.length === 0) return { ok: false, refusal: { kind: 'no_templates' } };

    const readings: string[] = [];

    const chosenSetId = await ask(deps.chooser, {
        question: 'Which approved template does this instruction mean?',
        phrase,
        options: sets.map((s) => ({ id: s.id, label: `${s.label} (${s.toolName})` })),
    });
    if (!chosenSetId.ok) return { ok: false, refusal: chosenSetId.refusal };
    if (chosenSetId.id === null) {
        return { ok: false, refusal: { kind: 'no_template_matched' } };
    }
    const set = sets.find((s) => s.id === chosenSetId.id);
    if (set === undefined) {
        return {
            ok: false,
            refusal: { kind: 'model_unreadable', detail: 'it named a template that was not offered' },
        };
    }
    readings.push(`Template: ${set.label} (${set.toolName}).`);

    const offer = await listComposeOffer(ctx, set.id);
    if (!offer.ok) {
        return {
            ok: false,
            refusal: {
                kind: 'target_unavailable',
                detail: describeComposeRefusal(offer.refusal),
            },
        };
    }

    const values: Record<string, unknown> = {};
    for (const field of offer.fields) {
        if (field.kind === 'target') {
            if (field.unavailable !== undefined) {
                return {
                    ok: false,
                    refusal: { kind: 'target_unavailable', detail: field.unavailable },
                };
            }
            const candidates = field.candidates ?? [];
            if (candidates.length === 0) {
                return {
                    ok: false,
                    refusal: {
                        kind: 'target_unavailable',
                        detail: 'the population resolved to nobody',
                    },
                };
            }
            const chosen = await ask(deps.chooser, {
                question: 'Which of these eligible subjects does this instruction name?',
                phrase,
                options: candidates.map((c) => ({ id: c.value, label: c.label })),
            });
            if (!chosen.ok) return { ok: false, refusal: chosen.refusal };
            if (chosen.id === null) return { ok: false, refusal: { kind: 'no_subject_matched' } };
            const picked = candidates.find((c) => c.value === chosen.id);
            if (picked === undefined) {
                return {
                    ok: false,
                    refusal: {
                        kind: 'model_unreadable',
                        detail: 'it named a subject that was not offered',
                    },
                };
            }
            values[field.name] = picked.value;
            readings.push(`Subject: ${picked.label}.`);
            continue;
        }

        if (field.name === END_DATE_FIELD) {
            const found = findEndDatePhrase(phrase);
            const read = readEndDatePhrase(found ?? '', now);
            if (!read.ok) return { ok: false, refusal: { kind: 'date', refusal: read.refusal } };
            values[field.name] = read.endDateTime.toISOString();
            readings.push(
                `Ends: ${read.endDateTime.toISOString()} — read from "${found}" as ${read.reading}.`,
            );
            continue;
        }

        // Anything else. The template is not eligible here, and saying so is
        // better than omitting a required field or inventing a value for it.
        return { ok: false, refusal: { kind: 'field_not_understood', field: field.name } };
    }

    return {
        ok: true,
        resolved: { parameterSetId: set.id, openFieldValues: values, phrase, readings },
    };
}

/**
 * One question, with the transport's failures separated from its answers.
 *
 * A model that could not be reached is `model_unavailable` and NOT a refusal
 * of the operator's request — the two read identically to a caller that
 * collapses them, and only one of them means "rephrase it".
 */
async function ask(
    chooser: IntentChooser,
    choice: IntentChoice,
): Promise<{ ok: true; id: string | null } | { ok: false; refusal: IntentRefusal }> {
    try {
        return { ok: true, id: await chooser.choose(choice) };
    } catch (err) {
        return {
            ok: false,
            refusal: {
                kind: 'model_unavailable',
                detail: err instanceof Error ? err.message : 'unknown error',
            },
        };
    }
}
