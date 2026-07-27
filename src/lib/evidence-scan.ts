/**
 * Client-safe AV scan gate for evidence UI (R5-P2 #1).
 *
 * The server predicate `isDownloadAllowed` (src/lib/storage/av-scan.ts) reads
 * `env.AV_SCAN_MODE`, a server-only var — importing it in a client component
 * throws under t3-env. This mirrors its STRICT posture so the UI refuses a
 * download/preview/thumbnail before the server has to: only a scan that has
 * completed CLEAN (or was SKIPPED) is servable. INFECTED is never servable;
 * PENDING (the state every file is in the moment it's stored, until the async
 * scan finishes) is treated as not-yet-servable rather than optimistically shown.
 */
export type EvidenceScanStatus = 'PENDING' | 'CLEAN' | 'INFECTED' | 'SKIPPED' | string | null | undefined;

/** True only when the file has a completed clean (or skipped) scan. */
export function isScanServable(scanStatus: EvidenceScanStatus): boolean {
    return scanStatus === 'CLEAN' || scanStatus === 'SKIPPED';
}

/** True when the file is confirmed infected — never serve, badge as blocked. */
export function isScanInfected(scanStatus: EvidenceScanStatus): boolean {
    return scanStatus === 'INFECTED';
}

/** True while the scan is still pending (or status is unknown). */
export function isScanPending(scanStatus: EvidenceScanStatus): boolean {
    return !scanStatus || scanStatus === 'PENDING';
}
