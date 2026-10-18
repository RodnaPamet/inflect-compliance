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
 * remembering it: `ReceiptFact`, `DecisionFact` and `HarnessScanFact` below are
 * the complete set of fields an artefact may render, and none carries
 * `scannedSummary`, `signature`, `inputDigest` or `outputSummary`. A future
 * field that should not be rendered is excluded by not being added here.
 *
 * What an artefact DOES carry is counts, closed vocabulary (verdicts, outcomes,
 * tool names from our own catalogue), the population digest, and the query that
 * reproduces the population. Pointers, not payload.
 *
 * ── THE HARNESS KIND (#3687) ───────────────────────────────────────────────
 *
 * A month of verified harness scans is the third kind, and it differs from the
 * other two in one way that matters: its population can be INCOMPLETE, and
 * zero is never complete. A receipt either exists or it does not; a scan
 * describes an agent population that its sources may not have been read in
 * full, or that it found empty. So this kind alone carries a COMPLETENESS, and
 * the completeness decides the Evidence status — `APPROVED` only when every
 * scanner's latest scan of the month read all of its sources and found at least
 * one agent, AND every scanner that held a trusted key in the month reported
 * at all; `NEEDS_REVIEW` otherwise. An incomplete month is emitted as what it
 * is, with the reasons stated, never as complete evidence.
 *
 * `HarnessScanFact` deliberately carries no owner reference from any source, no
 * user identifier, no acceptance justification, no verdict evidence pointer, no
 * credential reference, no tool server address and no agent name (DPIA
 * condition 8: this is the widest surface a scan's data could reach).
 * Identifiers, levels, counts and completeness only. The harness level is
 * REPORTED here and gates nothing — the ladder is report-only.
 */
import { createHash } from 'crypto';

import { canonicalJson } from '@/lib/canonical-json';
import { HARNESS_LEVELS, type HarnessLevel } from './harness-ladder';
import type { HarnessScanCompleteness, HarnessStoredReach } from './harness-read-model';

// ── Kinds ───────────────────────────────────────────────────────────────────

export const ARTEFACT_KIND_RECEIPTS = 'AGENT_ACTION_RECEIPTS';
export const ARTEFACT_KIND_DECISIONS = 'AI_DECISION_RECORDS';
export const ARTEFACT_KIND_HARNESS_SCANS = 'AGENT_HARNESS_SCANS';

export type AgenticArtefactKind =
    | typeof ARTEFACT_KIND_RECEIPTS
    | typeof ARTEFACT_KIND_DECISIONS
    | typeof ARTEFACT_KIND_HARNESS_SCANS;

/**
 * Every kind, in emission order. Mirrors the DB CHECK on `kind`, which
 * migration 20261017235500 widened to the third; a kind added here without
 * widening the CHECK fails on its first write, and the integration suite pins
 * that every kind listed here is one the CHECK accepts.
 */
export const AGENTIC_ARTEFACT_KINDS: readonly AgenticArtefactKind[] = [
    ARTEFACT_KIND_RECEIPTS,
    ARTEFACT_KIND_DECISIONS,
    ARTEFACT_KIND_HARNESS_SCANS,
];

export type ArtefactWithdrawalReason =
    | 'CONTROL_REMOVED'
    | 'SOURCE_UNVERIFIABLE'
    /**
     * The control still exists, but it no longer discharges this obligation —
     * its `ControlRequirementLink` was removed, or the framework was uninstalled.
     *
     * A separate reason from `CONTROL_REMOVED` because the two are different
     * facts and an assessor reading the notice needs to know which: the control
     * is gone, versus the control is still there and no longer claims this.
     */
    | 'OBLIGATION_UNMAPPED';

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
    {
        kind: ARTEFACT_KIND_HARNESS_SCANS,
        familyUrn: ASI_LIBRARY_URN,
        legacyKeys: ['OWASP-ASI', 'OWASP-ASI-TOP10'],
        requirementCode: 'ASI10',
        reason:
            'Rogue Agents — agents operating outside the sanctioned inventory. A ' +
            'verified harness scan reconciles every agent-shaped principal its ' +
            'sources hold against the agent register; the period artefact states ' +
            'which scans ran, whether each read its sources in full, how many ' +
            'agents each found and how many are not in the register.',
    },
    {
        kind: ARTEFACT_KIND_HARNESS_SCANS,
        familyUrn: ASI_LIBRARY_URN,
        legacyKeys: ['OWASP-ASI', 'OWASP-ASI-TOP10'],
        requirementCode: 'ASI03',
        reason:
            'Identity and Privilege Abuse — agent identities and credentials that ' +
            'exceed what the task needs, or that no accountable principal answers ' +
            'for. Each scan scores every agent against the harness ladder (owner, ' +
            'bound credential, declared grant kind, audience-scoped tokens); the ' +
            'artefact reports the level and reach tallies and how many agents sit ' +
            'below the report-only bar.',
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
    facts: readonly (ReceiptFact | DecisionFact | HarnessScanFact | HarnessBoundsFact | HarnessSilentScannersFact)[],
): string {
    // THE RENDERED FACTS, not the population.
    //
    // This digested ids alone, and the `unchanged` branch it drives skips
    // rewriting `Evidence.content`. But the body renders fields that MUTATE
    // after the row is written — `AiDecisionLog.humanOutcome` is stamped
    // PENDING → terminal by the real Art 14 feedback path, and a receipt's
    // `verified` / `auditLogId` are set when its signature is checked. The id
    // set does not change when they do, so the digest did not change, so the
    // body was never rewritten while `lastEmittedAt` advanced and made it look
    // freshly emitted.
    //
    // The consequence was the exact opposite of this artefact's purpose: with a
    // daily tick, the first tick of a month captures nearly everything as
    // PENDING, and the Art 12 / ASI09 record then says PERMANENTLY that nobody
    // reviewed anything — while the accept-without-change rate, which is the
    // measurable form of automation bias, is the number frozen.
    //
    // Digesting every rendered field makes "has the body changed" the question
    // the branch actually asks. Sorted by the canonical form of each fact so the
    // digest does not depend on row order.
    const payload = canonicalJson({
        kind,
        periodStart: periodStart.toISOString(),
        facts: facts.map((f) => canonicalJson({ ...f })).sort(),
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

/** One source of a scan, re-validated from the stored record (closed vocabulary). */
export interface HarnessSourceFact {
    readonly kind: string;
    readonly status: string;
    readonly rows: number;
    readonly reason: string | null;
}

/**
 * The tallies over one scan's agents. All six levels and all three reaches are
 * always present, zeros included: a level with no agents is a fact an assessor
 * reads, and a missing key reads as a level the product does not have.
 */
export interface HarnessTallies {
    readonly levels: Readonly<Record<HarnessLevel, number>>;
    readonly reach: Readonly<Record<HarnessStoredReach, number>>;
    /** Below the report-only bar for its reach. Reported; it gates nothing. */
    readonly belowBar: number;
    /** Not linked to a live register row AS OF THE EMISSION (unregistered, or its register row deleted). */
    readonly notInRegister: number;
}

/**
 * The COMPLETE set of fields a harness artefact may render about one scan.
 *
 * Absent by shape, and each absence is a decision (DPIA condition 8):
 * `DiscoveredAgent.ownerRef` / `ownerKind` and every user id (acceptor,
 * revoker, key registrant, register owner); the acceptance justification; the
 * verdicts' evidence pointers; tool server addresses; credential references;
 * the discovered ids and register names of the agents; and the report
 * signature. `scanRef` and `scannerVersion` are scanner-chosen strings and
 * arrive sanitised and bounded.
 */
export interface HarnessScanFact {
    readonly id: string;
    readonly scanRef: string;
    readonly scannerAgentId: string;
    readonly scannerVersion: string;
    /** ISO instant — the moment the report describes, which orders scans. */
    readonly asOf: string;
    readonly reportDigest: string;
    /** This is its scanner's latest scan in the period (by `asOf`). */
    readonly latestForScanner: boolean;
    readonly completeness: HarnessScanCompleteness;
    /** `null` = the stored sources failed re-validation (the scan reads as INCOMPLETE). */
    readonly sources: readonly HarnessSourceFact[] | null;
    readonly agentCount: number;
    /**
     * Set only for a scanner's latest scan, and only when every one of its
     * stored items was read and they agree with `agentCount`. `null` on a
     * latest scan makes the artefact INCOMPLETE — a count the emitter could not
     * vouch for is not stated as one.
     */
    readonly tallies: HarnessTallies | null;
}

/** The bounds the emitter applied. Digested with the scans, so a bound tripping rewrites the body. */
export interface HarnessBoundsFact {
    readonly bounds: true;
    /** More scans fell in the period than the emitter reads. */
    readonly scansTruncated: boolean;
    /** The latest scans' agents exceed what the emitter tallies; every tally is withheld. */
    readonly tallyTruncated: boolean;
    /** More scanners reported in the period than the emitter tallies. */
    readonly scannersTruncated: boolean;
}

/**
 * The scanners that held a TRUSTED key at some moment of the period and
 * reported no scan in it. A scanner that goes silent is the gap no scan can
 * describe: the scans that did arrive say nothing about the sources the silent
 * one reads, so each id here makes the month INCOMPLETE. Digested with the
 * scans, so a scanner going silent (or reporting again) rewrites the body.
 */
export interface HarnessSilentScannersFact {
    readonly silentScanners: true;
    /** Register ids of the silent scanners, sorted. */
    readonly agentIds: readonly string[];
    /** More key holders than the emitter reads, so a silent scanner may go unnamed. */
    readonly truncated: boolean;
}

export interface HarnessPeriodFacts {
    readonly scans: readonly HarnessScanFact[];
    readonly bounds: HarnessBoundsFact;
    readonly silent: HarnessSilentScannersFact;
}

/**
 * Every fact a harness artefact's digest covers, in one place, so the emitter
 * and anything that recomputes the digest cannot disagree about what "the body
 * changed" means.
 */
export function harnessDigestFacts(
    facts: HarnessPeriodFacts,
): readonly (HarnessScanFact | HarnessBoundsFact | HarnessSilentScannersFact)[] {
    return [...facts.scans, facts.bounds, facts.silent];
}

/** How many scanners' latest scans one artefact tallies. Shared with the emitter, which reads to this bound. */
export const HARNESS_SCANNER_CAP = 20;
/** How many scans the per-scan list names before summarising. */
const HARNESS_SCAN_LINE_CAP = 50;

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
    // ── THREE BUCKETS, BECAUSE THERE ARE THREE ANSWERS (#2861) ──────────────
    //
    // `reviewed` was `facts.length - pending.length`, i.e. "everything that is
    // not PENDING reached a human". That subtraction was exact while every
    // non-PENDING value was a review verdict, and it became a FALSE CLAIM the
    // moment `AiHumanOutcome.AUTONOMOUS` existed: the external-write ladder's
    // `AUTOMATIC` rung writes rows that reached nobody, and the subtraction
    // would have counted each of them as an Art 14 outcome — on the artefact an
    // assessor reads precisely to ask how much was human-supervised.
    //
    // Named rather than subtracted now, so a future member of the enum lands in
    // neither bucket and shows up as the arithmetic not adding to the total,
    // instead of silently inflating whichever side the subtraction favours.
    const autonomous = facts.filter((f) => f.humanOutcome === 'AUTONOMOUS');
    // A POSITIVE LIST, not `!== 'PENDING' && !== 'AUTONOMOUS'`. The negation was
    // written first and it has the same flaw as the subtraction it replaced,
    // one step smaller: it ABSORBS every future enum member into "a human
    // reviewed this", so `unaccounted` below could never be non-zero and the
    // whole unclassified branch was unreachable. The two spellings differ only
    // in which way they fail when `AiHumanOutcome` grows — a negation counts the
    // unknown value as supervision, a list leaves it visibly uncounted, and
    // uncounted is the half an assessor can act on.
    const REVIEW_VERDICTS = ['ACCEPTED', 'EDITED', 'REJECTED'];
    const reviewed = facts.filter((f) => REVIEW_VERDICTS.includes(f.humanOutcome));
    const unaccounted = facts.length - pending.length - autonomous.length - reviewed.length;

    const lines = [
        `Period: ${period.label} (${period.start.toISOString()} .. ${period.end.toISOString()}, end exclusive)`,
        `AI invocations recorded (EU AI Act Art 12 automatic record-keeping): ${facts.length}`,
        `  reached a human-oversight outcome (Art 14): ${reviewed.length}`,
        `  still pending review: ${pending.length}`,
        // STATED EVEN WHEN ZERO. "No unattended decisions this period" is a
        // finding; a line that disappears when the count is nil reads as a
        // feature the product does not have.
        `  dispatched autonomously, with no human review by design: ${autonomous.length}`,
        // Printed only when it is non-zero, and non-zero means this function
        // has met a `humanOutcome` it has no bucket for — which is a defect in
        // THIS file, so it says so rather than quietly rounding.
        ...(unaccounted === 0
            ? []
            : [
                  `  NOT CLASSIFIED by this artefact (${unaccounted}) — the decision log holds an `
                  + 'outcome this report does not know how to count. Treat the three counts above '
                  + 'as incomplete and see "Human outcomes" below for the raw tally.',
              ]),
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

// ── Harness scans (#3687) ───────────────────────────────────────────────────

export type HarnessArtefactCompleteness = 'COMPLETE' | 'INCOMPLETE' | 'NO_SCAN';

/** Newest first by `asOf`, then by id, so the body does not depend on row order. */
function byAsOfDesc(a: HarnessScanFact, b: HarnessScanFact): number {
    if (a.asOf !== b.asOf) return a.asOf < b.asOf ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Every reason the period's facts fall short of complete evidence, in a fixed
 * order. Empty means COMPLETE — the completeness below is DERIVED from this
 * list, so an INCOMPLETE artefact can never be emitted without saying why.
 */
export function harnessIncompleteReasons(facts: HarnessPeriodFacts): string[] {
    const reasons: string[] = [];
    if (facts.bounds.scansTruncated) {
        reasons.push('more scans fell in the period than the emitter reads, so the newest were read and the rest were not');
    }
    if (facts.bounds.scannersTruncated) {
        reasons.push(`more than ${HARNESS_SCANNER_CAP} scanners reported in the period, so not every scanner is tallied`);
    }
    if (facts.bounds.tallyTruncated) {
        reasons.push('the latest scans hold more agents than the emitter tallies, so every tally is withheld');
    }
    if (facts.silent.truncated) {
        reasons.push('more scanners held a trusted key in the period than the emitter reads, so a scanner that reported nothing may not be named here');
    }
    for (const id of facts.silent.agentIds) {
        // A scanner that sent nothing is not a scanner that found nothing: the
        // sources it reads went unread for the whole period.
        reasons.push(`scanner ${id} held a trusted key in the period but reported no scan in it, so the sources it reads are unevidenced`);
    }
    const latest = facts.scans.filter((s) => s.latestForScanner).sort(byAsOfDesc);
    if (facts.scans.length > 0 && latest.length === 0) {
        reasons.push('no scan in the period is marked as its scanner\'s latest, so none can speak for the estate');
    }
    for (const s of latest) {
        // EACH scanner's LATEST scan, not the first or the best: an older
        // complete scan says nothing about the estate after the scanner's
        // newest one stopped short, and a second scanner's complete scan says
        // nothing about the sources the first one reads.
        if (s.completeness === 'EMPTY') {
            reasons.push(`scanner ${s.scannerAgentId}'s latest scan (${s.scanRef}) found no agent — an empty population evidences nothing`);
        } else if (s.completeness !== 'COMPLETE') {
            reasons.push(`scanner ${s.scannerAgentId}'s latest scan (${s.scanRef}) did not read all of its sources in full`);
        } else if (s.tallies === null && !facts.bounds.tallyTruncated && !facts.bounds.scannersTruncated) {
            reasons.push(`scanner ${s.scannerAgentId}'s latest scan (${s.scanRef}) could not be tallied from its stored agents`);
        }
    }
    return reasons;
}

/**
 * The artefact's completeness. `NO_SCAN` for a period with no scan at all:
 * a month in which nothing looked for agents is not a month with no agents,
 * so it is its own answer rather than a zero.
 */
export function harnessArtefactCompleteness(facts: HarnessPeriodFacts): HarnessArtefactCompleteness {
    if (facts.scans.length === 0 && !facts.bounds.scansTruncated) return 'NO_SCAN';
    return harnessIncompleteReasons(facts).length === 0 ? 'COMPLETE' : 'INCOMPLETE';
}

/**
 * The Evidence status a harness artefact's completeness calls for. Only a
 * COMPLETE month is `APPROVED`, which is what makes it count toward coverage
 * (`coverageQualifyingEvidenceWhere`); anything else is `NEEDS_REVIEW`, the
 * product's existing out-of-band demotion. The level never enters this: the
 * ladder is report-only, so an estate full of H0 agents read in full is
 * COMPLETE evidence of exactly that.
 *
 * This is the PLAN, not what is written over the row — see
 * `harnessStatusCorrection` for which of the two wins.
 */
export function harnessArtefactEvidenceStatus(c: HarnessArtefactCompleteness): 'APPROVED' | 'NEEDS_REVIEW' {
    return c === 'COMPLETE' ? 'APPROVED' : 'NEEDS_REVIEW';
}

export type HarnessPlannedStatus = 'APPROVED' | 'NEEDS_REVIEW';

/**
 * Whether the emitter rewrites a harness artefact's Evidence status, and to
 * what — `null` to leave the status a person (or another job) set.
 *
 * ONE-DIRECTIONAL BY DESIGN. The completeness claim is the emitter's, the review
 * decision is a person's, and the two meet on one column:
 *
 *   • DEMOTION ALWAYS WINS. An incomplete month (`planned` NEEDS_REVIEW) whose
 *     Evidence reads APPROVED — approved by hand, or approved by this emitter
 *     before a later scan fell short — is put back, because APPROVED is what
 *     counts toward coverage and an incomplete month must never count. This is
 *     the only status the emitter overrides a person on, and it is the unsafe
 *     direction only.
 *   • PROMOTION IS UNDOING ITS OWN DEMOTION, nothing else. A month that has
 *     become complete is raised from NEEDS_REVIEW to APPROVED only when the
 *     previous plan was NEEDS_REVIEW too — i.e. the NEEDS_REVIEW is the
 *     emitter's own incompleteness verdict. A NEEDS_REVIEW the stale-review
 *     sweep set on a month that was already complete is the sweep's, and
 *     re-approving it would flip the row every morning the two jobs run.
 *   • A REVIEW DECISION STANDS. SUBMITTED, REJECTED and DRAFT are never
 *     rewritten: none of them counts toward coverage, so leaving them is safe,
 *     and overwriting REJECTED with APPROVED would skip the reviewer and the
 *     segregation-of-duties check the review flow holds.
 *
 * A person may re-submit an incomplete month through the ordinary review flow
 * — to record why it is short, say — but an approval of it does not stand:
 * the way to an APPROVED month is a complete scan.
 */
export function harnessStatusCorrection(input: {
    readonly planned: HarnessPlannedStatus;
    readonly current: string;
    readonly previousPlanned: HarnessPlannedStatus | null;
}): HarnessPlannedStatus | null {
    if (input.planned === 'NEEDS_REVIEW' && input.current === 'APPROVED') return 'NEEDS_REVIEW';
    if (input.planned === 'APPROVED' && input.current === 'NEEDS_REVIEW' && input.previousPlanned === 'NEEDS_REVIEW') {
        return 'APPROVED';
    }
    return null;
}

/**
 * What a harness artefact deliberately omits. In the artefact because the
 * reader is an assessor, and "these counts name no agent and no owner" should
 * reach them where they notice the absence, not only in a design document.
 */
const HARNESS_REDACTION_CONTRACT =
    'REDACTION CONTRACT — this artefact reports identifiers, levels, counts and ' +
    'completeness only. It deliberately carries no owner reference from any source, ' +
    'no user identifier, no acceptance justification, no evidence pointer, no ' +
    'credential reference, no tool server address and no agent name: the text is ' +
    'rendered into PDF exports and reachable through an audit-pack share link, so ' +
    'it is the widest surface a scan\'s data could reach. Each scan is re-verifiable ' +
    'from its stored report digest and signature, and the agents behind these ' +
    'counts are listed, to holders of the agent-register right, on the harness ' +
    'matrix of the agent reports page. Harness levels are reported here and gate ' +
    'nothing: the ladder is report-only.';

const COMPLETENESS_LINE: Readonly<Record<HarnessScanCompleteness, string>> = {
    COMPLETE: 'COMPLETE — every source read in full, at least one agent found',
    INCOMPLETE: 'INCOMPLETE — a source was not read in full, or its stored record is unreadable',
    EMPTY: 'EMPTY — no agent found; an empty population evidences nothing',
};

function sourcesLine(sources: HarnessScanFact['sources']): string {
    if (sources === null) return 'stored sources unreadable — the scan is treated as incomplete';
    return sources
        .map((s) =>
            s.status === 'COMPLETE'
                ? `${s.kind}: COMPLETE (${s.rows} rows)`
                : `${s.kind}: ${s.status} — ${s.reason ?? 'no reason recorded'} (${s.rows} rows)`,
        )
        .join(' · ');
}

function scannerBlock(s: HarnessScanFact): string[] {
    const lines = [
        `Scanner ${s.scannerAgentId} — scan ${s.scanRef}, as of ${s.asOf}, scanner version ${s.scannerVersion}, report digest ${s.reportDigest}`,
        `  Completeness: ${COMPLETENESS_LINE[s.completeness]}`,
        `  Sources — ${sourcesLine(s.sources)}`,
    ];
    if (s.tallies === null) {
        lines.push(`  Agents: ${s.agentCount} · tallies withheld — the emitter could not read every stored agent of this scan`);
        return lines;
    }
    const t = s.tallies;
    lines.push(
        `  Agents: ${s.agentCount} · by level — ${HARNESS_LEVELS.map((l) => `${l}: ${t.levels[l]}`).join(' · ')}`,
        `  Reach — READ_ONLY: ${t.reach.READ_ONLY} · WRITE_OR_EXTERNAL: ${t.reach.WRITE_OR_EXTERNAL} · UNKNOWN: ${t.reach.UNKNOWN}`,
        `  Below the report-only bar: ${t.belowBar} · Not in the agent register as of this emission: ${t.notInRegister}`,
    );
    return lines;
}

/** The artefact for one period of verified harness scans. */
export function buildHarnessScanArtefact(
    period: ArtefactPeriod,
    facts: HarnessPeriodFacts,
    digest: string,
): ArtefactBody & { readonly completeness: HarnessArtefactCompleteness } {
    const completeness = harnessArtefactCompleteness(facts);
    const reasons = harnessIncompleteReasons(facts);
    const scans = [...facts.scans].sort(byAsOfDesc);
    const latest = scans.filter((s) => s.latestForScanner);
    const count = (c: HarnessScanCompleteness) => scans.filter((s) => s.completeness === c).length;

    const completenessLine =
        completeness === 'COMPLETE'
            ? 'Artefact completeness: COMPLETE — every scanner\'s latest scan in the period read all of its sources in full and found at least one agent'
            : completeness === 'NO_SCAN'
            ? `Artefact completeness: NO SCAN RECEIVED — the agent inventory is UNEVIDENCED for ${period.label}; a period with no scan is not a period with no agents`
            : `Artefact completeness: INCOMPLETE — ${reasons.join('; ')}`;

    const lines = [
        `Period: ${period.label} (${period.start.toISOString()} .. ${period.end.toISOString()}, end exclusive)`,
        completenessLine,
        `Harness scans described in the period: ${scans.length} (complete and non-empty: ${count('COMPLETE')} · incomplete: ${count('INCOMPLETE')} · empty: ${count('EMPTY')})`,
    ];
    if (facts.silent.agentIds.length > 0) {
        lines.push(
            `Scanners that held a trusted key in the period and reported no scan: ${facts.silent.agentIds.join(', ')}`,
        );
    }

    if (latest.length > 0) {
        lines.push('', 'The latest scan of each scanner in the period:');
        for (const s of latest.slice(0, HARNESS_SCANNER_CAP)) lines.push(...scannerBlock(s));
        if (latest.length > HARNESS_SCANNER_CAP) {
            lines.push(`(+${latest.length - HARNESS_SCANNER_CAP} further scanners, listed below and not tallied)`);
        }
    }

    if (scans.length > 0) {
        lines.push('', 'Every scan in the period:');
        for (const s of scans.slice(0, HARNESS_SCAN_LINE_CAP)) {
            lines.push(`  ${s.asOf} · ${s.scanRef} · scanner ${s.scannerAgentId} · ${s.completeness} · ${s.agentCount} agents`);
        }
        if (scans.length > HARNESS_SCAN_LINE_CAP) {
            lines.push(`  (+${scans.length - HARNESS_SCAN_LINE_CAP} further scans, counted above)`);
        }
    }

    const bounded = [
        facts.bounds.scansTruncated ? 'scans' : null,
        facts.bounds.scannersTruncated ? 'scanners' : null,
        facts.bounds.tallyTruncated ? 'agent tallies' : null,
    ].filter((b): b is string => b !== null);
    if (bounded.length > 0) {
        lines.push('', `BOUNDED: the emitter stopped reading at its bound for ${bounded.join(', ')}; the counts above describe what was read, not the whole period.`);
    }

    lines.push(
        '',
        `Population digest (SHA-256 over the rendered scan facts): ${digest}`,
        '',
        HARNESS_REDACTION_CONTRACT,
    );

    const suffix =
        completeness === 'COMPLETE' ? '' : completeness === 'NO_SCAN' ? ' — NO SCAN RECEIVED' : ' — INCOMPLETE';
    return {
        title: `Agent harness scans — ${period.label}${suffix}`,
        content: lines.join('\n'),
        completeness,
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
            : reason === 'OBLIGATION_UNMAPPED'
            ? 'The control still exists, but it no longer discharges this obligation — the ' +
              'requirement link was removed or the framework was uninstalled — so nothing ' +
              're-computes this artefact. It is retained because it was true when written ' +
              'and may already be cited.'
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
