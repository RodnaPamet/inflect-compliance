/**
 * SCIM 2.0 PatchOp input normalisation — read by BOTH patch usecases
 * (`scimPatchUser`, `scimPatchGroup`). Do not add a second copy.
 *
 * Three things here are RFC 7644 rules that a strict-equality comparison gets
 * wrong, and every one of them was wrong in production (#5370):
 *
 *   1. **`op` is case-insensitive** (§3.5.2: "The 'op' parameter value ...
 *      MUST be one of 'add', 'remove', or 'replace'", and attribute names and
 *      operation names are case-insensitive). Microsoft Entra sends `"Add"`,
 *      `"Remove"`, `"Replace"`. Compared with `===`, every Entra PATCH matched
 *      no branch and was silently dropped — a member removed from a role-mapped
 *      group kept the role, and a user disabled in Entra stayed ACTIVE here.
 *
 *   2. **A member remove may name its target by filter** (§3.5.2.2):
 *      `path: 'members[value eq "<id>"]'`, with no `value`. Entra uses this
 *      form. `memberValueFromFilterPath` reads the id out of it.
 *
 *   3. **A boolean may arrive as a string**, in any case — Entra sends
 *      `"True"` / `"False"`. Reading only `true`/`'true'` as true turned
 *      `"True"` into a DEACTIVATION. `readScimBoolean` accepts exactly the two
 *      words, case-insensitively, and REFUSES anything else rather than
 *      defaulting it to either answer.
 *
 * An unrecognised `op` is refused with a 400 rather than skipped. RFC 7644
 * §3.5.2 makes a PATCH atomic ("If any operation fails, the whole request
 * fails"), and a skipped operation is a failed one reported as success: the
 * IdP records the change as applied and never retries it. Every op is checked
 * BEFORE either usecase writes anything.
 */
import { ScimAuthError } from '@/lib/scim/auth';

export type ScimPatchVerb = 'add' | 'remove' | 'replace';

export interface NormalisedScimPatchOperation {
    /** Always lower-case — compare against the lower-case literal only. */
    op: ScimPatchVerb;
    /** As sent (NOT case-folded: a filter path carries a case-sensitive id). */
    path?: string;
    value?: unknown;
}

/**
 * A malformed PatchOp — a 400 in the SCIM error shape.
 *
 * Subclasses `ScimAuthError` for the reason `ScimForbiddenError` and
 * `ScimUnresolvableMemberError` do: every SCIM route already catches that type
 * and renders it as a SCIM-shaped error body with the carried status.
 */
export class ScimInvalidPatchError extends ScimAuthError {
    constructor(message: string, scimType: 'invalidSyntax' | 'invalidValue' | 'invalidPath') {
        super(message, 400, scimType);
        this.name = 'ScimInvalidPatchError';
    }
}

const VERBS: readonly ScimPatchVerb[] = ['add', 'remove', 'replace'];

/**
 * Validate and normalise every operation of a PatchOp, or throw before any of
 * them is applied.
 */
export function normaliseScimPatchOperations(
    operations: readonly unknown[],
): NormalisedScimPatchOperation[] {
    return operations.map((raw, index) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new ScimInvalidPatchError(`Operations[${index}] must be an object`, 'invalidSyntax');
        }
        const { op, path, value } = raw as { op?: unknown; path?: unknown; value?: unknown };
        const verb = typeof op === 'string' ? op.trim().toLowerCase() : undefined;
        if (!verb || !(VERBS as readonly string[]).includes(verb)) {
            throw new ScimInvalidPatchError(
                `Operations[${index}].op must be one of "add", "remove" or "replace"`,
                'invalidSyntax',
            );
        }
        if (path !== undefined && path !== null && typeof path !== 'string') {
            throw new ScimInvalidPatchError(`Operations[${index}].path must be a string`, 'invalidPath');
        }
        return {
            op: verb as ScimPatchVerb,
            ...(typeof path === 'string' ? { path } : {}),
            value,
        };
    });
}

/**
 * Read a SCIM boolean: `true`/`false`, or the strings `"true"`/`"false"` in
 * any case. Anything else is refused — never read as either answer, because
 * both answers are a status write.
 */
export function readScimBoolean(value: unknown, attribute: string): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const word = value.trim().toLowerCase();
        if (word === 'true') return true;
        if (word === 'false') return false;
    }
    throw new ScimInvalidPatchError(`${attribute} must be a boolean`, 'invalidValue');
}

/**
 * `members[value eq "<id>"]` → `<id>`; anything else → `null`.
 *
 * The attribute names and the `eq` operator are case-insensitive (RFC 7644
 * §3.4.2.2); the quoted id is returned exactly as sent.
 */
const MEMBER_VALUE_FILTER = /^\s*members\s*\[\s*value\s+eq\s+"([^"]*)"\s*\]\s*$/i;

export function memberValueFromFilterPath(path: string | undefined): string | null {
    if (!path) return null;
    const match = MEMBER_VALUE_FILTER.exec(path);
    if (!match) return null;
    const id = match[1].trim();
    return id ? id : null;
}
