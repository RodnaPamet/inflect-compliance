/**
 * There is ONE session mechanism, and revoking it revokes everything.
 *
 * A legacy `token` cookie used to be minted by `/api/auth/register` and
 * validated by `getSession()` in `src/lib/auth.ts`. It returned a full
 * session — userId, tenantId, email, role — straight into
 * `getSessionOrThrow`, which builds the `RequestContext` every usecase runs
 * on (`src/app-layer/context.ts`).
 *
 * It checked no `sessionVersion`, no `UserSession.revokedAt`, and never
 * called `verifyAndTouchSession`. So a password change or reset (which bumps
 * `sessionVersion` and revokes every `UserSession`), an admin revoking a
 * session from `/admin/members`, and the Epic C.3 concurrent-session cap all
 * left a legacy cookie working for the rest of its 7-day life.
 *
 * What kept it alive was a comment. The writer asserted "nothing in the
 * codebase reads `token` … no `cookies.get('token')` anywhere" while
 * `getSession()` did exactly that — and `LEGACY_JWT_SECRET` read
 * `env.JWT_SECRET`, a core auth variable set in production, so the `if` that
 * looked like a kill switch was always true.
 *
 * Removing the READER is what makes an outstanding cookie inert; removing
 * the writer stops minting new ones. Both are asserted, because either one
 * alone leaves the bypass reachable.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const codeOnly = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('no second session mechanism', () => {
    it('getSession does not read a legacy cookie', () => {
        // The reader. This is the half that grants access, so it is the
        // half that matters most.
        const src = codeOnly(read('src/lib/auth.ts'));
        expect(src).not.toMatch(/cookies\(\)/);
        expect(src).not.toMatch(/get\(['"]token['"]\)/);
        expect(src).not.toMatch(/jwt\.verify/);
    });

    it('register does not mint one', () => {
        const src = codeOnly(read('src/app/api/auth/register/route.ts'));
        expect(src).not.toMatch(/cookies\.set\(['"]token['"]/);
        expect(src).not.toMatch(/signToken/);
    });

    it('the sign/verify helpers are gone, not merely unused', () => {
        // Leaving exported helpers behind invites a future caller to
        // re-create the bypass without touching either file above.
        const src = codeOnly(read('src/lib/auth.ts'));
        expect(src).not.toMatch(/export function signToken/);
        expect(src).not.toMatch(/export function verifyToken/);
    });

    it('logout still clears it, so outstanding cookies get evicted', () => {
        // Deliberately kept. The cookie is inert once the reader is gone,
        // but a dead credential should not sit in users' jars for the rest
        // of its 7-day life.
        expect(codeOnly(read('src/app/api/auth/logout/route.ts')))
            .toMatch(/cookies\.set\(['"]token['"],\s*['"]{2}/);
    });

    it('the real session path still enforces revocation', () => {
        // The point of removing the second mechanism is that the first one
        // is authoritative. If this ever stops being true, the deletion
        // above bought nothing.
        const auth = read('src/auth.ts');
        expect(auth).toMatch(/verifyAndTouchSession/);
        expect(auth).toMatch(/sessionVersion/);
    });
});
