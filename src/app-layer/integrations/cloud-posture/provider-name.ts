import { createHash } from 'node:crypto';

/**
 * THE GATEWAY PROVIDER NAME FOR ONE (TENANT, CONNECTION) — #5476.
 *
 * Sandboxed posture collection attaches a gateway-side credential provider and
 * runs powerpipe against it. #5251 found that every tenant's scan attached the
 * SAME provider, `inflect-collector`, so a scan benchmarked whatever account that
 * one credential reached and stored the result as this tenant's Evidence; #5475
 * made that refuse rather than attach. This is the name that replaces it: one
 * provider per tenant per connection, so there is nothing left to share.
 *
 * ── The product does NOT create it ──────────────────────────────────────
 *
 * Writing a provider's credential needs gateway-wide mTLS with `OU=operator`, and
 * that certificate is deliberately absent from both VMs
 * (`deploy/openshell/README.md`). The app's identity is
 * `CN=openshell-client, OU=openshell-user`, which reaches every
 * `workspace_role: "user"` RPC — attach, exec and the readiness read — and none of
 * the operator surface. So the operator provisions and the product attaches (owner
 * decision): this function is what tells both halves the same name.
 *
 * ── Why the derivation is UNKEYED, which looks wrong and is not ──────────
 *
 * The instinct is `deriveSubkey` under `DERIVED_SUBKEY_KEY`, so the name is
 * unguessable. That would be a trap, and this repository already records why in
 * another voice: `DERIVED_SUBKEY_KEY` has NO previous-key fallback, so rotating it
 * silently re-decides every value derived from it. Here that would move every name
 * at once — orphaning every provider the operator had provisioned under its old
 * name and refusing every tenant's posture collection until somebody re-provisioned
 * by hand, with nothing in the diff to say so.
 *
 * The name is an IDENTIFIER, not a ciphertext, which is the distinction the
 * KEK-rotation note draws for `hashForLookup`: the stored value IS the lookup key,
 * so it must never move. Unguessability buys nothing either — knowing a provider's
 * name grants no access to it, because attaching one needs the gateway's own mTLS.
 *
 * ── Why a digest rather than the ids ────────────────────────────────────
 *
 * A provider name is READ BACK AS A LABEL: it lands in `SandboxLease` rows and,
 * for an estate that opted in, in harness observations as
 * `openshell://sandbox/<id>/provider/<name>`. So it must carry no tenant slug, no
 * account identifier and nothing a reader could mistake for one. A digest of two
 * opaque row ids satisfies that, and is stable forever because both inputs are
 * immutable primary keys.
 */

/** Distinguishes these from `inflect-collector`, the shared one #5251 refused. */
export const POSTURE_PROVIDER_PREFIX = 'inflect-posture-';

/**
 * 32 hex characters — 128 bits.
 *
 * Acceptance criterion 2 of #5476 is "two tenants scanning concurrently never
 * share a provider", and at this width that holds by construction rather than by
 * operator discipline: a collision needs two distinct (tenant, connection) pairs
 * to agree in 128 bits of SHA-256.
 */
export const POSTURE_PROVIDER_DIGEST_CHARS = 32;

/**
 * The two ids are LENGTH-PREFIXED, not joined by a separator character.
 *
 * Concatenating them directly would let `('ab', 'c')` and `('a', 'bc')` derive ONE
 * name — a cross-tenant collision reachable by nothing more than two id lengths,
 * and the exact thing the 128-bit width is supposed to make impossible.
 *
 * A separator character does NOT fix that; it only moves it. This started as a
 * colon, on the reasoning that neither id format can contain one — Prisma's
 * `cuid()` is lowercase alphanumeric, a uuid is hex with hyphens — and the
 * companion test found the hole immediately: `('a', 'b:c')` and `('a:b', 'c')` both
 * build `a:b:c`. The sentence was true of today's ids and the derivation's
 * correctness should not rest on it, because an id format is somebody else's
 * decision and a collision here merges two tenants' credentials.
 *
 * Length-prefixing is injective for ANY pair of strings: a reader takes the digits
 * up to the colon, then exactly that many characters, and repeats. There is no
 * input for which two distinct pairs agree, so nothing about the id alphabet has
 * to be assumed, stated, or kept true.
 */
function lengthPrefixed(value: string): string {
    return `${value.length}:${value}`;
}

/** The provider name for one posture connection. Deterministic, forever. */
export function postureProviderName(input: {
    readonly tenantId: string;
    readonly connectionId: string;
}): string {
    const material = `${lengthPrefixed(input.tenantId)}${lengthPrefixed(input.connectionId)}`;
    const digest = createHash('sha256').update(material, 'utf8').digest('hex');
    return `${POSTURE_PROVIDER_PREFIX}${digest.slice(0, POSTURE_PROVIDER_DIGEST_CHARS)}`;
}

/** The connection providers that collect cloud posture in a sandbox. */
export const POSTURE_CONNECTION_PROVIDERS = [
    'aws-posture',
    'azure-posture',
    'gcp-posture',
] as const;
