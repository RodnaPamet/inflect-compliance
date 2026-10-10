/**
 * THE LAYA-BACKED CHOOSER: one constrained question, on our own hardware (#3351).
 *
 * `grant-intent.ts` asks "which of these?" and this answers it, by speaking the
 * same System One wire protocol `ai/identity-match` uses — a `choice` question
 * over a declared option set — against a Laya deployment the operator runs.
 *
 * ═══ WHY LAYA, AND WHY THAT IS NOT A SUB-PROCESSOR QUESTION ═══
 *
 * `docs/sub-processors.md` is explicit: a tenant on `LOCAL_ONLY` "is served by
 * Laya on infrastructure the operator runs. Laya is **not** a sub-processor and
 * has no entry here." So this path needs no activation and no notice window,
 * which is what unblocked #3351 — its original decision 3 assumed the only
 * answer was an external model.
 *
 * ═══ A SIBLING MODULE, NOT A GENERALISATION OF identity-match ═══
 *
 * `QUESTION_IDS` and `MatchState` there are hard-coded to account matching, and
 * that subsystem belongs to the legacy-access roadmap. Widening its types for a
 * second consumer is how a module becomes a shared dependency nobody owns —
 * `entitlement.ts` makes the same argument about `graphErrorCode`. So this
 * reuses only `callSystemOne`, whose `body` is caller-supplied and therefore
 * already generic, and brings its own state, labels and answer schema.
 *
 * ═══ THE LABELS ARE OURS, AND SO IS THE CAP ═══
 *
 * The protocol answers with a label from the set the request declares, not with
 * an arbitrary string — which is the property that makes a choice question
 * safe. identity-match uses A-E plus NONE; this uses A-T plus NONE, and
 * REFUSES rather than truncating above that.
 *
 * Refusing matters more than the number. Truncating a 30-template list to 20
 * would mean the right template is simply absent, and the model would then
 * either answer NONE — a refusal the operator cannot act on, because the
 * template they meant does exist — or pick the nearest of the wrong twenty.
 * Twenty is OUR limit, not the vendor's: `VENDOR_MAX_CHOICE_OPTIONS` is 255,
 * and a model choosing among 255 descriptions is a reliability question nobody
 * here has measured.
 *
 * ═══ UNVERIFIED AGAINST A RUNNING LAYA ═══
 *
 * Stated because it matters and because #3311 is this repo's standard for
 * exactly this. The request shape below — in particular a `state` that is not a
 * `MatchState` — is inferred from the one existing caller, not measured against
 * a deployment. Everything about the MAPPING is tested here with an injected
 * `fetchImpl`; what is untested is whether a real Laya accepts this state and
 * question id. Until somebody runs it, treat a refusal as more likely than a
 * wrong answer: an unparseable response becomes `model_unreadable` upstream and
 * nothing is proposed.
 */
import { z } from 'zod';

import { callSystemOne } from '@/app-layer/ai/identity-match/transport';
import { LAYA_TIMEOUT_MS } from '@/app-layer/ai/identity-match/laya-provider';

import type { IntentChoice, IntentChooser } from './grant-intent';

/** Our label alphabet. Twenty is plenty for a picker and well under the 255 cap. */
export const INTENT_OPTION_LABELS = [
    'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J',
    'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T',
] as const;
export const INTENT_NONE = 'NONE' as const;
export const MAX_INTENT_OPTIONS = INTENT_OPTION_LABELS.length;

/** The question id this module owns. Not one of identity-match's. */
export const INTENT_QUESTION_ID = 'intent_choice' as const;

const answerSchema = z
    .object({
        answers: z.object({
            [INTENT_QUESTION_ID]: z
                .object({
                    type: z.literal('choice'),
                    // Validated against the labels WE declared, not accepted as
                    // given: a proxy that rewrote one, or a model naming a label
                    // we did not offer, must not arrive as an answer this code
                    // then maps to whatever happens to sit at that position.
                    option: z.enum([...INTENT_OPTION_LABELS, INTENT_NONE]),
                })
                .passthrough(),
        }),
    })
    .passthrough();

export interface LayaChooserOptions {
    readonly baseUrl: string;
    readonly apiKey?: string;
    readonly model: string;
    /** Absolute epoch-ms ceiling for the whole call. The caller owns the budget. */
    readonly deadlineAt: number;
    /** Injected for testing. Defaults to global fetch inside the transport. */
    readonly fetchImpl?: typeof fetch;
    readonly nowMs?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Build the request for one choice question.
 *
 * Exported so the mapping is testable on its own: the thing most likely to be
 * wrong here is which label stands for which option, and that is a pure
 * function of the input.
 */
export function buildIntentChoiceRequest(
    model: string,
    choice: IntentChoice,
): { body: unknown; labelOf: ReadonlyMap<string, string> } {
    if (choice.options.length > MAX_INTENT_OPTIONS) {
        throw new Error(
            `intent choice has ${choice.options.length} options, above the ${MAX_INTENT_OPTIONS} `
                + 'this question can label. Refusing rather than truncating, because a truncated '
                + 'list makes the right answer absent and the refusal unactionable.',
        );
    }
    if (choice.options.length === 0) {
        throw new Error('intent choice has no options, so there is nothing to ask');
    }

    const labelOf = new Map<string, string>();
    const offered = choice.options.map((o, i) => {
        const label = INTENT_OPTION_LABELS[i];
        labelOf.set(label, o.id);
        return { option: label, description: o.label };
    });

    return {
        labelOf,
        body: {
            model,
            // OUR state, carrying only the instruction and the offered set.
            // Nothing else about the tenant goes to the model: it is choosing
            // between descriptions we wrote, not reasoning about a directory.
            state: {
                instruction: choice.phrase,
                question: choice.question,
                options: offered,
            },
            questions: {
                [INTENT_QUESTION_ID]: {
                    type: 'choice',
                    options: [
                        ...offered,
                        {
                            option: INTENT_NONE,
                            description:
                                'None of the listed options is what the instruction means.',
                        },
                    ],
                },
            },
        },
    };
}

/**
 * Map a response back to an option id, or `null` for NONE.
 *
 * Throws when the answer names a label that was not offered — which the
 * resolver turns into `model_unreadable` rather than a near-miss. A label we
 * did not send cannot be mapped to anything, and guessing which option was
 * meant is precisely what the label indirection exists to prevent.
 */
export function readIntentChoiceAnswer(
    raw: unknown,
    labelOf: ReadonlyMap<string, string>,
): string | null {
    const parsed = answerSchema.safeParse(raw);
    if (!parsed.success) {
        throw new Error(`System One answer did not parse: ${parsed.error.issues[0]?.message}`);
    }
    const option = parsed.data.answers[INTENT_QUESTION_ID].option;
    if (option === INTENT_NONE) return null;
    const id = labelOf.get(option);
    if (id === undefined) {
        throw new Error(`answer named option ${option}, which was not offered`);
    }
    return id;
}

/** A chooser backed by a Laya deployment the operator runs. */
export function createLayaIntentChooser(opts: LayaChooserOptions): IntentChooser {
    return {
        async choose(choice: IntentChoice): Promise<string | null> {
            const { body, labelOf } = buildIntentChoiceRequest(opts.model, choice);
            const raw = await callSystemOne({
                url: `${opts.baseUrl.replace(/\/+$/, '')}/v1/systemone`,
                body,
                timeoutMs: LAYA_TIMEOUT_MS,
                deadlineAt: opts.deadlineAt,
                ...(opts.apiKey ? { headers: { authorization: `Bearer ${opts.apiKey}` } } : {}),
                ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
                ...(opts.nowMs ? { nowMs: opts.nowMs } : {}),
                ...(opts.sleep ? { sleep: opts.sleep } : {}),
            });
            return readIntentChoiceAnswer(raw, labelOf);
        },
    };
}
