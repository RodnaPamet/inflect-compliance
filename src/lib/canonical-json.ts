/**
 * The ONE canonical-JSON form in this repo.
 *
 * Recursively sorts object keys and emits no whitespace; arrays keep their order
 * because order is semantic. `undefined` collapses to `null`, so a key that is
 * present-but-undefined and a key that is absent hash the same — the only way to
 * make the form total over the values JSON can hold.
 *
 * Two callers depend on it and they must agree byte-for-byte:
 *   • `mcp/receipt-verification.ts` — the message an Ed25519 receipt signature is
 *     verified against, `SHA-256(canonical JSON of action_record)`.
 *   • `mcp/tool-manifest.ts` — the schema half of a pinned tool manifest.
 *
 * They agree because there is one function, not two that look alike. A second
 * copy would drift on the first edit and the drift would present as a signature
 * that stops verifying, or a tool manifest that alarms on a key reordering
 * nobody made.
 */
export function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value ?? null);
    }
    if (Array.isArray(value)) {
        return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
    return `{${entries.join(',')}}`;
}
