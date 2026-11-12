/**
 * Continuous vendor-monitoring signal contracts.
 *
 * Two external-signal families, each with a provider interface + a
 * deterministic CI-safe stub + a real fetch-backed provider. Mirrors the
 * `vendor-enrichment.ts` provider/stub/factory shape and rides the shared
 * `fetchWithRetry` HTTP seam — NOT a parallel fetch path.
 *
 * These are the FREE / public signals (breach-DB domain check + a public
 * TLS / security-header grade). Paid security-rating integrations
 * (SecurityScorecard, BitSight) are a deliberate future connector — see
 * `docs/vendor-monitoring.md`.
 */

/** A single breach observation for a domain. */
export interface BreachRecord {
    /** Breach name / title, e.g. "Acme 2024 data exposure". */
    name: string;
    /** ISO date the breach occurred / was disclosed, if known. */
    date?: string;
}

export interface BreachSignal {
    /** Provider name (for provenance on the posture event). */
    source: string;
    /** True if the domain appears in ≥1 monitored breach. */
    breached: boolean;
    /** Most recent breach date across all hits (ISO), if any. */
    latestBreachAt?: string;
    breaches: BreachRecord[];
}

export interface BreachProvider {
    readonly name: string;
    /** Check a vendor domain against the breach feed. */
    check(domain: string): Promise<BreachSignal>;
}

/**
 * What one TLS-grade fetch came to. Recorded on the monitor, never folded
 * into the grade: a fetch that did not grade leaves the last grade in place,
 * and this is what says the grade is now stale and why.
 *
 *   GRADED      — a 2xx homepage answered; its headers were graded.
 *   REFUSED     — the site answered and declined: any 4xx (403 above all, a
 *                 429 that outlasted the retry) or a recognised bot-challenge
 *                 response, whatever its status.
 *   UNREACHABLE — no answer to grade: a network failure, a timeout, a name
 *                 that did not resolve, a 5xx that outlasted the retry, or a
 *                 redirect chain that never reached a page.
 *   BLOCKED     — nothing was requested, or a hop was not followed: the domain
 *                 is not a bare host name, or the SSRF guard refused it or a
 *                 redirect target. The vendor record needs correcting, not
 *                 the vendor's site.
 */
export const TLS_FETCH_OUTCOMES = ['GRADED', 'REFUSED', 'UNREACHABLE', 'BLOCKED'] as const;
export type TlsFetchOutcome = (typeof TLS_FETCH_OUTCOMES)[number];

export interface TlsSignal {
    source: string;
    /** What the fetch came to. `grade` is non-null exactly when this is GRADED. */
    outcome: TlsFetchOutcome;
    /** Letter grade A..F, or null when the domain couldn't be graded. */
    grade: string | null;
    /** ISO timestamp of the grade. */
    checkedAt: string;
    /** Which security headers were present (for the timeline detail). */
    presentHeaders: string[];
    /** Which expected security headers were missing. */
    missingHeaders: string[];
}

export interface TlsProvider {
    readonly name: string;
    /** Grade a vendor domain's public TLS / security-header posture. */
    grade(domain: string): Promise<TlsSignal>;
}
