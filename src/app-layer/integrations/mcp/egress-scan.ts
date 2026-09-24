/**
 * The outbound argument scan — the one check that runs on data LEAVING us.
 *
 * Every other MCP control in this codebase governs what an agent may READ.
 * `runReadTool` decides which tools are offered, which the policy card allows,
 * and which rows the principal may see. None of that asks the question an
 * external server raises for the first time: the agent has already read tenant
 * data, and it CHOOSES the arguments for the next call. Nothing in the read
 * path stops it putting what it read into a payload addressed to somebody
 * else's endpoint.
 *
 * So this scan is deliberately not a data-loss classifier. It hunts two
 * markers that mean "this came from inside and cannot have a legitimate reason
 * to leave", both matched exactly rather than guessed at:
 *
 *   - a CIPHERTEXT envelope — a `v1:`/`v2:` value is a raw encrypted column.
 *     An external server cannot decrypt it, so sending it is never useful and
 *     always evidence that something read a field it should have let the
 *     middleware decrypt.
 *   - an INFLECT API KEY — `iflk_`. A credential minted for this deployment,
 *     addressed outward, is exfiltration whatever the surrounding prose says.
 *
 * Both are zero-false-positive: neither string occurs in ordinary prose, so the
 * scan needs no tuning and no allowlist, and a refusal is always worth reading.
 *
 * ## Why `JSON.stringify` drives the walk
 *
 * The obvious implementation recurses with `Object.entries`. That walker is
 * BLIND to `Date`, `Map`, `Set`, `RegExp` and `Error` — each is `typeof
 * 'object'` with zero own entries, so a hand-rolled traversal sits green with a
 * secret inside one. Handing the walk to the serialiser removes the whole class
 * of blind spot by construction: the replacer is invoked for exactly the values
 * that get emitted, which is exactly the bytes `rpc` puts on the wire. If a
 * value does not reach the replacer it does not reach the network either.
 */
import { API_KEY_PREFIX } from '@/lib/auth/api-key-auth';
import { isEncryptedValue } from '@/lib/security/encryption';

/**
 * The first internal secret found in an outbound payload, named for the
 * refusal message, or `null` if there is none.
 *
 * Throws whatever `JSON.stringify` throws on a value it cannot serialise
 * (a circular reference, a BigInt). That is deliberate: `rpc` serialises the
 * same payload one line later and would throw identically, so failing here
 * changes nothing except which line the stack names.
 */
export function findInternalSecret(payload: unknown): string | null {
    let found: string | null = null;

    JSON.stringify(payload, (_key, value) => {
        if (found === null && typeof value === 'string') {
            if (isEncryptedValue(value)) {
                found = 'an encrypted field value';
            } else if (value.includes(API_KEY_PREFIX)) {
                found = 'an Inflect API key';
            }
        }
        return value;
    });

    return found;
}
