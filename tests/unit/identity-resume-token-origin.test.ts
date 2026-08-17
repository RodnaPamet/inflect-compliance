/**
 * A stored resume cursor must not be able to redirect a credentialed request.
 *
 * Okta's `link` rel=next and Graph's `@odata.nextLink` are ABSOLUTE URLs, and
 * H3-2 persists them to `IntegrationConnection.syncCursor`. Resuming from
 * whatever is in that column means that anyone who can write it — a SQL
 * injection elsewhere, a compromised backup restore, a bug in an admin
 * endpoint — could point the next enumeration at a host of their choosing,
 * and that request carries the tenant's Okta API token or Graph bearer token
 * in its headers.
 *
 * The mitigation is one line per provider (does the cursor start with the
 * configured origin?), which is exactly the kind of line that gets "simplified"
 * away by someone who reads it as a redundant check on our own data. It is not
 * our own data once it has been to the database and back.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const P = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('resume cursors are origin-checked before use', () => {
    it('Okta resumes only from its configured org URL', () => {
        const src = stripComments(P('src/app-layer/integrations/providers/okta/index.ts'));
        expect(src).toMatch(/resumeFrom\s*&&\s*resumeFrom\.startsWith\(`\$\{orgUrl\}\//);
    });

    it('Entra resumes only from the Graph base', () => {
        const src = stripComments(P('src/app-layer/integrations/providers/entra-id/index.ts'));
        expect(src).toMatch(/resumeFrom\.startsWith\(`\$\{GRAPH_BASE\}\//);
    });

    it('Google needs no origin check, and must not gain a fake one', () => {
        // Google's continuation is an opaque token appended as a query
        // parameter to OUR base URL, so it can never redirect the request.
        // Asserted so the asymmetry reads as deliberate rather than an
        // oversight someone later "fixes" by inventing a URL check.
        const src = stripComments(
            P('src/app-layer/integrations/providers/google-workspace/index.ts'),
        );
        expect(src).toMatch(/let pageToken: string \| undefined = resumeFrom \?\? undefined;/);
        expect(src).not.toMatch(/resumeFrom\.startsWith/);
    });

    it('every resumable provider actually returns a token when it truncates', () => {
        // Without this the cursor is always null, the usecase takes the
        // non-resumable branch, and the whole feature silently does nothing.
        for (const rel of [
            'src/app-layer/integrations/providers/okta/index.ts',
            'src/app-layer/integrations/providers/entra-id/index.ts',
            'src/app-layer/integrations/providers/google-workspace/index.ts',
        ]) {
            expect({ rel, returnsToken: /resumeToken:/.test(stripComments(P(rel))) }).toEqual({
                rel,
                returnsToken: true,
            });
        }
    });
});
