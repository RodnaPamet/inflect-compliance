/**
 * Applying a retention date is a SECOND write, and it can fail on its own.
 *
 * Evidence is created first (upload, or SharePoint import), then
 * `POST /evidence/{id}/retention` stamps the date. That is two round trips,
 * so there is a state where the row exists and the retention does not — and
 * the upload path used to fire the second one and never look at the
 * response:
 *
 *     if (vars.retentionUntil && uploaded?.id) {
 *         await fetch(apiUrl(`/evidence/${uploaded.id}/retention`), { … });
 *     }
 *     return uploaded;
 *
 * A non-ok reply was swallowed, the dropzone reported success, and the modal
 * closed. The user saw a green row with no retention on it and no reason
 * given. `EditEvidenceModal` already handles exactly this case and says so in
 * its own comment ("PARTIAL SAVE … the user has to be told which half").
 *
 * This is that handling, in one place, for the paths that create rows.
 */
/**
 * `apiUrl` is passed IN rather than imported: it is a tenant-scoped prop
 * threaded through the evidence components (it prefixes `/api/t/<slug>`),
 * not a module-level export. Taking it as an argument also keeps this
 * helper testable without mounting anything.
 */
type ApiUrl = (path: string) => string;

export class RetentionNotApplied extends Error {
    readonly evidenceIds: string[];
    constructor(evidenceIds: string[], cause?: string) {
        super(cause ?? 'Retention could not be applied');
        this.name = 'RetentionNotApplied';
        this.evidenceIds = evidenceIds;
    }
}

/**
 * Stamp `retentionUntil` on one evidence row.
 *
 * Throws `RetentionNotApplied` when the row was created but the date was
 * not — which is the whole point. The caller decides how to surface it; what
 * it must not do is report unqualified success.
 */
export async function applyEvidenceRetention(
    apiUrl: ApiUrl,
    evidenceId: string,
    retentionUntil: string,
    init?: { signal?: AbortSignal },
): Promise<void> {
    const res = await fetch(apiUrl(`/evidence/${evidenceId}/retention`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            retentionUntil: new Date(retentionUntil).toISOString(),
            retentionPolicy: 'FIXED_DATE',
        }),
        signal: init?.signal,
    });
    if (!res.ok) throw new RetentionNotApplied([evidenceId]);
}

/**
 * Stamp the same date across a batch, reporting which rows missed it.
 *
 * Used by the SharePoint import, which creates N rows in one server call and
 * gets their ids back. Deliberately settles ALL of them rather than
 * short-circuiting: a half-applied batch is the state the user needs named,
 * and stopping at the first failure would leave the rest unattempted for no
 * benefit.
 */
export async function applyEvidenceRetentionBatch(
    apiUrl: ApiUrl,
    evidenceIds: string[],
    retentionUntil: string,
    init?: { signal?: AbortSignal },
): Promise<void> {
    const results = await Promise.allSettled(
        evidenceIds.map((id) => applyEvidenceRetention(apiUrl, id, retentionUntil, init)),
    );
    const failed = evidenceIds.filter((_, i) => results[i].status === 'rejected');
    if (failed.length > 0) throw new RetentionNotApplied(failed);
}
