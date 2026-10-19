/**
 * The rules of the harness report contract that need no hashing (#3726): the
 * contract ids, whether a value has the shape of a secret, and whether a scan
 * was complete.
 *
 * They live apart from `harness-contract.ts` because the findings planner
 * (`harness-findings.ts`) needs them, and a client component reaches the
 * planner through `harness-acceptance-rules.ts`. The contract verifies
 * signatures with `crypto`, so importing these from it shipped the
 * crypto-browserify polyfill to the agents reports page. `harness-contract.ts`
 * re-exports all of them, and the ingest, the scanner and the tests may import
 * them from either module.
 *
 * Keep this module free of Node built-ins: a client reaches it.
 * `tests/guards/client-reachable-modules-import-no-node-builtins.test.ts`
 * fails if it, or anything it imports, gains one.
 */

/** The first contract (#3660). Still verified: a deployed `/1` scanner keeps working. */
export const HARNESS_CONTRACT_V1 = 'inflect-agent-harness/1';

/**
 * `/1` plus the `code` source kind, the `UNPARSEABLE` reason and the
 * `unboundCredentials[]` member (#3754, owner decision 2026-10-19). What a
 * scanner built today emits.
 */
export const HARNESS_CONTRACT_V2 = 'inflect-agent-harness/2';

/** Every id the verifier accepts, each against its own strict schema. */
export const HARNESS_CONTRACT_IDS = [HARNESS_CONTRACT_V1, HARNESS_CONTRACT_V2] as const;
export type HarnessContractId = (typeof HARNESS_CONTRACT_IDS)[number];

/**
 * Shapes that are a secret wherever they appear, including inside something
 * that otherwise looks like a reference. Deliberately short: a false refusal
 * names itself and costs a scanner fix; a false acceptance puts a credential in
 * a tenant's database.
 */
const SECRET_SHAPES: readonly RegExp[] = [
    /gh[pousr]_[A-Za-z0-9]{20,}/,
    /github_pat_[A-Za-z0-9_]{20,}/,
    /AKIA[0-9A-Z]{16}/,
    /xox[abpors]-[A-Za-z0-9-]{10,}/,
    /sk-[A-Za-z0-9]{20,}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
    // A URL carrying a password in its userinfo: `scheme://user:password@host`.
    // The authority ends at the first `/`, `?`, `#` or `\`, so an `@` or a `:`
    // further along — `kv://prod/agents:reporting@v2` — is a locator, not a
    // credential. The username may itself hold an `@` (an e-mail address); the
    // password is everything after its first `:` up to the LAST `@`. A username
    // alone (`ssh://git@host`) is not matched: it is not a secret, and a token
    // used AS the username is caught by its own shape above. The match starts
    // at the literal `://` — whatever the scheme, or none — which keeps the scan
    // linear: a leading scheme class would be retried at every offset.
    /:\/\/[^/?#\\\s:]*:[^/?#\\\s]*[^/?#\\\s@]@/,
];

export function looksLikeSecret(value: string): boolean {
    return SECRET_SHAPES.some((re) => re.test(value));
}

/**
 * Is the scan complete? Derived from its sources, never declared. Zero sources
 * is not complete: a scan that looked nowhere evidences nothing.
 */
export function isScanComplete(body: {
    readonly population: { readonly sources: ReadonlyArray<{ readonly status: string }> };
}): boolean {
    return body.population.sources.length > 0 && body.population.sources.every((s) => s.status === 'COMPLETE');
}
