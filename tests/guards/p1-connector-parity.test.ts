/**
 * P1 — make every connector as complete as SharePoint.
 *
 * Locks the connection-level run path, per-connection outcome view, identity
 * roster, and the health-signal fix so a later "simplify" can't regress them.
 */
import * as fs from 'fs';
import * as path from 'path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so a guard can no
// longer be satisfied by a COMMENT naming the thing its assertion is about.
// Applied here rather than per assertion so a new `expect(read(...))` inherits
// it. String literals are KEPT: masking them would silently empty assertions
// that harvest codes or ids from source. Every path this file reads is a
// TypeScript-alike (re-derived per file, not assumed from the directory), so
// `codeOf` is the right lexer and no language split is needed.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

const UC = 'src/app-layer/usecases/integrations.ts';
const PAGE = 'src/app/t/[tenantSlug]/(app)/admin/integrations/page.tsx';
const PANEL = 'src/app/t/[tenantSlug]/(app)/admin/integrations/ConnectionHealthPanel.tsx';
const API = 'src/app/api/t/[tenantSlug]/admin/integrations';

describe('P1 — connection-level run + per-connection outcomes', () => {
    const uc = read(UC);

    it('exposes connection-level usecases', () => {
        expect(uc).toMatch(/export async function syncConnection\b/);
        expect(uc).toMatch(/export async function listExecutionsForConnection\b/);
        expect(uc).toMatch(/export async function listConnectedAccounts\b/);
    });

    it('syncConnection runs identity sync + wired-control checks', () => {
        const fn = uc.slice(uc.indexOf('export async function syncConnection'));
        expect(fn).toMatch(/runIdentitySync/);
        expect(fn).toMatch(/runAutomationForControl/);
        expect(fn).toMatch(/automationKey:\s*\{\s*startsWith/);
    });

    it('the sync + executions + identity-accounts routes exist', () => {
        expect(exists(`${API}/[connectionId]/sync/route.ts`)).toBe(true);
        expect(exists(`${API}/[connectionId]/executions/route.ts`)).toBe(true);
        expect(exists(`${API}/identity-accounts/route.ts`)).toBe(true);
    });

    it('the per-connection outcome + identity roster pages exist', () => {
        expect(exists('src/app/t/[tenantSlug]/(app)/admin/integrations/[connectionId]/page.tsx')).toBe(true);
        expect(exists('src/app/t/[tenantSlug]/(app)/admin/integrations/identity-accounts/page.tsx')).toBe(true);
    });

    it('the integrations page surfaces Sync now + fires an initial sync on connect', () => {
        const page = read(PAGE);
        expect(page).toMatch(/handleSyncNow/);
        expect(page).toMatch(/integrations\.syncNow/);
        // Fired once on a fresh connect.
        expect(page).toMatch(/if \(!editingId && data\.id\)/);
        // Links to the outcome page + the identity roster.
        expect(page).toMatch(/\/admin\/integrations\/\$\{row\.original\.id\}/);
        expect(page).toMatch(/\/admin\/integrations\/identity-accounts/);
    });
});

describe('P1 — health signal reflects activity, not only PASSED', () => {
    const uc = read(UC);
    it('getConnectionsHealth computes latest activity of ANY status', () => {
        const fn = uc.slice(uc.indexOf('export async function getConnectionsHealth'));
        // A groupBy WITHOUT the status:'PASSED' filter (any-status latest run).
        expect(fn).toMatch(/groupedAny/);
        expect(fn).toMatch(/lastActivityAt/);
        expect(fn).toMatch(/secondsSinceActivity/);
        // Still tracks last success separately.
        expect(fn).toMatch(/groupedPassed/);
    });
    it('the panel renders the test-OK nuance + activity freshness', () => {
        const panel = read(PANEL);
        expect(panel).toMatch(/integrations\.health\.testedOk/);
        expect(panel).toMatch(/secondsSinceActivity/);
    });
});
