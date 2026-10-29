/**
 * What a "Sync now" result says, decided once for both pages that offer it.
 *
 * `POST /admin/integrations/:id/sync` answers 200 for a sync that did not
 * work. `runIdentitySync` and the HRIS job record a failed or truncated read as
 * `status: 'ERROR' | 'PARTIAL'` and return, and a contended connection returns
 * `SKIPPED`. The pages used to decide the banner's colour from `counts.error`
 * alone and its account count from `identity.upserted` alone, so a revoked
 * Okta credential read "Sync complete — 0 checks (0 passed, 0 failed), 0
 * accounts synced." in green, and an HR sync of 300 people read "0 accounts
 * synced" (#4466).
 *
 * Pure, and returns message KEYS rather than sentences, so the decision is
 * unit-testable without mounting either page and the words stay in
 * `messages/*.json`.
 */

/** One sync arm of the response — the directory read or the HR roster read. */
export interface SyncArmResult {
    readonly status: string;
    readonly upserted: number;
    readonly errorMessage?: string;
}

/** The parts of the sync route's response this summary reads. */
export interface SyncConnectionResponse {
    readonly identity?: SyncArmResult | null;
    readonly hris?: SyncArmResult | null;
    readonly counts?: {
        readonly total: number;
        readonly passed: number;
        readonly failed: number;
        readonly error: number;
    };
}

export type SyncTone = 'success' | 'warning' | 'error';

/** Keys under `admin.integrations.syncResult`. */
export type SyncMessageKey =
    | 'directoryPassed'
    | 'directoryPartial'
    | 'directoryError'
    | 'directorySkipped'
    | 'hrPassed'
    | 'hrPartial'
    | 'hrError'
    | 'hrSkipped'
    | 'checks'
    | 'ranNothing'
    | 'reason';

export interface SyncMessagePart {
    readonly key: SyncMessageKey;
    readonly values?: Record<string, string | number>;
}

export interface SyncSummary {
    readonly tone: SyncTone;
    readonly parts: readonly SyncMessagePart[];
}

type ArmOutcome = 'Passed' | 'Partial' | 'Error' | 'Skipped';

/**
 * A status this build does not know reads as an ERROR. A newer sync status
 * reaching an older page must not be reported as a success.
 */
function armOutcome(status: string): ArmOutcome {
    switch (status) {
        case 'PASSED':
            return 'Passed';
        case 'PARTIAL':
            return 'Partial';
        case 'SKIPPED':
            return 'Skipped';
        default:
            return 'Error';
    }
}

function armParts(prefix: 'directory' | 'hr', arm: SyncArmResult): SyncMessagePart[] {
    const outcome = armOutcome(arm.status);
    const parts: SyncMessagePart[] = [
        { key: `${prefix}${outcome}` as SyncMessageKey, values: { count: arm.upserted } },
    ];
    // The sync's own sentence, when it wrote one, for the two outcomes where
    // something went wrong. A PASSED or SKIPPED run has nothing to explain.
    if ((outcome === 'Error' || outcome === 'Partial') && arm.errorMessage?.trim()) {
        parts.push({ key: 'reason', values: { reason: arm.errorMessage.trim() } });
    }
    return parts;
}

export function summariseSync(res: SyncConnectionResponse): SyncSummary {
    const counts = res.counts ?? { total: 0, passed: 0, failed: 0, error: 0 };
    const arms = [res.identity, res.hris].filter((a): a is SyncArmResult => a != null);

    const parts: SyncMessagePart[] = [];
    if (res.identity) parts.push(...armParts('directory', res.identity));
    if (res.hris) parts.push(...armParts('hr', res.hris));

    if (counts.total > 0) {
        parts.push({
            key: 'checks',
            values: { total: counts.total, passed: counts.passed, failed: counts.failed, errored: counts.error },
        });
    } else if (arms.length === 0) {
        // Nothing read and no check wired: say so, rather than "0 checks".
        parts.push({ key: 'ranNothing' });
    }

    // A sync that read nothing and ran nothing is not an error, but it is not
    // a green "done" either: it collected nothing, and the outcome page always
    // treated it so.
    const ranNothing = arms.length === 0 && counts.total === 0;
    const outcomes = arms.map((a) => armOutcome(a.status));
    const tone: SyncTone =
        counts.error > 0 || outcomes.includes('Error')
            ? 'error'
            : ranNothing || outcomes.includes('Partial') || outcomes.includes('Skipped')
              ? 'warning'
              : 'success';

    return { tone, parts };
}
