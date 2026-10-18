/**
 * THE HARNESS MATRIX, AS A READ MODEL (#3687).
 *
 * What `usecases/agent-harness-matrix.ts` hands the harness tab on
 * `/agents/reports`, and the pure rules both sides of that boundary share.
 * CLIENT-SAFE: the only import is the ladder, which has none, so the tab's
 * components hold the same functions the server ran.
 *
 * ── THREE RULES THIS MODULE EXISTS TO STATE ONCE ────────────────────────────
 *
 *   • ZERO IS NEVER COMPLETE. A scan that found no agents is EMPTY, whatever
 *     its sources say: an empty population evidences nothing, and a scanner
 *     reading the wrong tenant looks exactly like a clean one.
 *     `harnessScanCompleteness` is the one expression for "complete", and the
 *     evidence emitter reuses it rather than writing its own.
 *   • DRIFT IS COMPUTED FROM STORED ROWS ONLY. Two scans' items and sources —
 *     no clock, no `firstSeenAt` (that is the ingest's clock, not the moment a
 *     report describes), no finding the report itself chose to raise.
 *   • A POINTER IS A LINK ONLY WHEN IT IS AN ABSOLUTE http(s) URL. Evidence
 *     pointers are scanner strings. `isSafeHref` passes relative URLs, and a
 *     scanner-chosen `/admin/...` would render as an in-app link the reader
 *     trusts as ours. Everything else is shown as text to copy — with any URL
 *     userinfo replaced by `***` (`redactPointerCredentials`), so a pointer
 *     that embedded a password is neither linked nor printed nor copied.
 *
 * PURE: no clock, no I/O.
 */
import {
    rungOf,
    type CriterionVerdict,
    type HarnessLevel,
} from './harness-ladder';

// ─── View types: JSON-safe (ISO strings, no Date) ───────────────────────────

export type HarnessScanCompleteness = 'COMPLETE' | 'INCOMPLETE' | 'EMPTY';

/** One stored source of a scan, as the contract re-validates it. */
export interface StoredSource {
    readonly kind: string;
    readonly status: 'COMPLETE' | 'INCOMPLETE';
    readonly rows: number;
    readonly reason: string | null;
}

export type HarnessStoredReach = 'READ_ONLY' | 'WRITE_OR_EXTERNAL' | 'UNKNOWN';

export type AcceptAffordance = 'ACCEPT' | 'RENEW' | 'OWNER_ONLY' | 'REGISTER_FIRST' | 'NONE';

export interface HarnessScanRow {
    readonly id: string;
    readonly scanRef: string;
    readonly scannerAgentId: string;
    readonly scannerName: string | null;
    readonly scannerVersion: string;
    readonly asOf: string;
    readonly ingestedAt: string;
    readonly completeness: HarnessScanCompleteness;
    readonly agentCount: number;
    /** `null` = the stored sources failed re-validation, and the scan is treated as INCOMPLETE. */
    readonly sources: readonly StoredSource[] | null;
}

export interface HarnessDrift {
    readonly baselineScanId: string;
    readonly baselineScanRef: string;
    readonly baselineAsOf: string;
    readonly baselineCompleteness: HarnessScanCompleteness;
    readonly levelDrops: readonly {
        readonly discoveredAgentId: string;
        readonly discoveredId: string;
        readonly from: HarnessLevel;
        readonly to: HarnessLevel;
    }[];
    readonly newlySeen: readonly { readonly discoveredAgentId: string; readonly discoveredId: string }[];
    /** COMPLETE in the baseline, INCOMPLETE now. */
    readonly sourcesGoneIncomplete: readonly { readonly kind: string; readonly reason: string | null }[];
    /** Reported in the baseline, absent now: coverage that was lost, not a source that was fine. */
    readonly sourcesDropped: readonly string[];
    /** Either side's stored sources were unreadable, so source drift cannot be stated. */
    readonly sourceDriftUnknown: boolean;
}

export interface MatrixRow {
    readonly discoveredAgentId: string;
    readonly discoveredId: string;
    readonly discoveredVia: readonly string[];
    /** `null` is SHADOW — including a register row deleted after the scan linked it. */
    readonly registered: { readonly agentId: string; readonly name: string } | null;
    readonly level: HarnessLevel;
    readonly reach: HarnessStoredReach;
    readonly belowBar: boolean;
    readonly bar: HarnessLevel;
    readonly blockingNextRung: readonly string[];
    /** Collapsed: one verdict per answered criterion, at most one per criterion. The client maps cells with `criterionState`. */
    readonly verdicts: readonly CriterionVerdict[];
    /** The stored verdicts failed re-validation: every cell renders unanswered (fail closed). */
    readonly verdictsUnreadable: boolean;
    /**
     * Set when a scan received LATER (but describing an earlier moment) read
     * this agent at a different level. Acceptance follows that reading, because
     * it is the one `acceptHarnessShortfall` reads.
     */
    readonly latestIngestedLevel: HarnessLevel | null;
    readonly acceptance: {
        readonly id: string;
        readonly expiresAt: string;
        readonly acceptedLevel: HarnessLevel;
        readonly renewal: boolean;
    } | null;
    readonly acceptAffordance: AcceptAffordance;
}

export interface HarnessScannerSection {
    readonly scannerAgentId: string;
    readonly scannerName: string | null;
    readonly latest: HarnessScanRow;
    readonly previous: HarnessScanRow | null;
    readonly baseline: 'PREVIOUS_SCAN' | 'FIRST_SCAN' | 'OUTSIDE_WINDOW';
    readonly drift: HarnessDrift | null;
    readonly driftUnavailableReason: 'FIRST_SCAN' | 'OUTSIDE_WINDOW' | 'POPULATION_OVER_BOUND' | null;
    readonly rows: readonly MatrixRow[];
    /**
     * The latest scan's stored agents could not all be read, so NO rows are
     * shown: "worst first" over a partial read is the worst of a prefix, not
     * of the scan.
     */
    readonly rowsUnread: boolean;
    /** Every agent was read, and fewer rows are shown than the latest scan holds — the worst of them. */
    readonly rowsTruncated: boolean;
}

export interface ShadowRow {
    readonly discoveredAgentId: string;
    readonly discoveredId: string;
    readonly discoveredVia: readonly string[];
    readonly firstSeenAt: string;
    readonly lastSeenAt: string;
    readonly lastLevel: HarnessLevel;
    readonly reason: 'UNREGISTERED' | 'REGISTER_ROW_DELETED';
    /**
     * The agent's SHADOW_AGENT finding — what the registration intake registers
     * from (#3712). `null` when none is on record, and then there is nothing to
     * register from.
     */
    readonly findingId: string | null;
    /**
     * The register row the intake already made from this agent, if any. The
     * intake refuses a second one whatever its status, so the Register action
     * is offered only when this is `null`. `linkable` is the ingest planner's
     * own rule (`isIntakeClaimLinkable`): a linkable row takes the agent off
     * this list at the next scan that sees it, and closes the finding at the
     * next complete one.
     */
    readonly intake: { readonly agentId: string; readonly name: string | null; readonly linkable: boolean } | null;
}

export interface AcceptanceRow {
    readonly id: string;
    readonly discoveredAgentId: string;
    readonly agentLabel: string;
    readonly acceptedLevel: HarnessLevel;
    readonly expiresAt: string;
    readonly inForce: boolean;
    readonly acceptAffordance: AcceptAffordance;
}

export interface HarnessMatrixView {
    readonly generatedAt: string;
    /** How many scans the window reads; `truncated` says older ones exist. */
    readonly scanWindow: number;
    readonly scans: { readonly rows: readonly HarnessScanRow[]; readonly truncated: boolean };
    readonly sections: readonly HarnessScannerSection[];
    readonly scannersNotShown: number;
    /**
     * Scanners holding an unrevoked key with no scan in the window. Their
     * sources are unread as far as this page can see, so each one keeps the
     * shadow list from reading as "none".
     */
    readonly scannersWithoutScan: {
        readonly rows: readonly { readonly agentId: string; readonly name: string | null }[];
        /** More key holders than the page reads: some may be missing here, and the shadow list is unstated. */
        readonly truncated: boolean;
    };
    readonly shadow: {
        readonly rows: readonly ShadowRow[];
        readonly truncated: boolean;
        /**
         * Whether an empty list can be read as "none": only when EVERY trusted
         * scanner's latest scan is COMPLETE and shown — one scanner's complete
         * scan says nothing about the sources another reads.
         */
        readonly basis: 'EVIDENCED' | 'NOT_EVIDENCED';
        /** The OLDEST of those complete latest scans' `asOf`, when `basis` is EVIDENCED. */
        readonly basisAsOf: string | null;
    };
    readonly acceptances: { readonly rows: readonly AcceptanceRow[]; readonly truncated: boolean };
}

/**
 * One trusted scanner key, as the harness tab lists it. The key's own public
 * bytes are not here — the fingerprint identifies it — and neither is who
 * registered or revoked it: the audit trail names them, the tab does not.
 */
export interface HarnessScannerKeyRow {
    readonly id: string;
    readonly agentId: string;
    /** The scanner's register name; `null` when that register row has since been deleted. */
    readonly agentName: string | null;
    readonly keyFingerprint: string;
    readonly createdAt: string;
    readonly revokedAt: string | null;
}

/** The key register, plus the agents a new key may be registered for. */
export interface HarnessScannerKeysView {
    readonly keys: { readonly rows: readonly HarnessScannerKeyRow[]; readonly truncated: boolean };
    /** Live, non-retired register rows — the agents `addHarnessScannerKey` accepts. */
    readonly candidates: {
        readonly rows: readonly { readonly id: string; readonly name: string }[];
        readonly truncated: boolean;
    };
}

// ─── Pure rules ─────────────────────────────────────────────────────────────

/**
 * Whether a scan is complete, in ONE expression: every source read in full
 * (`complete`, derived at ingest), the stored sources still readable, AND a
 * non-empty population. A scan that found nobody is EMPTY first, whatever its
 * sources say — zero is never complete.
 */
export function harnessScanCompleteness(scan: {
    complete: boolean;
    agentCount: number;
    sourcesReadable: boolean;
}): HarnessScanCompleteness {
    if (scan.agentCount === 0) return 'EMPTY';
    return scan.complete && scan.sourcesReadable && scan.agentCount > 0 ? 'COMPLETE' : 'INCOMPLETE';
}

/** One side of a drift comparison, from stored rows. */
export interface DriftScanInput {
    readonly id: string;
    readonly scanRef: string;
    readonly asOf: string;
    readonly completeness: HarnessScanCompleteness;
    readonly sources: readonly StoredSource[] | null;
    readonly items: readonly { readonly discoveredAgentId: string; readonly discoveredId: string; readonly level: HarnessLevel }[];
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * What changed between a scanner's previous scan and its latest. Absence is
 * not reported as "gone": one scanner not seeing an agent is not evidence the
 * agent is gone, which is the same rule the finding planner holds.
 */
export function computeHarnessDrift(latest: DriftScanInput, previous: DriftScanInput): HarnessDrift {
    const before = new Map(previous.items.map((i) => [i.discoveredAgentId, i]));
    const levelDrops: { discoveredAgentId: string; discoveredId: string; from: HarnessLevel; to: HarnessLevel }[] = [];
    const newlySeen: { discoveredAgentId: string; discoveredId: string }[] = [];
    for (const item of latest.items) {
        const prior = before.get(item.discoveredAgentId);
        if (prior === undefined) {
            newlySeen.push({ discoveredAgentId: item.discoveredAgentId, discoveredId: item.discoveredId });
        } else if (rungOf(item.level) < rungOf(prior.level)) {
            levelDrops.push({
                discoveredAgentId: item.discoveredAgentId,
                discoveredId: item.discoveredId,
                from: prior.level,
                to: item.level,
            });
        }
    }
    const dropSize = (d: { from: HarnessLevel; to: HarnessLevel }) => rungOf(d.from) - rungOf(d.to);
    levelDrops.sort((a, b) => dropSize(b) - dropSize(a) || byString(a.discoveredId, b.discoveredId));
    newlySeen.sort((a, b) => byString(a.discoveredId, b.discoveredId));

    const sourceDriftUnknown = latest.sources === null || previous.sources === null;
    const sourcesGoneIncomplete: { kind: string; reason: string | null }[] = [];
    const sourcesDropped: string[] = [];
    if (latest.sources !== null && previous.sources !== null) {
        const priorByKind = new Map(previous.sources.map((s) => [s.kind, s]));
        const nowKinds = new Set(latest.sources.map((s) => s.kind));
        for (const s of latest.sources) {
            if (s.status === 'INCOMPLETE' && priorByKind.get(s.kind)?.status === 'COMPLETE') {
                sourcesGoneIncomplete.push({ kind: s.kind, reason: s.reason });
            }
        }
        for (const s of previous.sources) if (!nowKinds.has(s.kind)) sourcesDropped.push(s.kind);
        sourcesGoneIncomplete.sort((a, b) => byString(a.kind, b.kind));
        sourcesDropped.sort(byString);
    }

    return {
        baselineScanId: previous.id,
        baselineScanRef: previous.scanRef,
        baselineAsOf: previous.asOf,
        baselineCompleteness: previous.completeness,
        levelDrops,
        newlySeen,
        sourcesGoneIncomplete,
        sourcesDropped,
        sourceDriftUnknown,
    };
}

/**
 * The href an evidence pointer may be rendered with, or `null` for "show it as
 * text". Only an ABSOLUTE `http:`/`https:` URL with no embedded credentials
 * qualifies, parsed without a base so a relative path cannot resolve against
 * this product's own origin.
 */
export function evidenceHrefOf(pointer: string | null | undefined): string | null {
    if (typeof pointer !== 'string') return null;
    const trimmed = pointer.trim();
    if (trimmed === '') return null;
    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username !== '' || url.password !== '') return null;
    return url.href;
}

/**
 * Every URL userinfo in a pointer — `//user:password@`, `//token@` — and
 * everything up to the authority's LAST `@`, ending at the first `/`, `?` or
 * `#`. Wider on purpose than the ingest's `scheme://user:password@host` secret
 * shape: whitespace and `\` do not end the match, a username alone counts, and
 * no scheme is required, so rows stored before that shape existed, and
 * malformed URLs a parser would read differently, are covered too. Hiding a
 * harmless `git@` costs a reader one word; showing a password is the leak.
 */
const POINTER_USERINFO = /\/\/[^/?#]*@/g;

/**
 * An evidence pointer as it may be DISPLAYED and COPIED, with every URL userinfo
 * replaced by `***`, and whether anything was. `evidenceHrefOf` already refuses
 * to LINK a URL carrying credentials; this is the other half — the text branch
 * must not print them, nor put them on the clipboard, either.
 */
export function redactPointerCredentials(pointer: string): { readonly text: string; readonly redacted: boolean } {
    const text = pointer.replace(POINTER_USERINFO, '//***@');
    return { text, redacted: text !== pointer };
}

/** Matrix order: the worst rung first, then below its bar, then by discovered id. */
export function compareMatrixRows(
    a: { readonly level: HarnessLevel; readonly belowBar: boolean; readonly discoveredId: string },
    b: { readonly level: HarnessLevel; readonly belowBar: boolean; readonly discoveredId: string },
): number {
    const rung = rungOf(a.level) - rungOf(b.level);
    if (rung !== 0) return rung;
    if (a.belowBar !== b.belowBar) return a.belowBar ? -1 : 1;
    return byString(a.discoveredId, b.discoveredId);
}
