/**
 * SP-1 ratchet — the SharePoint provider + delegated-consent flow must stay
 * wired: provider bundle, bootstrap registration, the admin routes, the
 * tenant-agnostic callback's CSRF/authz checks, and encrypted token storage.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// At the seam, not per assertion, so a new `expect(read(...))` inherits it.
// String literals are KEPT — masking them would silently empty assertions that
// harvest codes or ids from source. Every path this file reads is a
// TypeScript-alike, re-derived per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => codeOf(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));
const SP = 'src/app-layer/integrations/providers/sharepoint';

describe('SP-1 SharePoint provider', () => {
    it('the provider bundle files exist', () => {
        for (const f of ['client.ts', 'mapper.ts', 'token.ts', 'service.ts', 'types.ts', 'index.ts']) {
            expect(exists(`${SP}/${f}`)).toBe(true);
        }
    });

    it('the client extends BaseIntegrationClient and exposes the Graph surface', () => {
        const c = read(`${SP}/client.ts`);
        expect(c).toMatch(/extends BaseIntegrationClient/);
        for (const m of ['listSites', 'listDrives', 'listChildren', 'downloadItemContent', 'getDelta', 'createSubscription']) {
            expect(c).toContain(`${m}(`);
        }
    });

    it('bootstrap registers the sharepoint bundle', () => {
        const b = read('src/app-layer/integrations/bootstrap.ts');
        expect(b).toMatch(/name: 'sharepoint'/);
        expect(b).toMatch(/clientClass: SharePointClient/);
    });

    it('the delegated-consent token flow requests offline_access + the SP Graph scopes', () => {
        const t = read(`${SP}/token.ts`);
        expect(t).toMatch(/offline_access/);
        expect(t).toMatch(/Sites\.Read\.All/);
        expect(t).toMatch(/Files\.ReadWrite\.All/);
        expect(t).toMatch(/prompt: 'consent'/);
        // The token pair is stored encrypted by the service.
        expect(read(`${SP}/service.ts`)).toMatch(/encryptField\(JSON\.stringify/);
    });

    it('the admin connection routes exist + are admin-gated', () => {
        const base = 'src/app/api/t/[tenantSlug]/admin/integrations/sharepoint';
        for (const f of ['route.ts', 'connect/route.ts', 'sites/route.ts', 'test/route.ts']) {
            expect(exists(`${base}/${f}`)).toBe(true);
        }
        expect(read(`${base}/connect/route.ts`)).toMatch(/requirePermission(<[^>]*>)?\(\s*'admin\.manage'/);
        expect(read(`${base}/connect/route.ts`)).toMatch(/sp_oauth_state/);
    });

    it('the callback verifies CSRF state + re-authorises before creating the connection', () => {
        const cb = read('src/app/api/integrations/sharepoint/callback/route.ts');
        expect(cb).toMatch(/sp_oauth_state/);
        expect(cb).toMatch(/state !== cookieState/);
        expect(cb).toMatch(/getTenantCtx/);
        expect(cb).toMatch(/assertCanAdmin/);
    });
});
