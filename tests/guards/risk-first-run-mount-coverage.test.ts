/**
 * Every first-run risk surface mounts the shared empty-state primitive.
 *
 * Before unification, a tenant with zero risks saw a different shape on each
 * analytical view: the list rendered the `<EmptyState>` primitive, the
 * dashboard's status breakdown a plain `<p>`, the board's hygiene card
 * another plain `<p>`, and the matrix rendered nothing at all. Different
 * copy, different CTA targets, sometimes no CTA — the new operator's first
 * impression depended on which page they landed on.
 *
 * ## Why this is a source scan, and what it deliberately does NOT assert
 *
 * B3-5 — this file replaces `rq3-ob-f-first-run.test.ts`, which also
 * source-scanned the PRIMITIVE ITSELF for `<EmptyState`,
 * `variant="no-records"`, `tenantHref('/risks?create=1')`,
 * `title={t('title')}` and an `onCreateClick … onClick: onCreateClick`
 * proximity match. Every one of those was already covered — behaviourally,
 * against the rendered DOM — by `tests/rendered/risk-first-run-empty.test.tsx`.
 * The scans were strictly weaker duplicates: they proved characters were
 * present in a file, not that the CTA navigates anywhere. They are deleted,
 * not relocated.
 *
 * It also pinned the English `description` PROSE, which the ratchet-lifecycle
 * policy bans outright — a copy edit should not turn CI red.
 *
 * What survives is the one claim only a whole-file scan can make: these three
 * large page components mount the primitive, and no longer carry the legacy
 * plain-`<p>` shapes the unification removed. Rendering three full pages to
 * assert an import would cost far more than it proves.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const IMPORT = /import \{ RiskFirstRunEmpty \}/;
const R = 'src/app/t/[tenantSlug]/(app)/risks';

const risksClient = read(`${R}/RisksClient.tsx`);
const dashboard = read(`${R}/dashboard/page.tsx`);
const board = read(`${R}/board/page.tsx`);

describe('first-run empty state — mount coverage', () => {
    it('the risks list mounts the primitive', () => {
        expect(risksClient).toMatch(IMPORT);
        expect(risksClient).toMatch(/<RiskFirstRunEmpty/);
    });

    it('the dashboard status-breakdown slot mounts the primitive', () => {
        expect(dashboard).toMatch(IMPORT);
        expect(dashboard).toMatch(/emptyState=\{<RiskFirstRunEmpty size="sm" \/>\}/);
        // The legacy plain-<p> shape that used to fill the slot is gone.
        expect(dashboard).not.toMatch(
            /emptyState=\{\s*<p [^>]*>\s*\{t\('noRisksYet'\)\}\s*<\/p>/,
        );
    });

    it('the board hygiene-empty branch mounts the primitive', () => {
        expect(board).toMatch(IMPORT);
        expect(board).toMatch(/<RiskFirstRunEmpty size="sm" \/>/);
        // Legacy "No risks on the register yet" plain <p> is gone.
        expect(board).not.toMatch(
            /className="text-sm text-content-subtle"[\s\S]{0,60}data-testid="board-hygiene-empty"/,
        );
    });
});
