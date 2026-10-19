/**
 * A STALE ESTATE RAISES A FINDING (#3741, the alerting follow-up of step 4a) —
 * a pure planner.
 *
 * Owner decision, 2026-10-19: a stale estate must alert, not only show on the
 * health card. A scanner that has gone quiet is a monitoring gap, and "fail
 * closed, never silently" applies to it as to everything else in the harness.
 * `usecases/agent-harness-estate-staleness.ts` runs this daily per tenant and
 * executes the plan; nothing here touches a database or a clock.
 *
 * ── ONE RULE, AND IT IS NOT HERE ────────────────────────────────────────────
 *
 * Whether an estate is stale is `computeEstateHealth`'s answer, the same
 * function the health card runs. This module takes its rows and never
 * re-derives a status, a threshold or a completeness: it decides only what a
 * row means for the estate's finding.
 * `tests/unit/agentic/harness-estate-alert-uses-the-health-rule.test.ts` holds
 * that.
 *
 * ── ONE FINDING PER ESTATE ──────────────────────────────────────────────────
 *
 *   STALE_ESTATE:<estateId>     in the harness's own key space
 *                               (`sourceKind = AGENT_HARNESS`)
 *
 * A stale estate with no finding opens one; one whose finding was CLOSED
 * reopens THAT finding; one whose finding is still open is left alone. So a
 * second run, and every run while the estate stays stale, opens nothing.
 *
 * ── IT CLOSES ONLY WHEN A COMPLETE SCAN ARRIVES ─────────────────────────────
 *
 * A finding closes on positive evidence, as everywhere else in the harness,
 * and the evidence is a scan, never the declaration it is measured against.
 * Two ways an estate can stop being stale without a scan arriving, and both
 * are refused:
 *
 *   • AN EDIT. Raising the cadence widens the window around a scan that was
 *     already too old; dropping a declared source makes an older scan
 *     complete for what is left. Either turns the health row FRESH with no new
 *     evidence. So the scan that makes it fresh must have ARRIVED after the
 *     declaration last changed (`declarationChangedAt`: the estate row or any
 *     of its source rows, which an edit replaces as a set). Otherwise the
 *     finding is HELD, `FRESH_ONLY_BY_DECLARATION_CHANGE`, until one does.
 *   • A DELETION. A removed estate is not evaluated at all, so its finding is
 *     HELD, `ESTATE_NOT_DECLARED`, and stays open for a person to close. A
 *     monitoring gap that was declared away is still a gap until somebody says
 *     why it is not.
 *
 * Without an edit, time alone cannot turn a STALE row FRESH — the window only
 * moves forward — so a row that is FRESH and whose last complete scan arrived
 * after the last edit is exactly "a complete scan arrived".
 *
 * PURE: no clock, no I/O.
 */
import { HARNESS_FINDING_SOURCE_KIND } from './harness-findings';
import { freshnessWindowStart, type EstateHealthRow, type EstateSourceHealth } from './harness-estate-health';

/** `Finding.sourceKind` of a stale-estate finding: the harness's own key space. */
export const STALE_ESTATE_FINDING_SOURCE_KIND = HARNESS_FINDING_SOURCE_KIND;

/** The finding code, and the prefix of its `sourceRef`. Not one the ingest's planner emits. */
export const STALE_ESTATE_CODE = 'STALE_ESTATE';
export const STALE_ESTATE_REF_PREFIX = `${STALE_ESTATE_CODE}:`;

/** `IntegrationExecution.automationKey` for a staleness-pass row. */
export const ESTATE_STALENESS_AUTOMATION_KEY = 'agentic.harness_estate_staleness';

/** Estates one execution row describes before it says it was truncated. */
export const MAX_REPORTED_ESTATES = 200;

export function staleEstateRefOf(estateId: string): string {
    return `${STALE_ESTATE_REF_PREFIX}${estateId}`;
}

/** The estate a stale-estate finding names, or null when the ref is not one. */
export function estateIdOfStaleRef(sourceRef: string | null): string | null {
    if (!sourceRef?.startsWith(STALE_ESTATE_REF_PREFIX)) return null;
    const id = sourceRef.slice(STALE_ESTATE_REF_PREFIX.length);
    return id.length > 0 ? id : null;
}

/**
 * Why a STALE row is stale, as the operator would act on it. Read off the
 * row; never a second judgement of staleness.
 *
 *   SCANNER_NOT_LIVE   the scanner is retired or gone from the register, so
 *                      the ingest refuses its reports: waiting will not help
 *   NO_SCAN_IN_WINDOW  nothing reported within the window: a silent scanner
 *   NO_COMPLETE_SCAN   it reported, but no scan read every declared source in
 *                      full with at least one row
 */
export const ESTATE_STALE_REASONS = ['SCANNER_NOT_LIVE', 'NO_SCAN_IN_WINDOW', 'NO_COMPLETE_SCAN'] as const;
export type EstateStaleReason = (typeof ESTATE_STALE_REASONS)[number];

/**
 * `null` for a FRESH row. Whether the latest scan is inside the window is the
 * health module's window (`freshnessWindowStart`), so the reason reads the same
 * whether the caller passed every scan or only the window's.
 */
export function staleReasonOf(row: EstateHealthRow, now: Date): EstateStaleReason | null {
    if (row.status === 'FRESH') return null;
    if (!row.scannerLive) return 'SCANNER_NOT_LIVE';
    const windowStart = freshnessWindowStart(row.cadenceHours, now).getTime();
    if (row.latest === null || Date.parse(row.latest.at) < windowStart) return 'NO_SCAN_IN_WINDOW';
    return 'NO_COMPLETE_SCAN';
}

/**
 * When the estate's declaration last changed: its own row, or any of its
 * source rows. An edit replaces the source rows as a set, so a changed set
 * always carries a fresh `createdAt` even when the estate row's own
 * `updatedAt` did not move.
 */
export function declarationChangedAt(estate: {
    readonly createdAt: Date;
    readonly updatedAt: Date;
    readonly sources: readonly { readonly createdAt: Date; readonly updatedAt: Date }[];
}): Date {
    const moments = [estate.createdAt, estate.updatedAt, ...estate.sources.flatMap((s) => [s.createdAt, s.updatedAt])];
    return new Date(Math.max(...moments.map((d) => d.getTime())));
}

export interface PlannedStaleEstateFinding {
    readonly code: typeof STALE_ESTATE_CODE;
    readonly estateId: string;
    readonly sourceRef: string;
    readonly reason: EstateStaleReason;
    readonly severity: 'HIGH';
    readonly type: 'OBSERVATION';
    readonly title: string;
    readonly description: string;
}

/** A source the finding names: not read in full by any scan in the window. */
function describeSource(s: EstateSourceHealth): string {
    if (s.latest === null) return `${s.kind} (no scan in the window)`;
    if (s.latest.state === 'COMPLETE' && s.lastComplete !== null) return `${s.kind} (last read in full at ${s.lastComplete.at})`;
    const state = s.latest.reason ? `${s.latest.state}: ${s.latest.reason}` : s.latest.state;
    return `${s.kind} (${state} in the latest scan)`;
}

const REASON_SENTENCE: Record<EstateStaleReason, string> = {
    SCANNER_NOT_LIVE:
        'Its scanner is retired or no longer in the agent register, so the ingest refuses its reports: '
        + 'the estate cannot become fresh until the scanner is restored or the estate is declared on a live one.',
    NO_SCAN_IN_WINDOW: 'No scan of this estate took effect in that window: its scanner has not reported.',
    NO_COMPLETE_SCAN: 'Scans arrived in that window, but none read every declared source in full.',
};

/**
 * The finding, built from identifiers, the estate's sanitised name and the
 * row's own facts. The caller sanitises it again at the write.
 */
export function staleEstateFinding(row: EstateHealthRow, reason: EstateStaleReason): PlannedStaleEstateFinding {
    const scanner = row.scannerName === null
        ? `agent ${row.scannerAgentId}, which is no longer in the register`
        : `${row.scannerName} (agent ${row.scannerAgentId})`;
    const missing = row.sources.filter((s) => s.status === 'STALE');
    const sources = missing.length > 0
        ? `Sources missing or incomplete: ${missing.map(describeSource).join('; ')}.`
        : 'Every declared source was read in full by some scan in the window, but no single complete scan read them all.';
    const latest = row.latest === null
        ? ''
        : ` The latest scan, ${row.latest.scanRef} at ${row.latest.at}, was ${row.latest.completeness}.`;
    return {
        code: STALE_ESTATE_CODE,
        estateId: row.id,
        sourceRef: staleEstateRefOf(row.id),
        reason,
        severity: 'HIGH',
        type: 'OBSERVATION',
        title: `Harness estate ${row.name} has no complete scan within ${row.staleAfterHours} hours`,
        description:
            `Estate ${row.name} (${row.id}) is scanned by ${scanner} and expects a complete scan every `
            + `${row.cadenceHours} hours; it is stale after ${row.staleAfterHours} hours without one. `
            + `${REASON_SENTENCE[reason]} ${sources}${latest} `
            + 'This finding closes when a complete scan of every declared source arrives. Editing or removing '
            + 'the estate does not close it.',
    };
}

/** One estate as the pass evaluated it. */
export interface EstateUnderEvaluation {
    /** `computeEstateHealth`'s row: the one rule. */
    readonly health: EstateHealthRow;
    /** ISO. When the declaration last changed (`declarationChangedAt`). */
    readonly declaredAt: string;
    /** ISO. When the scan `health.lastComplete` names was ingested; null when there is none. */
    readonly lastCompleteArrivedAt: string | null;
}

/** A stale-estate finding the tenant already holds (not soft-deleted). */
export interface KnownStaleFinding {
    readonly id: string;
    readonly sourceRef: string;
    /** `FindingStatus`, as stored. */
    readonly status: string;
}

export type HeldReason = 'FRESH_ONLY_BY_DECLARATION_CHANGE' | 'ESTATE_NOT_DECLARED';

export type StalenessAction =
    | { readonly kind: 'OPEN'; readonly finding: PlannedStaleEstateFinding }
    | { readonly kind: 'REOPEN'; readonly findingId: string; readonly finding: PlannedStaleEstateFinding }
    | { readonly kind: 'STILL_OPEN'; readonly findingId: string; readonly estateId: string; readonly reason: EstateStaleReason }
    | {
        readonly kind: 'CLOSE';
        readonly findingId: string;
        /** The status it is closed from: OPEN, or a person's IN_PROGRESS / READY_FOR_VERIFICATION. */
        readonly priorStatus: string;
        readonly estateId: string;
        readonly sourceRef: string;
        readonly scanRef: string;
        readonly arrivedAt: string;
    }
    | { readonly kind: 'HOLD'; readonly findingId: string; readonly estateId: string; readonly sourceRef: string; readonly reason: HeldReason };

export interface EstateStalenessPlan {
    /** Estates evaluated. Zero is nothing measured, never a clean result. */
    readonly evaluated: number;
    readonly stale: readonly { readonly estateId: string; readonly reason: EstateStaleReason }[];
    readonly actions: readonly StalenessAction[];
}

/** Of several rows sharing one ref (which the reconcile never writes), the one that speaks: an open one first. */
function findingByRef(findings: readonly KnownStaleFinding[]): Map<string, KnownStaleFinding> {
    const out = new Map<string, KnownStaleFinding>();
    for (const f of findings) {
        const prior = out.get(f.sourceRef);
        if (!prior || (prior.status === 'CLOSED' && f.status !== 'CLOSED')) out.set(f.sourceRef, f);
    }
    return out;
}

/** What one pass means for each estate's finding. */
export function planEstateStaleness(input: {
    readonly estates: readonly EstateUnderEvaluation[];
    readonly findings: readonly KnownStaleFinding[];
    /** The moment the health rows were computed at. */
    readonly now: Date;
}): EstateStalenessPlan {
    const byRef = findingByRef(input.findings.filter((f) => estateIdOfStaleRef(f.sourceRef) !== null));
    const stale: { estateId: string; reason: EstateStaleReason }[] = [];
    const actions: StalenessAction[] = [];
    const declared = new Set<string>();

    for (const { health, declaredAt, lastCompleteArrivedAt } of input.estates) {
        declared.add(health.id);
        const ref = staleEstateRefOf(health.id);
        const prior = byRef.get(ref);
        const reason = staleReasonOf(health, input.now);

        if (reason !== null) {
            stale.push({ estateId: health.id, reason });
            if (!prior) actions.push({ kind: 'OPEN', finding: staleEstateFinding(health, reason) });
            else if (prior.status === 'CLOSED') {
                actions.push({ kind: 'REOPEN', findingId: prior.id, finding: staleEstateFinding(health, reason) });
            } else actions.push({ kind: 'STILL_OPEN', findingId: prior.id, estateId: health.id, reason });
            continue;
        }

        // FRESH. Nothing to do unless a finding is open, and then only a scan
        // that ARRIVED after the declaration last changed may close it.
        if (!prior || prior.status === 'CLOSED') continue;
        const last = health.lastComplete;
        if (last !== null && lastCompleteArrivedAt !== null && Date.parse(lastCompleteArrivedAt) > Date.parse(declaredAt)) {
            actions.push({
                kind: 'CLOSE',
                findingId: prior.id,
                priorStatus: prior.status,
                estateId: health.id,
                sourceRef: ref,
                scanRef: last.scanRef,
                arrivedAt: lastCompleteArrivedAt,
            });
        } else {
            actions.push({
                kind: 'HOLD',
                findingId: prior.id,
                estateId: health.id,
                sourceRef: ref,
                reason: 'FRESH_ONLY_BY_DECLARATION_CHANGE',
            });
        }
    }

    // An open finding whose estate was not evaluated — removed — is held open.
    for (const [ref, f] of byRef) {
        const estateId = estateIdOfStaleRef(ref) as string;
        if (declared.has(estateId) || f.status === 'CLOSED') continue;
        actions.push({ kind: 'HOLD', findingId: f.id, estateId, sourceRef: ref, reason: 'ESTATE_NOT_DECLARED' });
    }

    return { evaluated: input.estates.length, stale, actions };
}
