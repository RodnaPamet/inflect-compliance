/**
 * SARIF (OASIS Static Analysis Results Interchange Format, v2.1.0) parser
 * — the CANONICAL ingestion path for DevSecOps scanner output.
 *
 * SARIF is what Semgrep, CodeQL, Trivy, gitleaks, Checkov and ZAP all
 * emit (directly or via a converter), so IC normalises ONE format rather
 * than writing a parser per tool. Trivy-JSON / ZAP-XML adapters are only
 * worth adding if a tool's SARIF turns out lossy — they would convert TO
 * the `NormalizedScannerFinding` shape this module defines, never fork a
 * second ingestion path.
 *
 * This module is intentionally PURE (no DB, no ctx, no IO) so it is
 * exhaustively unit-testable: `parseSarif(json)` → normalised findings +
 * inferred tool metadata. Persistence, dedup-against-existing, evidence
 * materialisation and Finding reconciliation all live in the ingestion
 * usecase (`scanner-ingestion.ts`).
 */
import { createHash } from 'node:crypto';

export type ScannerSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type ScannerSource =
    | 'SEMGREP'
    | 'TRIVY'
    | 'ZAP'
    | 'GITLEAKS'
    | 'CHECKOV'
    | 'CODEQL'
    | 'OTHER';
export type ScanType = 'SAST' | 'SCA' | 'DAST' | 'SECRETS' | 'IAC';

export interface NormalizedScannerFinding {
    /** SHA-256 fingerprint — stable across re-scans for the same issue. */
    fingerprint: string;
    ruleId: string;
    severity: ScannerSeverity;
    title: string;
    description: string | null;
    /** `file:line` (or `file`) the result points at, when present. */
    location: string | null;
    /** Normalised CWE refs, e.g. `['CWE-79']`. */
    cweIds: string[];
}

export interface ParsedSarif {
    /** `tool.driver.name` as reported, e.g. `Semgrep`. */
    toolName: string;
    /** Inferred from the tool name — the caller may override. */
    source: ScannerSource;
    scanType: ScanType;
    findings: NormalizedScannerFinding[];
}

/**
 * Severity matrix (documented contract — referenced by the ratchet).
 *
 * 1. If the rule/result carries `security-severity` (a CVSS-style 0–10
 *    string, emitted by CodeQL + Semgrep), it WINS:
 *        >= 9.0 → CRITICAL, >= 7.0 → HIGH, >= 4.0 → MEDIUM, else LOW.
 * 2. Otherwise fall back to the SARIF `level`:
 *        error → HIGH, warning → MEDIUM, note/none/(absent) → LOW.
 *
 * Scanners that only emit secrets/IaC (gitleaks, Checkov) generally use
 * `error`, so they map to HIGH by default — appropriate for a leaked
 * credential or an open security-group rule.
 */
export const SARIF_LEVEL_TO_SEVERITY: Record<string, ScannerSeverity> = {
    error: 'HIGH',
    warning: 'MEDIUM',
    note: 'LOW',
    none: 'LOW',
};

export function securitySeverityToSeverity(score: number): ScannerSeverity {
    if (score >= 9.0) return 'CRITICAL';
    if (score >= 7.0) return 'HIGH';
    if (score >= 4.0) return 'MEDIUM';
    return 'LOW';
}

/** Tool-name → (source, default scanType). Caller may override scanType. */
const TOOL_MATCHERS: { match: RegExp; source: ScannerSource; scanType: ScanType }[] = [
    { match: /semgrep/i, source: 'SEMGREP', scanType: 'SAST' },
    { match: /codeql/i, source: 'CODEQL', scanType: 'SAST' },
    { match: /trivy/i, source: 'TRIVY', scanType: 'SCA' },
    { match: /gitleaks/i, source: 'GITLEAKS', scanType: 'SECRETS' },
    { match: /checkov/i, source: 'CHECKOV', scanType: 'IAC' },
    { match: /zap|owasp/i, source: 'ZAP', scanType: 'DAST' },
];

export function inferTool(toolName: string): { source: ScannerSource; scanType: ScanType } {
    for (const m of TOOL_MATCHERS) {
        if (m.match.test(toolName)) return { source: m.source, scanType: m.scanType };
    }
    return { source: 'OTHER', scanType: 'SAST' };
}

const CWE_RE = /CWE[-_ ]?(\d+)/gi;

/** Pull every `CWE-\d+` out of an arbitrary nested value, normalised + deduped. */
function extractCwes(...values: unknown[]): string[] {
    const out = new Set<string>();
    const walk = (v: unknown) => {
        if (v == null) return;
        if (typeof v === 'string') {
            let m: RegExpExecArray | null;
            CWE_RE.lastIndex = 0;
            while ((m = CWE_RE.exec(v)) !== null) out.add(`CWE-${m[1]}`);
        } else if (Array.isArray(v)) {
            v.forEach(walk);
        } else if (typeof v === 'object') {
            Object.values(v as Record<string, unknown>).forEach(walk);
        }
    };
    values.forEach(walk);
    return [...out];
}

function asNumber(v: unknown): number | null {
    if (typeof v === 'number' && !Number.isNaN(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
    return null;
}

function pickSecuritySeverity(...bags: unknown[]): number | null {
    for (const bag of bags) {
        if (bag && typeof bag === 'object') {
            const n = asNumber((bag as Record<string, unknown>)['security-severity']);
            if (n != null) return n;
        }
    }
    return null;
}

/** First non-empty value of a SARIF fingerprints/partialFingerprints map. */
function toolFingerprint(...bags: unknown[]): string | null {
    for (const bag of bags) {
        if (bag && typeof bag === 'object') {
            for (const val of Object.values(bag as Record<string, unknown>)) {
                if (typeof val === 'string' && val.trim() !== '') return val;
            }
        }
    }
    return null;
}

function sha256(s: string): string {
    return createHash('sha256').update(s).digest('hex');
}

interface SarifResult {
    ruleId?: string;
    ruleIndex?: number;
    level?: string;
    message?: { text?: string };
    locations?: {
        physicalLocation?: {
            artifactLocation?: { uri?: string };
            region?: { startLine?: number };
        };
    }[];
    fingerprints?: Record<string, unknown>;
    partialFingerprints?: Record<string, unknown>;
    properties?: Record<string, unknown>;
    taxa?: unknown;
}

interface SarifRule {
    id?: string;
    name?: string;
    shortDescription?: { text?: string };
    properties?: Record<string, unknown>;
    relationships?: unknown;
}

/**
 * Parse a SARIF 2.1.0 document into normalised findings. Defensive by
 * design — scanners vary wildly in which optional fields they populate,
 * so every access is guarded and a malformed run yields `findings: []`
 * rather than throwing. Throws only when `input` is not SARIF-shaped at
 * all (no `runs` array), so the caller can 400 a bad upload.
 */
export function parseSarif(input: unknown): ParsedSarif {
    if (!input || typeof input !== 'object' || !Array.isArray((input as { runs?: unknown }).runs)) {
        throw new Error('Not a SARIF document: missing `runs` array');
    }
    const runs = (input as { runs: unknown[] }).runs;

    let toolName = 'Unknown';
    const findings: NormalizedScannerFinding[] = [];

    for (const run of runs) {
        if (!run || typeof run !== 'object') continue;
        const r = run as {
            tool?: { driver?: { name?: string; rules?: SarifRule[] } };
            results?: SarifResult[];
        };
        const driver = r.tool?.driver;
        if (driver?.name) toolName = driver.name;
        const rules = Array.isArray(driver?.rules) ? driver!.rules! : [];
        const ruleById = new Map<string, SarifRule>();
        rules.forEach((rule) => {
            if (rule?.id) ruleById.set(rule.id, rule);
        });

        const results = Array.isArray(r.results) ? r.results : [];
        for (let i = 0; i < results.length; i++) {
            const res = results[i];
            if (!res || typeof res !== 'object') continue;

            const ruleId =
                res.ruleId ??
                (typeof res.ruleIndex === 'number' ? rules[res.ruleIndex]?.id : undefined) ??
                'unknown-rule';
            const rule = ruleById.get(ruleId) ?? (typeof res.ruleIndex === 'number' ? rules[res.ruleIndex] : undefined);

            const loc = res.locations?.[0]?.physicalLocation;
            const uri = loc?.artifactLocation?.uri;
            const startLine = loc?.region?.startLine;
            const location = uri ? (startLine ? `${uri}:${startLine}` : uri) : null;

            const messageText = res.message?.text?.trim() || '';
            const title =
                rule?.shortDescription?.text?.trim() ||
                rule?.name?.trim() ||
                (messageText ? messageText.split('\n')[0].slice(0, 200) : ruleId);

            // Severity: security-severity (rule then result) wins, else level.
            const secSev = pickSecuritySeverity(rule?.properties, res.properties);
            const severity: ScannerSeverity =
                secSev != null
                    ? securitySeverityToSeverity(secSev)
                    : SARIF_LEVEL_TO_SEVERITY[(res.level ?? 'none').toLowerCase()] ?? 'LOW';

            const cweIds = extractCwes(rule?.properties, rule?.relationships, res.properties, res.taxa, ruleId, title);

            // Fingerprint: prefer the tool's own (stable across re-scans),
            // else SHA-256 of the dedup tuple (ruleId, location, message).
            //
            // `\0` is the tuple delimiter — a byte no SARIF field can contain,
            // so the parts cannot be re-cut a different way. It is written as
            // the ESCAPE, not as a raw byte: a raw 0x00 makes this whole file
            // binary to POSIX tooling (`grep` then reports zero matches rather
            // than an error) and the guard at
            // tests/guardrails/no-control-bytes-in-source.test.ts bans it.
            // The escape is byte-identical, so the fingerprints ALREADY
            // PERSISTED in ScannerFinding.fingerprint are unchanged — do not
            // "simplify" this delimiter to a printable character, which would
            // re-fingerprint every historical finding.
            const toolFp = toolFingerprint(res.fingerprints, res.partialFingerprints);
            const fingerprint = toolFp
                ? sha256(`${ruleId}\0${toolFp}`)
                : sha256(`${ruleId}\0${uri ?? ''}\0${startLine ?? ''}\0${messageText}`);

            findings.push({
                fingerprint,
                ruleId,
                severity,
                title,
                description: messageText || null,
                location,
                cweIds,
            });
        }
    }

    const { source, scanType } = inferTool(toolName);
    return { toolName, source, scanType, findings };
}
