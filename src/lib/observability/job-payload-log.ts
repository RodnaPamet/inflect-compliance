/**
 * What a job's payload may contribute to a log line (#5635).
 *
 * The worker logged `{ jobName, jobId, payload }` at `info` — every job, every
 * payload, in full. Those lines ship to Cloud Logging (`docs/deployment.md`),
 * a surface with no RLS, no tenant scope and no retention policy, and the
 * payloads carry `recipientOverrides` (email addresses), `remoteData` (remote
 * issue bodies) and four `data: Record<string, unknown>` fields holding entity
 * titles.
 *
 * TWO REASONS THIS IS AN ALLOWLIST AND NOT A LONGER REDACT LIST.
 *
 * 1. A denylist cannot be complete, and the types say so: four payload fields
 *    are declared `Record<string, unknown>`, so their contents are arbitrary
 *    by construction. No list of key names bounds what a tenant puts there.
 *
 * 2. The redaction the repo already has cannot reach them. `logger.ts` redacts
 *    `userPrincipalName`, `distinguishedName`, `sAMAccountName` and
 *    `externalUserId`, and its own comment states the limit: "pino matches a
 *    bare key at the ROOT level only". A nested `payload` put every one of
 *    those fields out of reach, so the line LOOKED covered because the paths
 *    were configured.
 *
 * The same argument was already accepted one surface over: `executor-registry`
 * scrubs identifiers out of a job RESULT (#2877) because Redis is "a store
 * with none of the properties the asymmetry relies on" — and that was a
 * BOUNDED 500-1000 entry window, where this is unbounded retention.
 *
 * @module lib/observability/job-payload-log
 */

/**
 * Payload keys whose VALUES may be logged: opaque correlation ids, no free
 * text, no addresses. `tenantId` is near-universal and mandated by rule 5 of
 * `jobs/types.ts`; the rest are the ids an operator needs to find the row a
 * job acted on.
 *
 * Adding a key here is a decision about what reaches centralised logs. It must
 * be an identifier, never content, and never something a person typed.
 */
export const LOGGABLE_PAYLOAD_KEYS = [
    'tenantId',
    'provider',
    'connectionId',
    'agentId',
    'runId',
    'ruleId',
] as const;

export interface JobPayloadLogFields {
    /**
     * The payload's top-level key NAMES, sorted. A schema fact about the job
     * type — they are declared in `jobs/types.ts`, not supplied by a tenant —
     * so they keep the line useful for debugging while carrying no content.
     */
    readonly payloadKeys: readonly string[];
    readonly [key: string]: unknown;
}

/**
 * Reduce a job payload to the fields a log line may carry.
 *
 * Returned FLAT, so the values land at the root of the log object where pino's
 * existing redaction can still see them — the nesting is what defeated it.
 */
export function jobPayloadLogFields(payload: unknown): JobPayloadLogFields {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        return { payloadKeys: [] };
    }
    const source = payload as Record<string, unknown>;
    const fields: Record<string, unknown> = { payloadKeys: Object.keys(source).sort() };
    for (const key of LOGGABLE_PAYLOAD_KEYS) {
        const value = source[key];
        // STRINGS ONLY. An allowlisted key whose value turns out to be an
        // object or an array would otherwise carry whatever is inside it —
        // the allowlist bounds the key, and this bounds the shape.
        if (typeof value === 'string' && value.length > 0) fields[key] = value;
    }
    return fields as JobPayloadLogFields;
}
