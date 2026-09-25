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

import { AD_LEAVER_WRITES_FIELD } from './providers/active-directory/write-direction';

export type IdentityWriteReadiness =
    /** A dedicated write credential is configured for this connection. */
    | 'DEDICATED_WRITE_BIND'
    /** Only the read bind exists; every write runs as it and may be refused. */
    | 'READ_BIND_ONLY'
    /**
     * The connection writes with an APPLICATION credential rather than a bind —
     * Entra's client-credentials grant (#2843).
     *
     * Added because the three values above are LDAP vocabulary and were being
     * applied to a directory that has no binds at all. An Entra connection has
     * neither `writeBindDN` nor `bindDN`, so it fell through every arm to the
     * last one and was reported as *"No bind credential is configured for this
     * connection at all, so no write can be attempted"* — false for a fully
     * working connection, and printed into the DRY_RUN artefact the seven-day
     * dwell exists to produce.
     */
    | 'APPLICATION_CREDENTIAL'
    /** Secrets would not decrypt — we cannot see which, and must not guess. */
    | 'UNKNOWN';

export interface WriteReadinessReport {
    readonly readiness: IdentityWriteReadiness;
    /** Operator-facing sentence. Never asserts that a write will succeed. */
    readonly detail: string;
}

export interface ReadinessInput {
    /**
     * WHICH DIRECTORY this connection is for (#2843).
     *
     * Required, and deliberately not optional-with-a-default: the readiness
     * vocabulary is not shared between providers, and a default would silently
     * describe one directory in another's terms — which is the whole defect.
     */
    readonly provider: string;
    /** Merged connection fields, or null when the secret bag did not decrypt. */
    readonly merged: Record<string, unknown> | null;
    /** configJson alone — always readable, used when `merged` is null. */
    readonly config: Record<string, unknown>;
}

function present(v: unknown): boolean {
    return String(v ?? '').trim() !== '';
}

export function describeWriteReadiness({
    provider,
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
    // ── ENTRA: an application credential, not a bind.
    //
    // Answered BEFORE the bind arms rather than after, because the bind arms
    // are exhaustive — the last one has no condition — so anything reaching
    // them gets an LDAP verdict whether or not LDAP is involved. That is how a
    // working Entra connection came to be described as having no credential.
    //
    // It names `writesEnabled`, which is what actually gates an Entra write:
    // the writer refuses to construct unless it is exactly `true`. A readiness
    // report that omits the one flag standing between this connection and a
    // directory write is answering a question nobody asked.
    if (provider === 'entra-id') {
        const consented = merged.writesEnabled === true;
        if (!present(merged.clientSecret)) {
            return {
                readiness: 'UNKNOWN',
                detail:
                    'No client secret is readable on this Entra connection, so whether it can ' +
                    'authenticate is unknown. Entra writes with an application credential, not a ' +
                    'bind — the absence of a bind DN says nothing about it either way.',
            };
        }
        return {
            readiness: 'APPLICATION_CREDENTIAL',
            detail: consented
                ? 'This connection writes with its application credential and has "Allow ' +
                  'offboarding writes" on. Whether the tenant has consented the Graph permission ' +
                  'a disable needs is only established by attempting one.'
                : 'This connection writes with its application credential, but "Allow offboarding ' +
                  'writes" is OFF, so the writer refuses to construct and no disable is attempted. ' +
                  'That is a deliberate per-connection opt-out, not a misconfiguration.',
        };
    }

    // The LDAP arms carry the SAME opt-in the Entra arm above names, for the
    // same reason (#2892 finding 4).
    //
    // Since #2857 an AD leaver write is gated on `AD_LEAVER_WRITES_FIELD`, and
    // `adDirectionWriteRefusal` refuses to construct the writer unless it is
    // exactly `true`. Without this, a connection with a dedicated write bind
    // and the box unticked reports "a dedicated write credential is
    // configured" — and is then refused WRITES_NOT_ENABLED at AUTOMATIC and
    // disables nobody. The bind half of that sentence is true; read during the
    // seven-day DRY_RUN dwell, the whole of it is what an operator is deciding
    // on.
    //
    // It bites every AD connection that exists rather than a misconfigured
    // few: the field has no legacy, so a connection predating #2857 has never
    // stored it and reads as not consented.
    //
    // The READINESS VALUE is left alone and only the detail changes, exactly as
    // the Entra arm does it. The value answers "what kind of credential is
    // this", which the opt-in does not change; collapsing a consent question
    // into a credential vocabulary is what produced the wrong Entra verdict
    // this function already carries a comment about.
    const adConsented = merged[AD_LEAVER_WRITES_FIELD] === true;
    const adOptOut =
        ' "Allow offboarding writes" is OFF on this connection, so the writer refuses to ' +
        'construct and no disable is attempted. That is a deliberate per-connection opt-out, ' +
        'not a misconfiguration.';

    if (present(merged.writeBindDN)) {
        return {
            readiness: 'DEDICATED_WRITE_BIND',
            detail: adConsented
                ? 'A dedicated write credential is configured and "Allow offboarding writes" ' +
                  'is on. Whether it holds the directory rights a disable needs is only ' +
                  'established by attempting one.'
                : 'A dedicated write credential is configured, but' + adOptOut,
        };
    }
    if (present(config.bindDN) || present(merged.bindDN)) {
        return {
            readiness: 'READ_BIND_ONLY',
            detail: adConsented
                ? 'No dedicated write credential is configured, so writes run as the read ' +
                  'bind. If it lacks the delegation, every disable is refused with LDAP ' +
                  'result 50 and the leaver is not offboarded.'
                : 'No dedicated write credential is configured, so writes would run as the ' +
                  'read bind — but' + adOptOut,
        };
    }
    return {
        readiness: 'READ_BIND_ONLY',
        detail:
            'No bind credential is configured for this connection at all, so no write can ' +
            'be attempted.',
    };
}
