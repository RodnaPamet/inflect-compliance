/**
 * AGENTIC OUTPUT GUARD — the seam between an agent's output and IC's write queue.
 *
 * `src/app-layer/ai/decision-log` gave the AI FEATURES a record with three
 * properties: an `inputDigest` (SHA-256, never the raw prompt or PII), a
 * BOUNDED `outputSummary`, and a `guardVerdict`. The agentic path had none of
 * them — `createAgentProposal` scanned its content and then threw the result
 * away.
 *
 * This module supplies the missing decision, and one more thing besides: a
 * terminal QUARANTINE state that the review queue cannot resurrect.
 *
 * ## Why a `flag` was not enough
 *
 * `guardUntrustedInput` resolves its enforcement through the tenant's
 * `aiGuardMode`, and the default mode is `balanced`, where a **malicious**
 * INPUT verdict resolves to `flag` — which `assertGuardAllowed` does not throw
 * on. So before this module, an agent proposal whose content tripped a
 * high-severity injection rule was queued as an ordinary `PENDING` row and
 * showed up in the reviewer's list looking exactly like a clean one. The
 * reviewer was the only control, and the reviewer was told nothing.
 *
 * That is the shape the whole propose-not-commit design exists to avoid: a
 * human approving something they have no way to tell apart.
 *
 * ## Why the tenant guard mode does NOT soften this
 *
 * `aiGuardMode` tunes whether IC will make a MODEL CALL — a per-tenant appetite
 * for false positives on an LLM path. Quarantine is a different question:
 * whether untrusted text becomes a live compliance record. `audit` mode is a
 * deliberate opt-out of enforcement on the first question and must not be a
 * silent opt-out of the second, so this decision reads the PROVENANCE and the
 * scan, and nothing else. It is pure and it does not query the tenant.
 *
 * ## Nothing here handles raw content
 *
 * The verdict carries rule ids, a digest, and a summary built ONLY from
 * structural facts (kind, field names, lengths). No excerpt of the proposal is
 * produced, returned or persisted — see `summarizeWithoutContent`.
 */
import { createHash } from 'node:crypto';

import {
    type ContentProvenance,
    type DataOnlySourceId,
    UNTRUSTED_PROVENANCE,
    mayCarryInstruction,
    resolveContentProvenance,
} from '@/lib/agentic/content-provenance';

import { scanInjection } from './injection-scanner';
import { scanEgress } from './egress-scanner';

/** The persisted verdict. Mirrors the `AgentGuardVerdict` Prisma enum exactly. */
export type AgentGuardVerdict = 'CLEAN' | 'FLAGGED' | 'QUARANTINED';

/** Bounded summary length — mirrors `AiDecisionLog`'s own cap. */
export const GUARD_SUMMARY_MAX = 500;

/**
 * The ingestion path an agent proposal is assumed to have arrived by when the
 * caller names none. `THIRD_PARTY_INGESTED` in the allowlist.
 */
export const DEFAULT_PROPOSAL_SOURCE: DataOnlySourceId = 'agent.proposal';

export interface GuardAgentProposalInput {
    /** The proposal kind (RISK / CONTROL / POLICY / FINDING). */
    kind: string;
    /** The VALIDATED + SANITISED payload about to be queued. */
    payload: unknown;
    /** The agent's rationale, sanitised. */
    rationale?: string | null;
    /**
     * Where the content came from. Defaults to the `agent.proposal` ingestion
     * path, which the allowlist resolves to `THIRD_PARTY_INGESTED` — an
     * external agent's output is untrusted by construction. Passed explicitly
     * only where a caller genuinely knows better.
     *
     * TYPED AS `DataOnlySourceId`, WHICH IS THE POINT. It used to be `string |
     * null`, and that made it a QUARANTINE KILL-SWITCH: `'platform.aggregate'`
     * (or any other `SYSTEM` id) resolves to a provenance for which
     * `mayCarryInstruction` is true, and the ladder below only quarantines when
     * that is false. One argument, on the one function that decides whether
     * injected content becomes a compliance record, and the failure is SILENT —
     * proposals stop being quarantined and the queue looks healthy.
     *
     * No caller passed one, so it was latent rather than live; nothing stopped
     * the next caller. The union is DERIVED from the allowlist (every id whose
     * label may not carry instruction), so it needs no maintenance and a new
     * `SYSTEM` entry drops out of it automatically.
     */
    sourceId?: DataOnlySourceId | null;
}

export interface AgentProposalGuardResult {
    verdict: AgentGuardVerdict;
    /** True exactly when `verdict === 'QUARANTINED'`. */
    quarantined: boolean;
    /** Stable rule ids that fired — safe to persist and log (no user content). */
    ruleIds: string[];
    provenance: ContentProvenance;
    /** `sha256:<hex>` over the guarded content. NEVER the content itself. */
    inputDigest: string;
    /** Structural summary — field names and lengths, never an excerpt. */
    outputSummary: string;
}

/**
 * SHA-256 over the guarded content. Same construction and same `sha256:` prefix
 * as `computeInputDigest` in the AI decision log, deliberately: two records of
 * the same proposal must be joinable, and a second hashing convention is a
 * second thing to get wrong.
 *
 * Duplicated rather than imported because the decision log's helper is typed
 * around a provider's sanitised *input*; sharing the name across two different
 * subjects would make the join look automatic when it is not.
 */
export function computeProposalDigest(content: unknown): string {
    return 'sha256:' + createHash('sha256').update(JSON.stringify(content ?? null)).digest('hex');
}

/**
 * Build the bounded summary from STRUCTURAL FACTS ONLY — the kind, the payload's
 * top-level field names, the character counts, and the rule ids that fired.
 *
 * Deliberately NOT an excerpt. `AiDecisionLog.outputSummary` stores a sanitised
 * slice of a model's answer, which is safe there because the answer is IC's own
 * generated prose. Here the "output" IS the untrusted content — the injected
 * sentence is the thing we would be slicing — so an excerpt would persist
 * exactly the payload the guard exists to keep out of the database.
 *
 * Field NAMES are structural: they come from the create-schema, not from the
 * attacker, because the payload has already been parsed by that schema before
 * this runs.
 */
export function summarizeWithoutContent(
    kind: string,
    payload: unknown,
    rationale: string | null | undefined,
    ruleIds: readonly string[],
): string {
    const fields =
        payload && typeof payload === 'object' && !Array.isArray(payload)
            ? Object.keys(payload as Record<string, unknown>).sort()
            : [];
    const payloadLen = JSON.stringify(payload ?? null).length;
    const rationaleLen = typeof rationale === 'string' ? rationale.length : 0;
    const parts = [
        `kind=${kind}`,
        `fields=${fields.join('|') || 'none'}`,
        `payloadChars=${payloadLen}`,
        `rationaleChars=${rationaleLen}`,
        `rules=${ruleIds.join('|') || 'none'}`,
    ];
    return parts.join(' ').slice(0, GUARD_SUMMARY_MAX);
}

/**
 * Every string leaf of the payload, in traversal order.
 *
 * Joining these with a real newline gives the rules the line structure they are
 * written against, and drops the JSON punctuation they never wanted to read.
 */
function payloadTextLeaves(value: unknown, out: string[] = []): string[] {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) for (const v of value) payloadTextLeaves(v, out);
    else if (value && typeof value === 'object')
        for (const v of Object.values(value)) payloadTextLeaves(v, out);
    return out;
}

/**
 * The trust label for one proposal's content, and the SECOND half of the
 * kill-switch fix.
 *
 * `DataOnlySourceId` makes the dangerous call a compile error. This makes it a
 * no-op, because a type is not a runtime property: an `as` cast, an id read out
 * of a row, or a JS caller all reach this function with whatever string they
 * like. So a resolved label that MAY CARRY INSTRUCTION is clamped back to
 * `UNTRUSTED_PROVENANCE` here.
 *
 * The clamp is not a repair of untrusted content — it is a refusal of an
 * unearned trust CLAIM. Everything reaching this module is, by construction, an
 * agent's output: `guardAgentProposal` is called from exactly one place
 * (`createAgentProposal`), and its three upstream sources are an MCP propose
 * tool, the assistant and the AI-conformity drafter — model output in all three
 * cases, and model output is never platform-authored. There is therefore no
 * legitimate `SYSTEM` proposal for the clamp to get wrong.
 *
 * It clamps rather than throws: the caller's next move on a quarantine is to
 * WRITE the row as evidence of the attempt, and a throw here would delete that
 * evidence to report a programming error the compiler has already refused.
 * The clamped label is what the result reports, so nothing downstream is told
 * a provenance the guard did not use.
 */
function resolveProposalProvenance(
    sourceId: GuardAgentProposalInput['sourceId'],
): ContentProvenance {
    const resolved = resolveContentProvenance(sourceId ?? DEFAULT_PROPOSAL_SOURCE);
    return mayCarryInstruction(resolved) ? UNTRUSTED_PROVENANCE : resolved;
}

/**
 * Guard one agent proposal before it is written.
 *
 * PURE — no DB, no clock, no tenant read. Given the same content it returns the
 * same verdict, which is what makes the injection corpus a regression suite
 * rather than a mood.
 *
 * The ladder:
 *   • a HIGH-severity injection rule, or any egress/secret hit, on content whose
 *     provenance may NOT carry instruction  → `QUARANTINED`;
 *   • anything else non-clean                → `FLAGGED` (queued, but the row
 *     carries the verdict so the reviewer is told);
 *   • nothing fired                          → `CLEAN`.
 *
 * The provenance term is the reason a single scan can produce two different
 * answers: untrusted content that reads as an instruction is an INJECTION,
 * while the identical string in platform-generated scaffolding is IC's own
 * prompt, and `mayCarryInstruction` is the only thing that can tell them apart.
 *
 * ON THIS PATH IT NEVER PRODUCES THE SECOND ANSWER, AND THAT IS DELIBERATE.
 * The distinction belongs to `resolveContentProvenance`, which serves every
 * content seam; a PROPOSAL is agent output by construction and can never be
 * platform-authored, so `resolveProposalProvenance` refuses an
 * instruction-bearing claim rather than honouring it. The parameter that could
 * make one is typed out of existence as well — see
 * `GuardAgentProposalInput.sourceId`.
 */
export function guardAgentProposal(
    input: GuardAgentProposalInput,
): AgentProposalGuardResult {
    const provenance = resolveProposalProvenance(input.sourceId);
    const rationale = input.rationale ?? null;

    // The guarded text: the rationale the agent wrote plus the payload it
    // proposes. Serialised the same way every time so the digest is stable.
    const guarded = { kind: input.kind, payload: input.payload, rationale };
    // Scanned as the payload's string LEAVES joined by real newlines — NOT as
    // `JSON.stringify(payload)`, which was the other half of the same bug.
    // Serialising rewrites a real newline inside a field as the two characters
    // `\` and `n`, so a line-anchored rule could never see a line boundary
    // anywhere except the very start of the text — i.e. only in the rationale.
    // The identical `System:` string quarantined as a rationale and passed as a
    // description.
    //
    // The DIGEST still uses `JSON.stringify` below: identity and meaning are
    // different questions, and the digest has to stay stable.
    const text = [rationale ?? '', ...payloadTextLeaves(input.payload ?? null)].join('\n');

    const injection = scanInjection(text);
    const egress = scanEgress(guarded);

    const ruleIds = [...injection.ruleIds, ...egress.ruleIds];
    const worstIsMalicious =
        injection.verdict === 'malicious' || egress.verdict === 'malicious';
    const anythingFired = ruleIds.length > 0;

    let verdict: AgentGuardVerdict = 'CLEAN';
    if (worstIsMalicious && !mayCarryInstruction(provenance)) {
        verdict = 'QUARANTINED';
    } else if (anythingFired) {
        verdict = 'FLAGGED';
    }

    return {
        verdict,
        quarantined: verdict === 'QUARANTINED',
        ruleIds,
        provenance,
        inputDigest: computeProposalDigest(guarded),
        outputSummary: summarizeWithoutContent(input.kind, input.payload, rationale, ruleIds),
    };
}
