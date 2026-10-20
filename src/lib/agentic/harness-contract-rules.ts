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

/**
 * The first contract (#3660), RETIRED at the scanner container's release
 * (#3686, owner decision 2026-10-19): the verifier refuses a report that names
 * it (`SCHEMA`) and writes nothing. No scanner but the reference one ever spoke
 * it, and that one speaks `/2`. Kept only so the refusal can say why.
 */
export const HARNESS_CONTRACT_V1 = 'inflect-agent-harness/1';

/**
 * `/1` plus the `code` source kind, the `UNPARSEABLE` reason and the
 * `unboundCredentials[]` member (#3754, owner decision 2026-10-19). Accepted
 * beside `/3`.
 */
export const HARNESS_CONTRACT_V2 = 'inflect-agent-harness/2';

/**
 * `/2` plus the `gcp-sa` source kind, a Google Cloud project's service
 * accounts (#3785, owner decision 2026-10-19), and nothing else. A new id
 * rather than a widened `/2`, because the source kinds are a closed list on the
 * wire: a `/2` verifier refuses a report naming `gcp-sa`, and a `/2` report
 * that names it is still refused here. What the reference scanner speaks.
 */
export const HARNESS_CONTRACT_V3 = 'inflect-agent-harness/3';

/** Every id the verifier accepts. `/1` is retired and is not among them. */
export const HARNESS_CONTRACT_IDS = [HARNESS_CONTRACT_V2, HARNESS_CONTRACT_V3] as const;
export type HarnessContractId = (typeof HARNESS_CONTRACT_IDS)[number];

/**
 * Where a scanner looks. Stable ids: the report and the matrix carry them. The
 * last, `code` (agent definitions read from source code and configuration,
 * #3737), is the one `/2` added; the rest were `/1`'s.
 */
export const SOURCE_KINDS_V2 = [
    'entra-sp',
    'okta-app',
    'vault',
    'mcp',
    'runtime',
    'cicd',
    'inflect-register',
    'code',
] as const;

/** `/3`'s kinds: `/2`'s, and `gcp-sa`, a Google Cloud project's service accounts (#3785). */
export const SOURCE_KINDS_V3 = [...SOURCE_KINDS_V2, 'gcp-sa'] as const;

/**
 * Every source kind a report this verifier accepts can carry, which is also
 * every kind a stored scan can hold, `/1` and `/2` scans included. Stored scans
 * are re-read against it, and an estate may declare exactly these (the
 * database CHECKs the same list). Here rather than in the contract so the
 * estate form, a client component, can offer the same list (#3807).
 */
export const SOURCE_KINDS = SOURCE_KINDS_V3;

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
