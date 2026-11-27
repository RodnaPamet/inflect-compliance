/**
 * The CI bearer token for `GET /api/evals/nightly-switches` (owner decision
 * 2026-11-27).
 *
 * The three evaluation nightlies run on GitHub's runners and ask production,
 * on each scheduled run, whether they are switched on. They present
 * `Authorization: Bearer <EVALS_SWITCH_READ_TOKEN>`; this module decides
 * whether that header carries the configured token.
 *
 *   - `NOT_CONFIGURED` when the deployment's token is unset, blank or shorter
 *     than `EVALS_SWITCH_TOKEN_MIN_LENGTH`: the endpoint answers 503 and every
 *     nightly stays off. A short token is treated as none rather than accepted,
 *     because the endpoint is reachable from the internet.
 *   - `UNAUTHORIZED` for a missing header, another scheme, or another token.
 *   - `OK` otherwise.
 *
 * The comparison is constant-time over SHA-256 digests of both sides, so it
 * runs over equal-length buffers whatever was presented: a length mismatch is
 * not an early return and leaks nothing about the configured token's length.
 * Nothing here logs or returns either value.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/** The shortest token the endpoint accepts as configured. */
export const EVALS_SWITCH_TOKEN_MIN_LENGTH = 32;

export type EvalSwitchTokenVerdict = 'OK' | 'NOT_CONFIGURED' | 'UNAUTHORIZED';

const BEARER = /^Bearer[ \t]+(\S+)[ \t]*$/i;

function digest(value: string): Buffer {
    return createHash('sha256').update(value, 'utf8').digest();
}

export function verifyEvalsSwitchReadToken(
    authorization: string | null | undefined,
    configured: string | null | undefined,
): EvalSwitchTokenVerdict {
    const expected = (configured ?? '').trim();
    if (expected.length < EVALS_SWITCH_TOKEN_MIN_LENGTH) return 'NOT_CONFIGURED';
    const match = BEARER.exec(authorization ?? '');
    // Compare even when the header is malformed, against a value that cannot
    // match, so a missing header costs what a wrong one does.
    const presented = match ? match[1] : '';
    const equal = timingSafeEqual(digest(presented), digest(expected));
    return equal && match !== null ? 'OK' : 'UNAUTHORIZED';
}
