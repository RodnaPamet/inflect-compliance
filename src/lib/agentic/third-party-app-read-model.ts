/**
 * THE THIRD-PARTY APPLICATION INVENTORY, AS A READ MODEL.
 *
 * What `usecases/third-party-app-scans.ts` (`getThirdPartyAppInventory`) hands
 * the Integrations tab on `/agents/reports`: for each trusted scanner's latest
 * `scanent-integrations/1` scan, the coverage of every source it read and one
 * row per application, as the contract's planner concluded it.
 *
 * CLIENT-SAFE: types and one pure function, no runtime import. The contract
 * package's integrations modules require `crypto` transitively, so they are
 * read on the server only and nothing here imports them; every value the tab
 * shows (a product's title, a planner's conclusion, a class code) arrives as
 * plain data.
 *
 * ── TWO RULES THIS MODULE STATES ONCE ───────────────────────────────────────
 *
 *   • ZERO IS NEVER COMPLETE. A scan that read every source in full and found
 *     no application is EMPTY, not clean: every directory in use holds some, and
 *     an empty answer is what a read of the wrong directory looks like.
 *     `thirdPartyScanCompleteness` is the one expression for it.
 *   • NOT KNOWN IS NOT NONE. A publisher, an owner or a sign-in is either what
 *     the read established, or NOT KNOWN (the read did not establish it), or
 *     NOT EXPOSED (the product's API has no such member: Okta and GitHub expose
 *     none of the three). Neither of the last two is ever shown as "none".
 */

export type ThirdPartyScanCompleteness = 'COMPLETE' | 'INCOMPLETE' | 'EMPTY';

/**
 * COMPLETE only when every source was read in full (the stored, DERIVED flag)
 * AND the sources re-read AND at least one application was found — in one
 * expression, so no reader writes "complete" without the population.
 */
export function thirdPartyScanCompleteness(scan: {
    readonly complete: boolean;
    readonly applicationCount: number;
    readonly sourcesReadable: boolean;
}): ThirdPartyScanCompleteness {
    if (!scan.complete || !scan.sourcesReadable) return 'INCOMPLETE';
    return scan.applicationCount > 0 ? 'COMPLETE' : 'EMPTY';
}

/** One open finding about an application or a source: its code and its row. */
export interface ThirdPartyOpenFinding {
    readonly code: string;
    readonly findingId: string;
    readonly severity: string;
}

/** One source of one scan, as the report stated it. */
export interface ThirdPartyAppSourceView {
    readonly kind: string;
    /** The product in words (`INTEGRATIONS_PRODUCT_TITLE`), resolved on the server. */
    readonly product: string;
    readonly status: 'COMPLETE' | 'INCOMPLETE';
    readonly reason: string | null;
    readonly rows: number;
    readonly signIn: 'NOT_READ' | 'COMPLETE' | 'INCOMPLETE';
    readonly signInReason: string | null;
    /** The source-level findings open for it (an empty inventory), from this scanner. */
    readonly openFindings: readonly ThirdPartyOpenFinding[];
}

/** What the read established about a member the product may not expose. */
export type ThirdPartyKnownState = 'READ' | 'NOT_KNOWN' | 'NOT_EXPOSED';

/** One application in one scan. */
export interface ThirdPartyAppRow {
    /** `DiscoveredThirdPartyApp.id`. */
    readonly appId: string;
    /** The report's id for it (`entra:<directory>:sp:<object>`, …). */
    readonly applicationId: string;
    readonly sourceKind: string;
    readonly product: string;
    /** The directory's name for it; null when it has none. */
    readonly name: string | null;
    readonly privilege: 'HIGH' | 'NOT_HIGH' | 'NOT_CONCLUDED';
    /** Permission class codes (`DIRECTORY`, `MAIL`, …) the high grants fall in. */
    readonly classes: readonly string[];
    /** The high-privilege permissions' names, at most `HIGH_PERMISSIONS_SHOWN`. */
    readonly highPermissions: readonly string[];
    readonly highPermissionCount: number;
    /** Permissions the classification tables do not know: neither high nor low. */
    readonly unknownPermissionCount: number;
    readonly publisher: { readonly state: ThirdPartyKnownState; readonly verified: boolean | null };
    readonly owners: { readonly state: ThirdPartyKnownState; readonly count: number | null };
    readonly usage: 'USED' | 'UNUSED' | 'NOT_CONCLUDED';
    /** Whether the product exposes sign-in at all; `READ` when the planner concluded a usage. */
    readonly signIn: ThirdPartyKnownState;
    readonly daysSinceSignIn: number | null;
    readonly openFindings: readonly ThirdPartyOpenFinding[];
}

export interface ThirdPartyScanView {
    readonly id: string;
    readonly scanRef: string;
    readonly scannerAgentId: string;
    readonly scannerName: string | null;
    readonly scannerVersion: string;
    readonly asOf: string;
    readonly ingestedAt: string;
    readonly completeness: ThirdPartyScanCompleteness;
    readonly applicationCount: number;
    readonly unusedDays: number;
}

/** One trusted scanner's latest scan: coverage first, then its applications. */
export interface ThirdPartyScanSection {
    readonly scan: ThirdPartyScanView;
    /** `null` when the stored sources do not re-read against the contract: the scan counts INCOMPLETE. */
    readonly sources: readonly ThirdPartyAppSourceView[] | null;
    readonly rows: readonly ThirdPartyAppRow[];
    /** More applications than the tab shows; the rows are the first by the tab's order. */
    readonly rowsTruncated: boolean;
    /** The applications could not be read whole, so none is shown. */
    readonly rowsUnread: boolean;
}

export interface ThirdPartyAppInventoryView {
    readonly sections: readonly ThirdPartyScanSection[];
    /** Scanners with a scan in the window whose section is not shown (past the section cap). */
    readonly scannersNotShown: number;
    /** Scanners holding a trusted key with no integrations scan in the window: unread, never "none". */
    readonly scannersWithoutScan: {
        readonly rows: readonly { readonly agentId: string; readonly name: string | null }[];
        readonly truncated: boolean;
    };
    readonly scanWindow: number;
    readonly scansTruncated: boolean;
    /** The open-findings read hit its cap: a row without a finding may have one. */
    readonly findingsTruncated: boolean;
}
