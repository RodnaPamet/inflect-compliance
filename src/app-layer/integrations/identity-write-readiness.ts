/**
 * Can THIS connection actually write, and does the operator know before a real
 * leaver finds out?
 *
 * The tenant write ladder (`getIdentityWritePolicy`) answers a different
 * question: whether writes are permitted at all. It is tenant-scoped. Nothing
 * was connection-scoped, so a connection provisioned with the documented
 * baseline — a read-only service-account bind — is indistinguishable from a
 * write-ready one until a disable comes back LDAP result 50.
 *
 * The refusal itself is sound and this does not change it. `writer.ts` falls
 * back to the read bind deliberately and records WHICH credential was used, so
 * a 50 is attributable rather than mysterious. The only thing wrong is the
 * timing: the operator learns on a real leaver, at the moment the disable was
 * supposed to take effect.
 *
 * Shaped after `describeRefusal` in `identity-write-policy.ts`, which is
 * "exported and pure so the reason can be asserted directly, and so the UI can
 * explain the refusal before the operator submits it rather than after."
 *
 * ═══ WHAT THIS DELIBERATELY DOES NOT CLAIM ═══
 *
 * Whether a given bind HOLDS write rights cannot be known without attempting a
 * write. So this reports the CONFIGURATION, never a prediction of success. A
 * dedicated write bind that lacks the delegation still refuses — and it should,
 * because AdminSDHolder re-stamps the ACL on protected-group members hourly,
 * which is exactly the population an offboarding most wants to disable.
 *
 * ═══ AND WHY `UNKNOWN` IS A STATE ═══
 *
 * `bindDN` is config; `writeBindDN` is a SECRET. When the secret bag will not
 * decrypt we cannot see whether a write bind exists — and reporting "none" then
 * would be a failed read recorded as a positive negative, which is the precise
 * defect this subsystem has already been bitten by once, where an unread admin
 * became an authoritative non-admin. An unreadable probe means UNKNOWN.
 */

export type IdentityWriteReadiness =
    /** A dedicated write credential is configured for this connection. */
    | 'DEDICATED_WRITE_BIND'
    /** Only the read bind exists; every write runs as it and may be refused. */
    | 'READ_BIND_ONLY'
    /** Secrets would not decrypt — we cannot see which, and must not guess. */
    | 'UNKNOWN';

export interface WriteReadinessReport {
    readonly readiness: IdentityWriteReadiness;
    /** Operator-facing sentence. Never asserts that a write will succeed. */
    readonly detail: string;
}

export interface ReadinessInput {
    /** Merged connection fields, or null when the secret bag did not decrypt. */
    readonly merged: Record<string, unknown> | null;
    /** configJson alone — always readable, used when `merged` is null. */
    readonly config: Record<string, unknown>;
}

function present(v: unknown): boolean {
    return String(v ?? '').trim() !== '';
}

export function describeWriteReadiness({
    merged,
    config,
}: ReadinessInput): WriteReadinessReport {
    if (merged === null) {
        // Degrade rather than refuse, and SAY SO — the same policy the writer
        // factory applies to its dry-run self-account read.
        return {
            readiness: 'UNKNOWN',
            detail:
                'This connection\'s secrets could not be read, so whether a dedicated write ' +
                'credential is configured is unknown. It is not a report that none exists.',
        };
    }
    if (present(merged.writeBindDN)) {
        return {
            readiness: 'DEDICATED_WRITE_BIND',
            detail:
                'A dedicated write credential is configured. Whether it holds the directory ' +
                'rights a disable needs is only established by attempting one.',
        };
    }
    if (present(config.bindDN) || present(merged.bindDN)) {
        return {
            readiness: 'READ_BIND_ONLY',
            detail:
                'No dedicated write credential is configured, so writes run as the read bind. ' +
                'If it lacks the delegation, every disable is refused with LDAP result 50 and ' +
                'the leaver is not offboarded.',
        };
    }
    return {
        readiness: 'READ_BIND_ONLY',
        detail:
            'No bind credential is configured for this connection at all, so no write can ' +
            'be attempted.',
    };
}
