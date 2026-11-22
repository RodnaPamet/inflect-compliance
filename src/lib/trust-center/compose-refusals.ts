/**
 * Why a trust-center compose save was refused by name (#5764).
 *
 * `upsertTrustCenter` names its permission refusal in `error.details.reason`
 * beside an English `error.message`; the admin page maps a known reason to its
 * own translated sentence (`admin.trustCenter.refusal.<reason>`).
 *
 * Client-safe: no server imports, so the compose form can read the reasons.
 */

export const TRUST_CENTER_COMPOSE_NEEDS_ADMIN_MANAGE = 'TRUST_CENTER_COMPOSE_NEEDS_ADMIN_MANAGE';

export const TRUST_CENTER_COMPOSE_REFUSALS = [TRUST_CENTER_COMPOSE_NEEDS_ADMIN_MANAGE] as const;

export type TrustCenterComposeRefusal = (typeof TRUST_CENTER_COMPOSE_REFUSALS)[number];

const KNOWN: ReadonlySet<string> = new Set<string>(TRUST_CENTER_COMPOSE_REFUSALS);

/** The named reason in a parsed API error body, or null when it names none of these. */
export function trustCenterComposeRefusal(body: unknown): TrustCenterComposeRefusal | null {
    const reason = (body as { error?: { details?: { reason?: unknown } } } | null)?.error
        ?.details?.reason;
    return typeof reason === 'string' && KNOWN.has(reason) ? (reason as TrustCenterComposeRefusal) : null;
}
