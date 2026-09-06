/**
 * Agentic evidence artefacts — the identity, and what an artefact may say.
 *
 * Pure: no clock of its own, no I/O, no Prisma. Everything here is a function of
 * its arguments, so an artefact emitted in August can be re-derived byte-for-byte
 * during the audit that reads it in March.
 *
 * ── THE IDENTITY, AND WHY IT IS NOT THE OBVIOUS ONE ────────────────────────
 *
 * An emitted artefact is identified by `(tenant, control, kind, period)`. The
 * two identities that suggest themselves first are both wrong, and they are
 * wrong in opposite directions:
 *
 *   • A RECEIPT ID gives one evidence row per agent action. That is not an
 *     artefact — it is a second copy of `AgentActionReceipt` with a wider read
 *     surface, growing without bound, in front of a human assessor who asked one
 *     question. Re-running is "safe" only because every row is new.
 *   • A CONTENT DIGEST makes re-running safe exactly while nothing changes.
 *     Receipts arrive continuously, so the first new receipt inside an open
 *     period moves the digest and the period acquires a SECOND artefact. That is
 *     duplication by construction, and two artefacts for one month that nobody
 *     can rank is worse than none.
 *   • `(control, kind, period)` is the unit the question is asked in — "show me
 *     your ASI02 evidence for August" — so re-running recomputes the same
 *     identity and UPDATES in place. The population digest survives as a FIELD,
 *     which is what keeps "did anything move" answerable without multiplying
 *     rows, and what lets a reader confirm two renderings of August describe the
 *     same set of records.
 *
 * ── WHAT AN ARTEFACT MUST NOT CONTAIN ──────────────────────────────────────
 *
 * `AiDecisionLog` stores a DIGEST of the model input rather than the prompt, and
 * a bounded sanitised summary rather than the output. `AgentActionReceipt`
 * stores a bounded, scrubbed `scannedSummary` rather than the mediated payload.
 * Both are deliberate, and `Evidence.content` is a strictly WIDER surface than
 * either: it is not in the field-encryption manifest, it is rendered into PDF
 * exports, and it is reachable through an audit-pack share link. An artefact that
 * inlined what those two excluded would move the excluded content to the place
 * with the largest blast radius and undo both decisions at once.
 *
 * That rule is enforced by the SHAPE of the inputs rather than by a reviewer
 * remembering it: `ReceiptFact` and `DecisionFact` below are the complete set of
 * fields an artefact may render, and neither carries `scannedSummary`,
 * `signature`, `inputDigest` or `outputSummary`. A future field that should not
 * be rendered is excluded by not being added here.
 *
 * What an artefact DOES carry is counts, closed vocabulary (verdicts, outcomes,
 * tool names from our own catalogue), the population digest, and the query that
 * reproduces the population. Pointers, not payload.
 */
import { createHash } from 'crypto';

import { canonicalJson } from '@/lib/canonical-json';

// ── Kinds ───────────────────────────────────────────────────────────────────

export const ARTEFACT_KIND_RECEIPTS = 'AGENT_ACTION_RECEIPTS';
export const ARTEFACT_KIND_DECISIONS = 'AI_DECISION_RECORDS';

export type AgenticArtefactKind =
    | typeof ARTEFACT_KIND_RECEIPTS
    | typeof ARTEFACT_KIND_DECISIONS;

/** Every kind, in emission order. Mirrors the DB CHECK on `kind`. */
export const AGENTIC_ARTEFACT_KINDS: readonly AgenticArtefactKind[] = [
    ARTEFACT_KIND_RECEIPTS,
    ARTEFACT_KIND_DECISIONS,
];

export type ArtefactWithdrawalReason = 'CONTROL_REMOVED' | 'SOURCE_UNVERIFIABLE';

// ── Which control does an artefact attach to ────────────────────────────────

/** The library urn both representations of the OWASP Agentic AI Top 10 carry. */
export const ASI_LIBRARY_URN = 'urn:inflect:library:owasp-agentic-top10';
/** The library urn both representations of the EU AI Act carry. */
export const EU_AI_ACT_LIBRARY_URN = 'urn:inflect:library:eu-ai-act';

/**
 * A framework requirement an artefact kind evidences, named by CODE within a
 * framework FAMILY.
 *
 * The family rather than the key, for the reason `usecases/agent-coverage.ts`
 * gives at length: every framework here exists in up to two `Framework` rows
 * with different `key` values (the seed's `OWASP-ASI`, the library's
 * `OWASP-ASI-TOP10`) and a tenant's controls hang off whichever one its database
 * happened to get. A single-key lookup would emit nothing for half the estate,
 * and the failure would look exactly like a tenant with no agentic controls.
 */
export interface EvidenceTarget {
    readonly kind: AgenticArtefactKind;
    /** `Framework.sourceUrn` — both representations carry it. */
    readonly familyUrn: string;
    /** `Framework.key`s that predate `sourceUrn` on the seeded row. */
    readonly legacyKeys: readonly string[];
    readonly requirementCode: string;
    /** Why this kind of record is evidence for this obligation. */
    readonly reason: string;
}

/**
 * The declared map from record kind to obligation. Small, explicit and reviewed,
 * rather than inferred: "which risk does this receipt evidence" is a compliance
 * judgement, and a heuristic that guessed it would put a claim in front of an
 * assessor that nobody had made.
 */
export const EVIDENCE_TARGETS: readonly EvidenceTarget[] = [
    {
        kind: ARTEFACT_KIND_RECEIPTS,
        familyUrn: ASI_LIBRARY_URN,
        legacyKeys: ['OWASP-ASI', 'OWASP-ASI-TOP10'],
        requirementCode: 'ASI02',
        reason:
            'Tool Misuse and Exploitation. A verified receipt is an independent ' +
            'mediator\'s signed record that a tool call was seen, policy-evaluated ' +
            'and given a verdict. The count of them per period, with the verdict ' +
            'breakdown, is the demonstrable answer to "is every tool call mediated".',
    },
    {
        kind: ARTEFACT_KIND_RECEIPTS,
        familyUrn: ASI_LIBRARY_URN,
        legacyKeys: ['OWASP-ASI', 'OWASP-ASI-TOP10'],
        requirementCode: 'ASI04',
        reason:
            'Agentic Supply Chain Vulnerabilities. Each receipt is stamped at ' +
            'ingest with the tool provenance in force, so the artefact can report ' +
            'how many of the period\'s actions ran under an attested definition ' +
            'and how many under an unattested one — which is the supply-chain ' +
            'question, asked about actions already taken.',
    },
    {
        kind: ARTEFACT_KIND_DECISIONS,
        familyUrn: ASI_LIBRARY_URN,
        legacyKeys: ['OWASP-ASI', 'OWASP-ASI-TOP10'],
        requirementCode: 'ASI09',
        reason:
            'Human-Agent Trust Exploitation. `AiDecisionLog.humanOutcome` records ' +
            'whether a person accepted, edited or rejected what the model produced. ' +
            'The accept-without-change rate over a period is the measurable form of ' +
            'automation bias, which is what this risk is about.',
    },
    {
        kind: ARTEFACT_KIND_DECISIONS,
        familyUrn: EU_AI_ACT_LIBRARY_URN,
        legacyKeys: ['EU-AI-ACT'],
        requirementCode: 'Art.12',
        reason:
            'EU AI Act Article 12 — record-keeping. The decision log IS the Art 12 ' +
            'record: one row per invocation, automatically generated over the ' +
            'lifetime of the system. The artefact is the periodic attestation that ' +
            'the records exist and how many there are.',
    },
];

/** The obligations one kind attaches to. */
export function targetsForKind(kind: AgenticArtefactKind): readonly EvidenceTarget[] {
    return EVIDENCE_TARGETS.filter((t) => t.kind === kind);
}

// ── Period ──────────────────────────────────────────────────────────────────

export interface ArtefactPeriod {
    /** Inclusive. */
    readonly start: Date;
    /** EXCLUSIVE — the first instant of the next period. */
    readonly end: Date;
    /** `2026-08` — the human-facing name, and part of the evidence title. */
    readonly label: string;
}

/**
 * The UTC calendar month containing `asOf`.
 *
 * The month CONTAINING the run, not the last COMPLETE one, and that is the
 * choice the identity is built to support: the current month's artefact is
 * refreshed on every tick and settles when the month ends, so an assessor
 * looking today sees today's evidence rather than last month's. With a
 * content-digest identity this would produce a new row per tick; with
 * `(control, kind, period)` it produces one row that keeps being told the truth.
 *
 * UTC, with no timezone parameter, for the reason the calendar-push schedule
 * records: a zoned boundary puts two firings 23h apart on the DST spring-forward
 * day, which can land in one bucket and silently skip a period.
 */
export function monthlyPeriod(asOf: Date): ArtefactPeriod {
    const y = asOf.getUTCFullYear();
    const m = asOf.getUTCMonth();
    const start = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0));
    const end = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0, 0));
    return { start, end, label: `${y}-${String(m + 1).padStart(2, '0')}` };
}

// ── Population digest ───────────────────────────────────────────────────────

/**
 * SHA-256 over the SORTED ids of the records an artefact counted, bound to the
 * kind and the period.
 *
 * Sorted because the database's row order is not a fact about the population:
 * two runs that read the same records in different orders describe the same
 * month and must digest identically, or every tick would look like a change.
 *
 * Bound to kind + period so a digest cannot be mistaken for one of a different
 * population that happens to hold the same ids.
 */
export function sourcePopulationDigest(
    kind: AgenticArtefactKind,
    periodStart: Date,
    ids: readonly string[],
): string {
    const payload = canonicalJson({
        kind,
        periodStart: periodStart.toISOString(),
        ids: [...ids].sort(),
    });
    return createHash('sha256').update(payload, 'utf8').digest('hex');
}

// ── The facts an artefact may render ────────────────────────────────────────

/**
 * The COMPLETE set of receipt fields an artefact may render.
 *
 * `scannedSummary` and `signature` are absent deliberately — see the module
 * header. Widening this interface is the decision to publish another field into
 * `Evidence.content`, and it should be made on purpose.
 */
export interface ReceiptFact {
    readonly id: string;
    readonly toolName: string;
    readonly decisionVerdict: string;
    readonly verified: boolean;
    readonly auditLogId: string | null;
    readonly toolProvenance: string | null;
}

/**
 * The COMPLETE set of decision-log fields an artefact may render.
 *
 * `inputDigest` and `outputSummary` are absent deliberately. The digest is not
 * content, but it is a lookup oracle over a low-entropy input space, and the
 * summary is a best-effort sanitisation of model output — neither belongs on a
 * surface that leaves the product.
 */
export interface DecisionFact {
    readonly id: string;
    readonly feature: string;
    readonly provider: string;
    readonly guardVerdict: string | null;
    readonly humanOutcome: string;
}

export interface ArtefactBody {
    readonly title: string;
    readonly content: string;
}

/** How many distinct vocabulary values a breakdown will name before summarising. */
const BREAKDOWN_CAP = 40;

/** `a: 3 · b: 1`, sorted by descending count then name. Bounded. */
function tally(values: readonly string[]): string {
    if (values.length === 0) return '(none)';
    const counts = new Map<string, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const shown = sorted.slice(0, BREAKDOWN_CAP).map(([k, n]) => `${k}: ${n}`);
    if (sorted.length > BREAKDOWN_CAP) {
        shown.push(`(+${sorted.length - BREAKDOWN_CAP} further values)`);
    }
    return shown.join(' · ');
}

/**
 * The paragraph that says what is deliberately absent.
 *
 * It is in the artefact rather than only in a design doc because the reader of
 * an evidence artefact is an assessor, and "these counts are not accompanied by
 * the underlying prompts" is a fact about the control's design that they should
 * be told at the point they notice the absence — otherwise the honest answer
 * looks like an incomplete export.
 */
const REDACTION_CONTRACT =
    'REDACTION CONTRACT — this artefact is a non-repudiation record, not a payload ' +
    'export. It deliberately carries no prompts, no model outputs, no mediated ' +
    'request or response bodies, no signature material and no input digests. The ' +
    'underlying records hold a digest and a bounded, scrubbed summary in place of ' +
    'each of those, by design; re-publishing them here would move the excluded ' +
    'content onto a wider surface (PDF export, audit-pack share link) and defeat ' +
    'that design. The population is addressable by tenant, kind and period through ' +
    'the authorised read paths, and the receipt export endpoint returns each ' +
    'receipt\'s signature for independent verification.';

/** The artefact for one period of agent-action receipts. */
export function buildReceiptArtefact(
    period: ArtefactPeriod,
    facts: readonly ReceiptFact[],
    digest: string,
): ArtefactBody {
    const linked = facts.filter((f) => f.verified && f.auditLogId !== null);
    const unverified = facts.filter((f) => !f.verified);
    const verifiedButUnlinked = facts.filter((f) => f.verified && f.auditLogId === null);

    const lines = [
        `Period: ${period.label} (${period.start.toISOString()} .. ${period.end.toISOString()}, end exclusive)`,
        `Mediated agent actions recorded: ${facts.length}`,
        `  verified and linked to the hash-chained audit trail: ${linked.length}`,
        `  verified but not linked: ${verifiedButUnlinked.length}`,
        `  signature did not verify (recorded, flagged, never trusted): ${unverified.length}`,
        '',
        `Decision verdicts — ${tally(facts.map((f) => f.decisionVerdict))}`,
        `Tools exercised — ${tally(facts.map((f) => f.toolName))}`,
        `Tool provenance at the time of the action — ${tally(
            facts.map((f) => f.toolProvenance ?? 'unrecorded'),
        )}`,
        '',
        `Population digest (SHA-256 over the sorted record ids): ${digest}`,
        '',
        REDACTION_CONTRACT,
    ];
    return {
        title: `Agent action receipts — ${period.label}`,
        content: lines.join('\n'),
    };
}

/** The artefact for one period of AI decision records (EU AI Act Art 12). */
export function buildDecisionArtefact(
    period: ArtefactPeriod,
    facts: readonly DecisionFact[],
    digest: string,
): ArtefactBody {
    const pending = facts.filter((f) => f.humanOutcome === 'PENDING');
    const reviewed = facts.length - pending.length;

    const lines = [
        `Period: ${period.label} (${period.start.toISOString()} .. ${period.end.toISOString()}, end exclusive)`,
        `AI invocations recorded (EU AI Act Art 12 automatic record-keeping): ${facts.length}`,
        `  reached a human-oversight outcome (Art 14): ${reviewed}`,
        `  still pending review: ${pending.length}`,
        '',
        `Features — ${tally(facts.map((f) => f.feature))}`,
        `Providers — ${tally(facts.map((f) => f.provider))}`,
        `Output-guard verdicts — ${tally(facts.map((f) => f.guardVerdict ?? 'none'))}`,
        `Human outcomes — ${tally(facts.map((f) => f.humanOutcome))}`,
        '',
        `Population digest (SHA-256 over the sorted record ids): ${digest}`,
        '',
        REDACTION_CONTRACT,
    ];
    return {
        title: `AI decision records (EU AI Act Art 12) — ${period.label}`,
        content: lines.join('\n'),
    };
}

/**
 * The body an artefact is given when its basis stops holding.
 *
 * The row is not deleted and the counts are not left standing. Deleting destroys
 * something an audit pack may already cite — the shape of evidence tampering —
 * and leaving the counts lets a control go on claiming coverage it no longer
 * has. Replacing the counts with a dated notice is the only option that is
 * neither.
 */
export function buildWithdrawalNotice(
    period: ArtefactPeriod,
    reason: ArtefactWithdrawalReason,
    at: Date,
    supersededDigest: string,
): string {
    const because =
        reason === 'CONTROL_REMOVED'
            ? 'The control this artefact discharged has been removed from the tenant, so ' +
              'nothing re-computes it. The artefact is retained because it was true when ' +
              'written and may already be cited.'
            : 'One or more of the records this artefact counted can no longer be verified, ' +
              'so the counts below it are no longer supportable. The artefact is retained ' +
              'because deleting evidence on the discovery of a problem is the shape of the ' +
              'problem.';
    return [
        `WITHDRAWN ${at.toISOString()} — ${reason}`,
        '',
        because,
        '',
        `Period: ${period.label}`,
        `Superseded population digest: ${supersededDigest}`,
        '',
        'This notice replaces the counts it withdrew. The underlying records are ' +
            'unchanged and remain readable through their own surfaces.',
    ].join('\n');
}
