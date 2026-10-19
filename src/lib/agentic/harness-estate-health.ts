/**
 * PER-ESTATE SCHEDULE HEALTH, AS A READ MODEL (#3678, step 4a).
 *
 * An estate declares what should be scanned — a scanner, a cadence, and the
 * sources it reads, each with an owner. Scans record what was. This module is
 * the one place the two are compared: for each estate, the last COMPLETE scan
 * and, for each declared source, the last scan that read it in full; and from
 * those, whether the estate is FRESH or STALE against its cadence.
 *
 * CLIENT-SAFE and PURE: no clock (callers pass `now`), no I/O, and its only
 * imports are the matrix read model's completeness rule and types, so the
 * health card holds the same functions the server ran.
 *
 * ── THE RULES, EACH OF WHICH FAILS TOWARDS "STALE" ─────────────────────────
 *
 *   • ZERO IS NEVER COMPLETE. A scan counts for an estate only when the matrix
 *     calls it COMPLETE (`harnessScanCompleteness`: every reported source read
 *     in full, the stored sources readable, and a non-empty population) AND
 *     every source the estate DECLARES was reported COMPLETE with at least one
 *     row. A source read in full that found nothing is EMPTY, not complete —
 *     an inventory that answers "nothing" is indistinguishable from one read
 *     with the wrong tenant's credential.
 *   • A DECLARED SOURCE THE SCAN DID NOT REPORT IS NOT COMPLETE. A scanner whose
 *     configuration lost a source sends a report that is complete over what it
 *     read; the estate it describes is not. `NOT_REPORTED` says so.
 *   • A SCAN CANNOT DESCRIBE A MOMENT AFTER IT ARRIVED. Freshness is measured
 *     from `min(asOf, ingestedAt)`, so a scanner with a fast clock — or a
 *     future-dated report — cannot keep an estate fresh with scans from
 *     tomorrow.
 *   • NOT SEEN IS STALE. No complete scan among those read is STALE, not
 *     "unknown" and not "never": the page cannot evidence freshness it did not
 *     read. Whether older scans exist is stated beside it (`windowTruncated`).
 *   • STALE AFTER ONE AND A HALF CADENCES. A daily estate is stale 36 hours
 *     after its last complete scan: one slow or late run is tolerated, a
 *     missed one is not.
 */
import {
    harnessScanCompleteness,
    type HarnessScanCompleteness,
    type StoredSource,
} from './harness-read-model';

/** How many cadences may pass after the last complete scan before an estate is stale. */
export const STALE_AFTER_CADENCES = 1.5;

export function staleAfterHours(cadenceHours: number): number {
    return Math.ceil(cadenceHours * STALE_AFTER_CADENCES);
}

export type EstateHealthStatus = 'FRESH' | 'STALE';

/** How one source fared in one scan. */
export type EstateSourceState = 'COMPLETE' | 'EMPTY' | 'INCOMPLETE' | 'NOT_REPORTED' | 'UNREADABLE';

/** One stored scan of an estate's scanner, as the health computation reads it. JSON-safe. */
export interface EstateScanInput {
    readonly id: string;
    readonly scanRef: string;
    readonly asOf: string;
    readonly ingestedAt: string;
    readonly complete: boolean;
    readonly agentCount: number;
    /** Re-validated by the contract; `null` = unreadable, which reads as not complete. */
    readonly sources: readonly StoredSource[] | null;
}

export interface EstateSourceOwner {
    readonly userId: string;
    readonly name: string | null;
    /** Still an ACTIVE member of the tenant. A departed owner is shown, never hidden. */
    readonly active: boolean;
}

export interface EstateDeclaration {
    readonly id: string;
    readonly name: string;
    readonly scannerAgentId: string;
    readonly scannerName: string | null;
    /** The scanner's register row is neither deleted nor retired; a retired scanner's keys verify nothing. */
    readonly scannerLive: boolean;
    readonly cadenceHours: number;
    readonly sources: readonly { readonly kind: string; readonly owner: EstateSourceOwner }[];
}

export interface ScanPointer {
    readonly scanId: string;
    readonly scanRef: string;
    /** The moment the scan counts from: `min(asOf, ingestedAt)`. */
    readonly at: string;
}

export interface EstateSourceHealth {
    readonly kind: string;
    readonly owner: EstateSourceOwner;
    readonly status: EstateHealthStatus;
    readonly lastComplete: ScanPointer | null;
    /** The source in the latest scan; `null` when the estate has no scan in the window. */
    readonly latest: { readonly state: EstateSourceState; readonly reason: string | null } | null;
}

export interface EstateHealthRow extends Omit<EstateDeclaration, 'sources'> {
    readonly staleAfterHours: number;
    readonly status: EstateHealthStatus;
    readonly lastComplete: ScanPointer | null;
    readonly latest: (ScanPointer & { readonly completeness: HarnessScanCompleteness }) | null;
    readonly sources: readonly EstateSourceHealth[];
    /** Kinds the latest scan reported that the estate does not declare: read, but owned by nobody. */
    readonly undeclaredSources: readonly string[];
}

export interface HarnessEstateHealthView {
    readonly generatedAt: string;
    /** The newest scans read across every estate's scanner; `windowTruncated` says older ones exist. */
    readonly scanWindow: number;
    readonly windowTruncated: boolean;
    readonly estates: { readonly rows: readonly EstateHealthRow[]; readonly truncated: boolean };
}

/** The moment a scan counts from. */
export function effectiveMoment(scan: Pick<EstateScanInput, 'asOf' | 'ingestedAt'>): number {
    return Math.min(Date.parse(scan.asOf), Date.parse(scan.ingestedAt));
}

/** How one source fared in one scan. */
export function sourceStateIn(scan: EstateScanInput, kind: string): { state: EstateSourceState; reason: string | null } {
    if (scan.sources === null) return { state: 'UNREADABLE', reason: null };
    const entry = scan.sources.find((s) => s.kind === kind);
    if (!entry) return { state: 'NOT_REPORTED', reason: null };
    if (entry.status === 'INCOMPLETE') return { state: 'INCOMPLETE', reason: entry.reason };
    return entry.rows > 0 ? { state: 'COMPLETE', reason: null } : { state: 'EMPTY', reason: null };
}

const pointer = (scan: EstateScanInput): ScanPointer => ({
    scanId: scan.id,
    scanRef: scan.scanRef,
    at: new Date(effectiveMoment(scan)).toISOString(),
});

const completenessOf = (scan: EstateScanInput): HarnessScanCompleteness =>
    harnessScanCompleteness({ complete: scan.complete, agentCount: scan.agentCount, sourcesReadable: scan.sources !== null });

/**
 * The health of one estate from its scanner's scans (any order) as of `now`.
 * Scans by any other scanner must not be passed: a scan is an estate's only
 * through the scanner that signed it.
 */
export function computeEstateHealth(
    estate: EstateDeclaration,
    scans: readonly EstateScanInput[],
    now: Date,
): EstateHealthRow {
    const ordered = [...scans].sort(
        (a, b) =>
            effectiveMoment(b) - effectiveMoment(a) ||
            Date.parse(b.ingestedAt) - Date.parse(a.ingestedAt) ||
            (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
    const staleAfter = staleAfterHours(estate.cadenceHours);
    const freshness = (p: ScanPointer | null): EstateHealthStatus =>
        p !== null && now.getTime() - Date.parse(p.at) <= staleAfter * 3_600_000 ? 'FRESH' : 'STALE';

    const declared = estate.sources.map((s) => s.kind);
    // `declared.length > 0` is in the expression on purpose: an estate that
    // declared nothing has nothing a scan could complete, and `every` over the
    // empty list is true. The usecase refuses such an estate; this refuses it again.
    const estateComplete = ordered.find(
        (scan) =>
            declared.length > 0 &&
            completenessOf(scan) === 'COMPLETE' &&
            declared.every((kind) => sourceStateIn(scan, kind).state === 'COMPLETE'),
    );
    const lastComplete = estateComplete ? pointer(estateComplete) : null;
    const latestScan = ordered[0];

    const sources: EstateSourceHealth[] = estate.sources.map(({ kind, owner }) => {
        const hit = ordered.find((scan) => sourceStateIn(scan, kind).state === 'COMPLETE');
        const last = hit ? pointer(hit) : null;
        return {
            kind,
            owner,
            status: freshness(last),
            lastComplete: last,
            latest: latestScan ? sourceStateIn(latestScan, kind) : null,
        };
    });

    return {
        id: estate.id,
        name: estate.name,
        scannerAgentId: estate.scannerAgentId,
        scannerName: estate.scannerName,
        scannerLive: estate.scannerLive,
        cadenceHours: estate.cadenceHours,
        staleAfterHours: staleAfter,
        status: freshness(lastComplete),
        lastComplete,
        latest: latestScan ? { ...pointer(latestScan), completeness: completenessOf(latestScan) } : null,
        sources,
        undeclaredSources: latestScan?.sources
            ? latestScan.sources.map((s) => s.kind).filter((k) => !declared.includes(k)).sort()
            : [],
    };
}
