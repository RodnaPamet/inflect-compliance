/**
 * The access-review scopes, and what each one means to the code that reads it.
 *
 * `AccessReviewScope` is a Prisma enum that has grown three times — CONNECTED_APP
 * (PR-7), LEGACY_APP (legacy Step 5b) and AGENT (agentic Step 3a). Each time a
 * reader that branched on two of the values and fell through on the rest was the
 * defect: the close route routed an unknown scope to the MEMBER close, which has
 * no zero-subject guard, and the detail page rendered an unknown scope's
 * subjects from the member table, which is empty for every non-member scope.
 * So the facts a reader needs live here, keyed EXHAUSTIVELY on the stored value,
 * and a value added to the enum without an entry fails `npm run typecheck`
 * (`tests/guards/access-review-agent-scope.test.ts` carries the proof).
 *
 * No server imports, so a client component can hold it.
 *
 * ── AGENT, deploy 1 of 2 (#3674) ────────────────────────────────────────
 *
 * The value exists and every reader knows it; nothing creates an AGENT
 * campaign, and every path that would DECIDE or CLOSE one refuses with
 * `AGENT_CAMPAIGN_NOT_AVAILABLE`. That is the whole point of the first deploy:
 * by the time deploy 2's writer stores the value, no container still running
 * predates the code that reads it, and none of them acts on a campaign whose
 * rules (the owner may not decide their own agent; a narrowing only deletes)
 * it does not implement. `AGENT_CAMPAIGNS_IMPLEMENTED` is the brake deploy 2
 * releases, in a reviewed diff.
 */

/** Every value `AccessReview.scope` can hold, in declaration order. */
export const ACCESS_REVIEW_SCOPES = [
    'ALL_USERS',
    'ADMIN_ONLY',
    'CUSTOM',
    'CONNECTED_APP',
    'LEGACY_APP',
    'AGENT',
] as const;

export type StoredAccessReviewScope = (typeof ACCESS_REVIEW_SCOPES)[number];

/**
 * The scopes the MEMBER flow (`createAccessReview`, `closeAccessReview`)
 * snapshots and closes. The only scopes `POST /access-reviews` accepts: the
 * other three have their own creation paths, and a member campaign stamped with
 * one of them snapshots tenant memberships into a campaign whose close and
 * detail page read the other decision table — an unclosable campaign.
 */
export const MEMBER_ACCESS_REVIEW_SCOPES = ['ALL_USERS', 'ADMIN_ONLY', 'CUSTOM'] as const;

export type MemberAccessReviewScope = (typeof MEMBER_ACCESS_REVIEW_SCOPES)[number];

export function isMemberScope(scope: string): scope is MemberAccessReviewScope {
    return (MEMBER_ACCESS_REVIEW_SCOPES as readonly string[]).includes(scope);
}

/**
 * Which decision table holds a scope's subjects.
 *
 * `MEMBER` is `AccessReviewDecision` (a tenant membership per row); `CONNECTED`
 * is `AccessReviewConnectedDecision` (a frozen `snapshotJson` per row). AGENT is
 * CONNECTED, as LEGACY_APP is: a third decision model would be a third copy of
 * reminders, closing and the evidence PDF.
 */
export const SUBJECT_TABLE: Readonly<Record<StoredAccessReviewScope, 'MEMBER' | 'CONNECTED'>> = {
    ALL_USERS: 'MEMBER',
    ADMIN_ONLY: 'MEMBER',
    CUSTOM: 'MEMBER',
    CONNECTED_APP: 'CONNECTED',
    LEGACY_APP: 'CONNECTED',
    AGENT: 'CONNECTED',
};

/**
 * The decision table for a scope read back from a row.
 *
 * An unrecognised value answers `CONNECTED`, not `MEMBER`: the member close has
 * no zero-subject guard (its creation refuses an empty scope instead), so an
 * unknown scope routed there would close over zero member rows and produce
 * evidence. The connected close refuses zero subjects.
 */
export function subjectTableOf(scope: string): 'MEMBER' | 'CONNECTED' {
    return (SUBJECT_TABLE as Record<string, 'MEMBER' | 'CONNECTED' | undefined>)[scope] ?? 'CONNECTED';
}

/**
 * The i18n key under `accessReviews.scopeLabels` for a scope.
 *
 * Keyed on the stored value itself, so a value with no label is a missing key
 * the message-parity guard reports, not a `replace('_', ' ')` of the raw enum.
 */
export function scopeLabelKey(scope: string): StoredAccessReviewScope | 'UNKNOWN' {
    return (ACCESS_REVIEW_SCOPES as readonly string[]).includes(scope)
        ? (scope as StoredAccessReviewScope)
        : 'UNKNOWN';
}

/**
 * Deploy 1 of 2: no AGENT campaign is created, decided or closed. Deploy 2 sets
 * this to `true` in the same pull request that adds the one writer.
 */
export const AGENT_CAMPAIGNS_IMPLEMENTED = false;

/** The named refusal every path that would act on an AGENT campaign gives. */
export const AGENT_CAMPAIGN_REFUSAL = 'AGENT_CAMPAIGN_NOT_AVAILABLE';

/**
 * May this caller read an AGENT campaign's SUBJECTS?
 *
 * A subject is a registered agent, and the register is read under
 * `admin.agent_registry` (`listRegisteredAgents`), which READER, EDITOR and
 * AUDITOR do not hold. `access_reviews.view` is held by every role, so an AGENT
 * campaign's subject rows would otherwise publish register data — names,
 * owners, grants — to every member. The roadmap narrows the pack read to the
 * assigned reviewer or a holder of `admin.agent_registry`, as `decide` narrows
 * to the assigned reviewer; the subjects are the same data, so they narrow the
 * same way. Everybody else still sees the campaign and its progress counts.
 */
export function mayReadAgentSubjects(input: {
    readonly userId: string;
    readonly reviewerUserId: string;
    readonly holdsAgentRegistry: boolean;
}): boolean {
    return input.userId === input.reviewerUserId || input.holdsAgentRegistry;
}

/**
 * The frozen subject of one AGENT campaign row, as `snapshotJson` holds it.
 *
 * Declared in deploy 1 although deploy 1 writes none, because this is the shape
 * deploy-1 readers render: a container running this build during deploy 2's
 * rollout reads rows deploy 2 wrote, and it must find the fields it looks for.
 * Deploy 2's writer is typed against this interface for the same reason.
 *
 * Register data only to the readers `mayReadAgentSubjects` admits.
 */
export interface AgentSubjectSnapshot {
    readonly kind: 'AGENT';
    readonly agentId: string;
    readonly agentName: string | null;
    readonly agentStatus: string | null;
    readonly ownerUserId: string | null;
    readonly ownerEmail: string | null;
    /** Tool grants the agent held when the campaign was created. */
    readonly grantCount: number | null;
}

/**
 * Narrow a stored `snapshotJson` to an agent subject, or `null` when it is not
 * one (a redacted row, a malformed row, a row of another scope). Degrades
 * field by field rather than throwing, so one bad row cannot take a campaign
 * page down.
 */
export function readAgentSubjectSnapshot(value: unknown): AgentSubjectSnapshot | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const v = value as Record<string, unknown>;
    if (v.kind !== 'AGENT' || typeof v.agentId !== 'string') return null;
    const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);
    return {
        kind: 'AGENT',
        agentId: v.agentId,
        agentName: str(v.agentName),
        agentStatus: str(v.agentStatus),
        ownerUserId: str(v.ownerUserId),
        ownerEmail: str(v.ownerEmail),
        grantCount: typeof v.grantCount === 'number' && Number.isFinite(v.grantCount) ? v.grantCount : null,
    };
}
