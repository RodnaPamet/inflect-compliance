/**
 * Which version of a policy each lifecycle action acts on — ONE set of rules
 * shared by the usecases (`src/app-layer/usecases/policy.ts`) and the policy
 * detail page, so a button and the server cannot disagree about its target
 * (#4127).
 *
 * Pure, and free of server imports: the detail page is a client component.
 *
 * Vocabulary:
 *
 *   - `currentVersionId` is the PUBLISHED pointer. It moves only on publish
 *     and rollback (it is also seeded when a policy is created with content,
 *     before anything is published). It is never "the newest version", and
 *     it means "live" only while the policy's status is PUBLISHED.
 *   - The NEWEST version is the highest `versionNumber`. It is what an editor
 *     starts from, what an approval request from the page header asks about,
 *     and what an emergency publish publishes.
 *   - A REVISION is a version newer than the live one, on a PUBLISHED policy.
 *     It goes through request → approve → publish while the policy stays
 *     PUBLISHED, so the live version keeps serving acknowledgements until the
 *     revision replaces it.
 */

type DateLike = string | Date | null | undefined;

export interface PublicationVersion {
    id: string;
    versionNumber: number;
}

export interface PublicationApproval {
    policyVersionId?: string | null;
    status: string;
    createdAt?: DateLike;
    decidedAt?: DateLike;
}

export interface PublicationPolicy<V extends PublicationVersion = PublicationVersion> {
    status: string;
    currentVersionId?: string | null;
    versions?: ReadonlyArray<V> | null;
    approvals?: ReadonlyArray<PublicationApproval> | null;
}

const time = (d: DateLike): number => (d ? new Date(d).getTime() || 0 : 0);

/** The highest-numbered version, or null when the policy has none. */
export function newestVersion<V extends PublicationVersion>(
    versions: ReadonlyArray<V> | null | undefined,
): V | null {
    let newest: V | null = null;
    for (const v of versions ?? []) {
        if (!newest || v.versionNumber > newest.versionNumber) newest = v;
    }
    return newest;
}

/** The version staff are following right now — only while PUBLISHED. */
export function liveVersion<V extends PublicationVersion>(p: PublicationPolicy<V>): V | null {
    if (p.status !== 'PUBLISHED' || !p.currentVersionId) return null;
    return (p.versions ?? []).find((v) => v.id === p.currentVersionId) ?? null;
}

/**
 * Is `candidate` a revision of the live version?
 *
 * Strictly NEWER, not merely different: an older version is not a revision
 * of the live one, and going back to one is what rollback is for.
 */
export function isRevisionOf(
    live: PublicationVersion | null | undefined,
    candidate: PublicationVersion | null | undefined,
): boolean {
    if (!live || !candidate) return false;
    return candidate.id !== live.id && candidate.versionNumber > live.versionNumber;
}

/** Is `versionId` a revision of this policy's live version? */
export function isRevisionOfLiveVersion(p: PublicationPolicy, versionId: string | null | undefined): boolean {
    if (!versionId) return false;
    const candidate = (p.versions ?? []).find((v) => v.id === versionId);
    return isRevisionOf(liveVersion(p), candidate);
}

/**
 * The single version a publish (without a bypass) would be accepted for, or
 * null when there is none.
 *
 *   - APPROVED: the version of the most recently DECIDED approval — the same
 *     row `PolicyApprovalRepository.latestApproved` returns, which
 *     `publishPolicy` binds to.
 *   - PUBLISHED: a revision whose approval is the policy's LATEST approval
 *     cycle (by request time). A later request — still open, rejected, or
 *     superseded by a publish — ends that approval's standing, the same way
 *     requesting approval again moves an APPROVED policy back to IN_REVIEW.
 *   - Any other status: nothing is publishable without a bypass.
 */
export function publishableVersionId(p: PublicationPolicy): string | null {
    const approvals = p.approvals ?? [];
    if (p.status === 'APPROVED') {
        const latestApproved = approvals
            .filter((a) => a.status === 'APPROVED')
            .sort((a, b) => time(b.decidedAt) - time(a.decidedAt))[0];
        return latestApproved?.policyVersionId ?? null;
    }
    if (p.status === 'PUBLISHED') {
        const latest = [...approvals].sort(
            (a, b) => time(b.createdAt ?? b.decidedAt) - time(a.createdAt ?? a.decidedAt),
        )[0];
        if (latest?.status !== 'APPROVED') return null;
        return isRevisionOfLiveVersion(p, latest.policyVersionId) ? latest.policyVersionId ?? null : null;
    }
    return null;
}

/**
 * Can this approval still be decided?
 *
 * A PENDING row is decidable while the policy is IN_REVIEW, or while it is
 * PUBLISHED and the row asks about a revision of the live version. Anything
 * else is stale: deciding it would rewrite a state the policy has since left.
 */
export function isApprovalDecidable(p: PublicationPolicy, approval: PublicationApproval): boolean {
    if (approval.status !== 'PENDING') return false;
    if (p.status === 'IN_REVIEW') return true;
    return p.status === 'PUBLISHED' && isRevisionOfLiveVersion(p, approval.policyVersionId);
}
