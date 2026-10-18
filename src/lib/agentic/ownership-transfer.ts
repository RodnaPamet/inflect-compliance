/**
 * AGENT OWNERSHIP TRANSFER — the vocabulary the two steps share (#3698, step 2a).
 *
 * An agent's accountable owner (`RegisteredAgent.ownerUserId`) is what the
 * two-person rules downstream compare against, and what 2b's departed-owner
 * pass will read. So it moves only by a TWO-STEP transfer: step one records who
 * should become the owner, and only that person completes it — never the person
 * who started it. Both steps take `admin.tenant_lifecycle` (step 0e). The
 * usecases are `src/app-layer/usecases/agent-ownership-transfer.ts`; this module
 * is the part the usecases, the database refusals and the tests all read, and it
 * carries no server import.
 */

/**
 * The four states, in the order a row can reach them. A row leaves PENDING once
 * and is then immutable (trigger `agent_ownership_transfer_one_way`), and the
 * table's CHECK pins this exact set.
 */
export const AGENT_OWNERSHIP_TRANSFER_STATUSES = [
    'PENDING',
    'COMPLETED',
    'CANCELLED',
    'EXPIRED',
] as const;
export type AgentOwnershipTransferStatus = (typeof AGENT_OWNERSHIP_TRANSFER_STATUSES)[number];

/**
 * How long step two stays completable. Seven days, the tenant-invite TTL
 * (`tenant-invites.ts`): the same kind of thing — a standing offer to one named
 * person — with the same answer to "what if they never act": it lapses, and is
 * proposed again. No sweep job expires it; the completion claim checks the clock
 * itself, and the next request that finds a lapsed row marks it EXPIRED.
 */
export const AGENT_OWNERSHIP_TRANSFER_TTL_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The BUILT-IN membership roles a transfer's recipient must hold, besides the
 * key.
 *
 * Both steps live under `/api/t/:slug/admin/`, and the edge middleware answers
 * every such request 403 "Admin access required" — before any handler or
 * `requirePermission` runs, and writing no `AUTHZ_DENIED` row — unless the
 * session's built-in role is ADMIN or OWNER (`src/middleware.ts`, "Admin-only
 * paths"). A custom role never enters that check: `assignCustomRole` writes
 * only `customRoleId`, so a READER an OWNER gave a custom role carrying
 * `admin.tenant_lifecycle` still reads as READER at the edge, and could never
 * reach step two. Step one therefore asks both questions step two will meet:
 * this role, at the edge, and the key, at the route.
 *
 * So the recipients are: an OWNER, or an ADMIN whose custom role carries the
 * key. `tests/unit/agent-ownership-transfer-edge-gate.test.ts` runs the real
 * middleware against the completion route for every built-in role and fails if
 * this set and the edge ever disagree.
 *
 * This narrow set is the owner's accepted INTERIM state (decided 2026-10-18).
 * A new built-in `AI_ADMIN` role is to widen who can receive an agent, in its
 * own pull request; widening it here instead — admitting a READER, EDITOR or
 * AUDITOR custodian by loosening the edge gate for these paths — would be a
 * security-middleware change this module must not make on its own.
 *
 * The role the edge reads is the one in THIS tenant's membership, taken from
 * the session's `memberships[]` entry for the URL's slug (#3701), so this
 * predicate and the edge read the same row. Until #3701 the edge read the
 * session's primary (oldest) membership instead, which refused an OWNER here
 * whose oldest membership was a READER elsewhere.
 */
export const TRANSFER_RECIPIENT_MEMBERSHIP_ROLES = ['OWNER', 'ADMIN'] as const;

/** Whether a built-in membership role can reach the transfer routes at all. */
export function isTransferRecipientMembershipRole(role: string): boolean {
    return (TRANSFER_RECIPIENT_MEMBERSHIP_ROLES as readonly string[]).includes(role);
}

/** The step-two deadline for a transfer proposed at `now`. */
export function transferExpiresAt(now: Date): Date {
    return new Date(now.getTime() + AGENT_OWNERSHIP_TRANSFER_TTL_DAYS * DAY_MS);
}

/**
 * The status a row ACTUALLY has at `now`. A PENDING row whose deadline has
 * passed is EXPIRED whether or not a request has yet stamped it so — expiry is
 * lazy, and a reader must not report as completable what the claim would
 * refuse. The boundary is the claim's: `expiresAt > now` is open, so
 * `expiresAt <= now` is expired.
 */
export function effectiveTransferStatus(
    row: { readonly status: string; readonly expiresAt: Date },
    now: Date,
): AgentOwnershipTransferStatus {
    if (row.status === 'PENDING' && row.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
    return isTransferStatus(row.status) ? row.status : 'EXPIRED';
}

function isTransferStatus(value: string): value is AgentOwnershipTransferStatus {
    return (AGENT_OWNERSHIP_TRANSFER_STATUSES as readonly string[]).includes(value);
}

/**
 * The prefix the one-way trigger raises with, matched the way
 * `isAgentRetiredDbRefusal` matches its triggers: the prefix is ours, the
 * driver's SQLSTATE surface is not stable.
 */
export const AGENT_OWNERSHIP_TRANSFER_CLOSED_DB_REFUSAL = 'AGENT_OWNERSHIP_TRANSFER_CLOSED';
