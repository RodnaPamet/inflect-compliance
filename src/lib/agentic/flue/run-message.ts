/**
 * THE MESSAGE A FLUE RUN'S AGENT IS GIVEN — and the run's input inside it
 * (#3710, the reach half of step 1d).
 *
 * ── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────
 *
 * `runMessage` lived in `execute.ts` and handed the model the definition's
 * description and its step labels, and nothing else. The Flue driver never
 * opened the sealed run context, so a run's input never reached the model: a
 * `discovered-agent-review` run was told to review "one discovered agent" and
 * was never told which, and each IAM skill's missing-input rule answered for it.
 *
 * It is its own module because `execute.ts` imports `@flue/runtime` statically
 * and no CJS suite can load it. The message is the thing worth testing — what
 * the model is shown, and that the digest names it — so it lives where a test
 * can build it.
 *
 * ── ONLY DECLARED KEYS, AND ONLY AS DATA ────────────────────────────────────
 *
 *   • DECLARED ONLY. The keys a definition lists in `requiredInput`, in that
 *     order, and nothing else from the sealed context — not its other input
 *     keys, and never its `outputs`. Admission refused a run without them
 *     (`assertRequiredInputPresent`), so a missing one here is a broken
 *     definition, and the run is refused rather than prompted with a gap.
 *   • SCANNED ON THE WAY IN. The whole run input passed `guardUntrustedInput`
 *     at admission (`workflow-run-input:<key>`), before the row existed, and a
 *     flag or a block refused the run. The context is sealed and chain-verified
 *     when it is opened here, so what reaches the prompt is what was scanned.
 *   • NEUTRALISED. Each value goes through `baseClean` (NFKC, invisible
 *     characters stripped, whitespace collapsed) and THEN
 *     `neutralizeUntrustedText` — the order `ai/identity-match` records as a
 *     security property, because NFKC can CREATE a reserved token that a
 *     neutraliser run first would have missed.
 *   • FENCED AND LABELLED. Inside the `[BEGIN UNTRUSTED TENANT DATA]` markers
 *     the risk-assessment prompt builder uses, followed by the handling rule
 *     MCP tool results carry (`handlingFor`), for the provenance its source
 *     resolves to — `agent.run-input`, THIRD_PARTY_INGESTED. The model is told
 *     the same thing about this text as about every tool result it reads.
 *   • BOUNDED. A value longer than `MAX_RUN_INPUT_VALUE_CHARS` refuses the run
 *     rather than being cut: a truncated identifier is a different identifier.
 *
 * A definition that declares no input gets the message it always got, byte
 * for byte — so the decision digest of every existing workflow is unchanged.
 */
import { baseClean } from '@/lib/identity/reconcile/normalise';
import {
    neutralizeUntrustedText,
    UNTRUSTED_DATA_CLOSE,
    UNTRUSTED_DATA_OPEN,
} from '@/app-layer/ai/risk-assessment/prompt-builder';
import { handlingFor, resolveContentProvenance } from '@/lib/agentic/content-provenance';
import {
    ContextIntegrityError,
    describeContextHalt,
    openSealedContext,
    type ContextIntegrityCode,
} from '@/lib/agentic/context-integrity';
import type { WorkflowDefinition } from '@/lib/agentic/workflow-types';

/** The provenance source a run's declared input resolves through. */
export const RUN_INPUT_SOURCE = 'agent.run-input';

/**
 * The longest value carried into the prompt. An identifier is far shorter; the
 * bound is `baseClean`'s own input cap, so the cleaner never truncates silently.
 */
export const MAX_RUN_INPUT_VALUE_CHARS = 512;

/** The declared input, cleaned and neutralised, in declaration order. */
export type DeclaredRunInput = ReadonlyArray<readonly [key: string, value: string]>;

export type DeclaredInputRefusal = 'MISSING' | 'TOO_LONG' | 'EMPTY_AFTER_NEUTRALISING';

export type DeclaredInputReading =
    | { readonly ok: true; readonly input: DeclaredRunInput }
    | { readonly ok: false; readonly reason: DeclaredInputRefusal; readonly keys: readonly string[] };

/**
 * Read the definition's DECLARED input out of a run input, and nothing else.
 *
 * Refuses rather than substitutes, for the reason `requiredString` gives: a
 * placeholder is a value the tools downstream disagree about.
 */
export function readDeclaredRunInput(
    def: Pick<WorkflowDefinition, 'requiredInput'>,
    input: Readonly<Record<string, unknown>>,
): DeclaredInputReading {
    const missing: string[] = [];
    const tooLong: string[] = [];
    const emptied: string[] = [];
    const out: Array<readonly [string, string]> = [];
    for (const key of def.requiredInput ?? []) {
        const raw = input[key];
        if (typeof raw !== 'string' || raw.trim() === '') {
            missing.push(key);
            continue;
        }
        if (raw.length > MAX_RUN_INPUT_VALUE_CHARS) {
            tooLong.push(key);
            continue;
        }
        const value = neutralizeUntrustedText(baseClean(raw)).trim();
        if (value === '') {
            emptied.push(key);
            continue;
        }
        out.push([key, value] as const);
    }
    if (missing.length > 0) return { ok: false, reason: 'MISSING', keys: missing };
    if (tooLong.length > 0) return { ok: false, reason: 'TOO_LONG', keys: tooLong };
    if (emptied.length > 0) return { ok: false, reason: 'EMPTY_AFTER_NEUTRALISING', keys: emptied };
    return { ok: true, input: out };
}

export type OpenedRunInput =
    | { readonly ok: true; readonly input: DeclaredRunInput }
    | {
          readonly ok: false;
          /** Safe to store and to show: codes, keys, counts and digests only. */
          readonly message: string;
          /** Set when the sealed context itself would not open. */
          readonly integrityCode: ContextIntegrityCode | null;
      };

/**
 * Open the run's sealed context and read its declared input.
 *
 * A definition that declares none never opens the context — there is nothing
 * in it this engine needs, and a run must not fail on a read it did not need.
 *
 * Opened UNDER VERIFICATION, schema and chain, exactly as the static engine
 * opens it; a context that does not verify refuses the run with the same
 * closed-shape message (`describeContextHalt`). No `minSeq`: the static engine
 * passes one to stop an earlier link being replayed, and that guards
 * `outputs`. The `input` half is written once at admission and carried
 * unchanged by every later seal, so a replayed link carries the same input.
 */
export function openDeclaredRunInput(params: {
    tenantId: string;
    runId: string;
    def: Pick<WorkflowDefinition, 'requiredInput'>;
    storedJson: string | null;
    storedHash: string | null;
}): OpenedRunInput {
    if ((params.def.requiredInput ?? []).length === 0) return { ok: true, input: [] };
    let input: Readonly<Record<string, unknown>>;
    try {
        input = openSealedContext({
            tenantId: params.tenantId,
            runId: params.runId,
            storedJson: params.storedJson,
            storedHash: params.storedHash,
        }).context.input;
    } catch (err) {
        if (err instanceof ContextIntegrityError) {
            return { ok: false, message: describeContextHalt(err), integrityCode: err.code };
        }
        throw err;
    }
    const reading = readDeclaredRunInput(params.def, input);
    if (reading.ok) return reading;
    return {
        ok: false,
        message:
            `flue_run_input_unreadable: ${reading.reason} [${reading.keys.join(',')}]. ` +
            'The run was not sent to the model without the input its definition declares.',
        integrityCode: null,
    };
}

/**
 * The message a run's agent is given.
 *
 * The definition's description plus the steps it still has to cover. A Flue
 * run does not WALK the declared steps — that is the static engine's contract —
 * but the steps are the specification of the work, and handing the model the
 * description alone would ask it to infer a plan the definition already states.
 *
 * Then, when the definition declares input, that input — fenced, labelled, and
 * followed by the data-only handling rule. Nothing about it is an instruction:
 * the description and the step list above it are the platform's scaffolding,
 * and the only text in the message that is.
 */
export function runMessage(
    def: Pick<WorkflowDefinition, 'description' | 'steps'>,
    fromSeq: number,
    input: DeclaredRunInput = [],
): string {
    const remaining = def.steps.slice(fromSeq);
    const lines = remaining.map((step, i) => `${fromSeq + i + 1}. [${step.kind}] ${step.label}`);
    const parts = [
        def.description,
        '',
        'Cover the following, in order. Use the tools you have been given; do not assume.',
        ...lines,
    ];
    if (input.length > 0) {
        const provenance = resolveContentProvenance(RUN_INPUT_SOURCE);
        parts.push(
            '',
            `This run was started with the input below. Provenance: ${provenance} (source ${RUN_INPUT_SOURCE}).`,
            UNTRUSTED_DATA_OPEN,
            ...input.map(([key, value]) => `${key}: ${value}`),
            UNTRUSTED_DATA_CLOSE,
            handlingFor(provenance),
        );
    }
    return parts.join('\n');
}
