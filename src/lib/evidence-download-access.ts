/**
 * Whether the evidence download route will serve a record's file to the
 * viewer — the client half of `downloadEvidenceFile`'s record gates, so the
 * list row, the gallery card and the details panel offer a download (and load
 * a preview, which reads the same route) only where it would succeed.
 *
 * The route refuses:
 *   - archived evidence, for every role ("Evidence has been archived and is
 *     no longer available for download");
 *   - evidence linked to no control, for a role without the coarse write tier
 *     (`ctx.permissions.canWrite`) — Readers, Auditors and AI admins.
 *
 * Both used to be offered as a plain `<a download>`, so the refusal reached
 * the browser as a failed download with no reason on the page.
 *
 * The AV-scan gate is separate (`@/lib/evidence-scan`): the surfaces show a
 * scan state in place of the button, not nothing.
 *
 * Pure `.ts` so node-only tests can import it.
 */

export interface DownloadableEvidence {
    isArchived?: boolean | null;
    /** How many controls this record is linked to. */
    controlLinkCount: number;
}

export function mayDownloadEvidenceFile(
    ev: DownloadableEvidence,
    viewer: { canWrite: boolean },
): boolean {
    if (ev.isArchived) return false;
    return viewer.canWrite || ev.controlLinkCount > 0;
}
