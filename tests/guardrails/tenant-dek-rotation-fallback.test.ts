/**
 * Guardrail: the per-tenant DEK rotation fallback path must remain
 * intact across future refactors.
 *
 * Mid-rotation correctness depends on three load-bearing pieces:
 *
 *   1. `decryptWithKeyOrPrevious` exists and is exported by
 *      `src/lib/security/encryption.ts`. The encryption middleware
 *      uses it to retry v2 ciphertexts under the previous DEK on
 *      AES-GCM auth failure.
 *
 *   2. `getTenantPreviousDek` exists and is exported by
 *      `src/lib/security/tenant-key-manager.ts`. The middleware's
 *      `resolveTenantDekPair` calls it to populate the fallback
 *      slot in the resolved DEK pair.
 *
 *   3. The middleware imports + invokes `decryptWithKeyOrPrevious`.
 *      If a future refactor accidentally drops the fallback wiring
 *      (e.g. reverts to `decryptWithKey(primary, ...)`), reads of
 *      mid-rotation rows silently fail.
 *
 * Without this ratchet, a "simplify" PR could remove the fallback
 * machinery, the dual-DEK unit test would still pass (it mocks the
 * helper), and the regression would only surface in production —
 * exactly when an operator is responding to a per-tenant compromise
 * and can least afford a read failure.
 *
 * The ratchet is structural (text-scan), not behavioural — it
 * fails fast if any of the three pieces vanish, regardless of
 * whether the test database is up.
 */

import fs from 'fs';
import path from 'path';

import { codeOf, interfaceBodyOf } from '../helpers/source-blocks';

const REPO_ROOT = path.resolve(__dirname, '../..');

function readSource(rel: string): string {
    const abs = path.join(REPO_ROOT, rel);
    // MASKED at the read seam (#3309 revealed this file was reading raw).
    return codeOf(fs.readFileSync(abs, 'utf8'));
}

describe('Per-tenant DEK rotation fallback wiring', () => {
    test('encryption.ts exports decryptWithKeyOrPrevious', () => {
        const src = readSource('src/lib/security/encryption.ts');
        // Match the export exactly — `export function decryptWithKeyOrPrevious(`.
        expect(src).toMatch(
            /export\s+function\s+decryptWithKeyOrPrevious\s*\(/,
        );
    });

    test('decryptWithKeyOrPrevious tries primary first, then previous, then re-throws primary', () => {
        const src = readSource('src/lib/security/encryption.ts');
        // Look for the structural shape we depend on: a try/catch
        // around the primary, a `previous` null-check, and a final
        // throw that re-raises the primary error.
        const fnStart = src.indexOf(
            'export function decryptWithKeyOrPrevious(',
        );
        expect(fnStart).toBeGreaterThan(-1);
        // Take the function body roughly — until the next top-level
        // export or the end of file.
        const tail = src.slice(fnStart);
        // Each of these strings must be present in the function body.
        // If a future PR rewrites the function to use only the primary,
        // these assertions fail and force a deliberate decision.
        expect(tail).toContain('decryptWithKey(primary');
        expect(tail).toContain('decryptWithKey(previous');
        expect(tail).toContain('throw primaryErr');
        expect(tail).toMatch(/if\s*\(\s*!\s*previous\s*\)\s*throw\s+primaryErr/);
    });

    test('tenant-key-manager.ts exports getTenantPreviousDek', () => {
        const src = readSource('src/lib/security/tenant-key-manager.ts');
        expect(src).toMatch(
            /export\s+async\s+function\s+getTenantPreviousDek\s*\(/,
        );
    });

    test('encryption-middleware.ts imports + uses decryptWithKeyOrPrevious', () => {
        const src = readSource('src/lib/db/encryption-middleware.ts');
        // The named import line is a stable contract.
        expect(src).toMatch(
            /import\s*\{[\s\S]*?decryptWithKeyOrPrevious[\s\S]*?\}\s*from\s*['"]@\/lib\/security\/encryption['"]/,
        );
        // The middleware MUST invoke it on the v2 read path. Without
        // this call, mid-rotation rows fail to decrypt.
        expect(src).toMatch(
            /decryptWithKeyOrPrevious\s*\(\s*deks\.primary\s*,\s*deks\.previous/,
        );
    });

    test('encryption-middleware.ts resolves both DEKs via resolveTenantDekPair', () => {
        const src = readSource('src/lib/db/encryption-middleware.ts');
        // The DECLARATION and the CALL, separately (#3364). `/resolveTenantDekPair\s*\(/`
        // matched both and so named neither: deleting the call left the
        // declaration satisfying it, and a resolver nothing invokes is exactly
        // the failure this test is for. Asserting both is also stronger than
        // the one ambiguous needle it replaces.
        expect(src).toMatch(/async function resolveTenantDekPair\s*\(/);
        expect(src).toMatch(/await resolveTenantDekPair\s*\(/);
        // The pair shape (primary + previous) is the load-bearing
        // contract — a future refactor that switches back to a single
        // DEK must rewrite this guardrail at the same time.
        // Bounded to the INTERFACE, which is the contract this test names
        // (#3364). Unbounded, each needle also matched a local `let` of the
        // same shape inside the resolver, so deleting a field from the
        // interface left the local declaration satisfying the assertion.
        // Bounding the read takes the site out of the ambiguous population
        // entirely rather than making the needle longer.
        const pair = interfaceBodyOf(src, 'TenantDekPair');
        expect(pair).toMatch(/primary:\s*Buffer\s*\|\s*null/);
        expect(pair).toMatch(/previous:\s*Buffer\s*\|\s*null/);
    });

    test('rotateTenantDek is implemented (not a stub)', () => {
        const src = readSource('src/lib/security/tenant-key-manager.ts');
        // The stub threw a literal "not implemented" message. If it
        // ever returns to that state, we want CI to fail loud — the
        // F.2 reservation has been replaced by a real implementation
        // and a future "retire" PR must update this ratchet too.
        expect(src).not.toMatch(/per-tenant DEK rotation is not implemented/);
        expect(src).toMatch(
            /export\s+async\s+function\s+rotateTenantDek\s*\(/,
        );
        // The implementation MUST issue the atomic swap UPDATE.
        expect(src).toMatch(/previousEncryptedDek:\s*null/);
        expect(src).toMatch(/previousEncryptedDek:\s*oldWrapped/);
    });

    test('tenant-dek-rotation route is admin.tenant_lifecycle-gated (OWNER-only)', () => {
        const src = readSource(
            'src/app/api/t/[tenantSlug]/admin/tenant-dek-rotation/route.ts',
        );
        // Per CLAUDE.md "OWNER... gains admin.tenant_lifecycle (delete
        // tenant, rotate DEK...)". A future refactor that downgrades
        // this to admin.manage would silently let plain ADMINs rotate
        // — which is what the role model says they MAY NOT do.
        // EVERY exported handler, named individually (#3364). The single
        // needle matched twice — POST and GET are both gated, which is the
        // right state — so it could not tell "both gated" from "one gated
        // and one downgraded", which is the regression the comment above
        // describes. Two specific needles assert what the prose claims.
        expect(src).toMatch(
            /export const POST = withApiErrorHandling\(\s*requirePermission\(\s*['"]admin\.tenant_lifecycle['"]/,
        );
        expect(src).toMatch(
            /export const GET = withApiErrorHandling\(\s*requirePermission\(\s*['"]admin\.tenant_lifecycle['"]/,
        );
    });
});
