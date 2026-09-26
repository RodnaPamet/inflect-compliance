/**
 * THE SCOPE PICKER AND THE SCOPES THAT EXIST ARE THE SAME SET.
 *
 * `SCOPE_GROUPS` in the API-keys screen is a hand-written list; `VALID_SCOPES`
 * is derived from `SCOPE_ACTION_MAP`. Nothing connected them, and both
 * directions of the resulting gap were real and both were found in production
 * rather than by a test:
 *
 *   · A SCOPE THE PICKER CANNOT OFFER is unreachable through the product.
 *     `admin:external_tools` shipped server-side and could not be ticked, and
 *     the entire `mcp:*` family was absent — so the live runner key, which
 *     carries `mcp:orchestrate` and `mcp:read`, could not have been re-minted
 *     from this screen without silently losing them.
 *   · A SCOPE THE PICKER OFFERS THAT DOES NOT EXIST is an operator-visible
 *     checkbox that `validateScopes` rejects on submit. The file already
 *     records that lesson in a comment about `continuity:read`.
 *
 * So the assertion is EQUALITY, not containment, with one stated exception.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { VALID_SCOPES } from '@/lib/auth/api-key-auth';

/**
 * WILDCARDS are deliberately not offered, and that is design rather than a gap.
 *
 * `*` is the full-access shortcut — the permission mapping subtracts the
 * agent-governance flags from it precisely because it is not a thing to hand
 * out from a checkbox. `<resource>:*` is the same argument one level down: it
 * grants every action on a resource including ones added later, so a key minted
 * from it silently widens on the next deploy. The picker offers explicit
 * read/write instead, and an operator who genuinely wants a wildcard is doing
 * something deliberate enough to use the API.
 *
 * Encoded as a RULE rather than a list, so a new resource does not have to be
 * added here as well as everywhere else.
 */
const isWildcard = (scope: string): boolean => scope === '*' || scope.endsWith(':*');

/** The scopes the picker actually lists, read from the source. */
function pickerScopes(): string[] {
    const src = fs.readFileSync(
        path.join(process.cwd(), 'src/app/t/[tenantSlug]/(app)/admin/api-keys/page.tsx'),
        'utf8',
    );
    const block = src.slice(src.indexOf('const SCOPE_GROUPS'));
    const body = block.slice(0, block.indexOf('\n};'));
    return [...body.matchAll(/'([a-z_]+:[a-z_*]+)'/g)].map((m) => m[1]);
}

describe('the API-key scope picker', () => {
    const offered = pickerScopes();

    it('reads a non-empty list, so the assertions below can fail', () => {
        // The positive control. A regex that matched nothing would make every
        // subset check below pass vacuously.
        expect(offered.length).toBeGreaterThan(20);
    });

    it('offers nothing that validateScopes would reject', () => {
        const invalid = offered.filter((s) => !(VALID_SCOPES as readonly string[]).includes(s));
        expect({ invalid }).toEqual({ invalid: [] });
    });

    it('offers no wildcard, so a key cannot silently widen on the next deploy', () => {
        expect({ wildcardsOffered: offered.filter(isWildcard) }).toEqual({ wildcardsOffered: [] });
    });

    it('offers EVERY mintable NON-WILDCARD scope — one nobody can tick is unreachable', () => {
        const missing = (VALID_SCOPES as readonly string[]).filter(
            (s) => !isWildcard(s) && !offered.includes(s),
        );
        expect({ missing }).toEqual({ missing: [] });
    });

    it('still offers the two that were missing, by name', () => {
        // Named explicitly so a future regression reads as what it is rather
        // than as an anonymous set difference.
        expect(offered).toContain('admin:external_tools');
        expect(offered).toContain('mcp:orchestrate');
        expect(offered).toContain('mcp:read');
    });
});
