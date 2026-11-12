/**
 * Pure evaluators for vendor monitoring — no DB, no network, no ctx.
 * Exhaustively unit-testable; the usecase + providers call these.
 */
import type { BreachSignal, TlsFetchOutcome, TlsSignal } from './types';

/** Security headers we grade a public site on, in weight order. */
export const GRADED_SECURITY_HEADERS = [
    'strict-transport-security',
    'content-security-policy',
    'x-frame-options',
    'x-content-type-options',
    'referrer-policy',
    'permissions-policy',
] as const;

export interface HeaderGrade {
    grade: string;
    presentHeaders: string[];
    missingHeaders: string[];
}

/**
 * Grade a set of response headers A..F by how many expected security headers
 * are present. Header lookup is case-insensitive. Deterministic — the same
 * header set always grades the same.
 */
export function gradeSecurityHeaders(headers: Record<string, string | undefined>): HeaderGrade {
    const lower = new Map<string, string>();
    for (const [k, v] of Object.entries(headers)) {
        if (v != null) lower.set(k.toLowerCase(), v);
    }
    const present: string[] = [];
    const missing: string[] = [];
    for (const h of GRADED_SECURITY_HEADERS) {
        if (lower.has(h)) present.push(h);
        else missing.push(h);
    }
    const ratio = present.length / GRADED_SECURITY_HEADERS.length;
    // A ≥5/6, B ≥4/6, C ≥3/6, D ≥2/6, E ≥1/6, F 0.
    const grade =
        ratio >= 5 / 6 ? 'A' :
        ratio >= 4 / 6 ? 'B' :
        ratio >= 3 / 6 ? 'C' :
        ratio >= 2 / 6 ? 'D' :
        ratio >= 1 / 6 ? 'E' : 'F';
    return { grade, presentHeaders: present, missingHeaders: missing };
}

/** A TLS/header grade of D or worse is "failing" — a threshold-gated finding. */
export function isFailingGrade(grade: string | null): boolean {
    return grade === 'D' || grade === 'E' || grade === 'F';
}

/**
 * Decide whether a breach signal is NEW relative to the last-seen breach date
 * already recorded on the monitor. Prevents the monitor re-alerting on the
 * same breach every daily run — only a breach strictly newer than the cached
 * `breachLastSeenAt` (or the first breach ever seen) counts as a fresh signal.
 */
export function isNewBreach(signal: BreachSignal, lastSeenAt: Date | null): boolean {
    if (!signal.breached || !signal.latestBreachAt) return false;
    if (!lastSeenAt) return true;
    return new Date(signal.latestBreachAt).getTime() > lastSeenAt.getTime();
}

export interface AttestationView {
    /** Extraction id — used in the idempotency fingerprint. */
    extractionId: string;
    reportType: string | null;
    auditPeriodEnd: Date | null;
}

export type AttestationStatus = 'EXPIRED' | 'EXPIRING' | 'OK';

export interface AttestationVerdict {
    status: AttestationStatus;
    /** The governing extraction (earliest-expiring), if any dated report exists. */
    governing: AttestationView | null;
    /** Earliest expiry across all dated reports. */
    earliestExpiry: Date | null;
}

/**
 * Evaluate a vendor's parsed attestations (SOC 2 / ISO cert periods) against
 * `now`. EXPIRED when the earliest report period end is in the past; EXPIRING
 * when it lands inside the lead window (default 30 days); OK otherwise. The
 * earliest-expiring dated report governs — a vendor is only as fresh as its
 * soonest-lapsing attestation.
 */
export function evaluateAttestations(
    extractions: AttestationView[],
    now: Date,
    leadDays = 30,
): AttestationVerdict {
    const dated = extractions.filter((e) => e.auditPeriodEnd != null);
    if (dated.length === 0) {
        return { status: 'OK', governing: null, earliestExpiry: null };
    }
    dated.sort((a, b) => a.auditPeriodEnd!.getTime() - b.auditPeriodEnd!.getTime());
    const governing = dated[0];
    const expiry = governing.auditPeriodEnd!;
    const leadCutoff = new Date(now.getTime() + leadDays * 86400000);
    const status: AttestationStatus =
        expiry < now ? 'EXPIRED' : expiry <= leadCutoff ? 'EXPIRING' : 'OK';
    return { status, governing, earliestExpiry: expiry };
}

/** The monitor columns one TLS observation writes. */
export interface TlsObservation {
    /** The grade to keep: the new one when graded, otherwise the last one. */
    tlsGrade: string | null;
    /** Set only when this run graded. A fetch that did not grade leaves it. */
    tlsCheckedAt: Date | null;
    /** True when a new grade differs from the stored one (a timeline event). */
    gradeChanged: boolean;
    /** Always written: what this run's fetch came to, and when. */
    tlsFetchOutcome: TlsFetchOutcome;
    tlsFetchOutcomeAt: Date;
}

/**
 * Fold one TLS signal into the monitor's rolling state.
 *
 * A fetch that did not grade is recorded, never read as "no change": the
 * stored grade and `tlsCheckedAt` stay as the last real observation, and the
 * outcome is what tells a reader that grade is now stale. A signal claiming
 * GRADED with no grade is taken as unreachable rather than trusted, so the
 * outcome column never says GRADED beside a grade that was not observed.
 */
export function planTlsObservation(previousGrade: string | null, signal: TlsSignal): TlsObservation {
    const at = new Date(signal.checkedAt);
    if (signal.outcome === 'GRADED' && signal.grade) {
        return {
            tlsGrade: signal.grade,
            tlsCheckedAt: at,
            gradeChanged: signal.grade !== previousGrade,
            tlsFetchOutcome: 'GRADED',
            tlsFetchOutcomeAt: at,
        };
    }
    return {
        tlsGrade: previousGrade,
        tlsCheckedAt: null,
        gradeChanged: false,
        tlsFetchOutcome: signal.outcome === 'GRADED' ? 'UNREACHABLE' : signal.outcome,
        tlsFetchOutcomeAt: at,
    };
}

/**
 * A stored grade is stale when the latest fetch did not grade. No grade is
 * never stale (there is nothing to mistrust), and a monitor that predates the
 * outcome column (outcome NULL) is not called stale on no evidence.
 */
export function isTlsGradeStale(monitor: { tlsGrade: string | null; tlsFetchOutcome: string | null }): boolean {
    return monitor.tlsGrade != null && monitor.tlsFetchOutcome != null && monitor.tlsFetchOutcome !== 'GRADED';
}
