/**
 * A shipped control template must be installed by a pack — BOTH directions.
 *
 * The starter-pack guards assert `packCodes ⊆ shipped`: every code a pack
 * names exists as a template. Nothing asserted the reverse, and the reverse is
 * the direction that fails silently.
 *
 * ═══ WHY ONE DIRECTION IS NOT ENOUGH ═══
 *
 * A dangling PACK code is loud. `assertCatalogConsistency`
 * (`prisma/catalog-loader.ts:338`) throws `CatalogValidationError` for it, and
 * that runs inside `catalog-applier.ts` BEFORE anything is written — so the
 * production seeder `scripts/entrypoint.sh` runs on every container start
 * aborts outright. It cannot reach a customer.
 *
 * An ORPHANED TEMPLATE is silent. It parses, it validates, it seeds, it shows
 * up in the template catalogue — and no pack installs it, so the tenant who
 * installs the framework's baseline pack simply never receives it. There is no
 * error anywhere, and the only symptom is a control the customer does not have
 * and never asked about.
 *
 * Found while splitting five bundled templates (#2621-adjacent work): removing
 * a template without updating its pack aborts the seeder, which is safe;
 * ADDING the replacements without updating the pack ships them to nobody,
 * which is not. The second had no guard.
 *
 * ═══ ZERO TODAY, WHICH IS WHY IT IS ASSERTED NOW ═══
 *
 * All 307 templates across 17 fixtures are named by their pack. The invariant
 * already holds; this locks it while it is free, rather than after the first
 * orphan has shipped and the assertion has to be written as a ceiling.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../helpers/repo-files';

const FIXTURE_DIR = path.join(REPO_ROOT, 'prisma/fixtures');

interface Catalog {
    file: string;
    templates: string[];
    packKey: string | null;
    packCodes: string[];
}

function catalogues(): Catalog[] {
    return fs
        .readdirSync(FIXTURE_DIR)
        .filter((f) => f.endsWith('control-templates.json'))
        .map((f) => {
            const d = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf-8')) as {
                templates?: Array<{ code?: string }>;
                pack?: { key?: string; templateCodes?: string[] };
            };
            return {
                file: f,
                templates: (d.templates ?? []).map((t) => String(t.code)),
                packKey: d.pack?.key ?? null,
                packCodes: (d.pack?.templateCodes ?? []).map(String),
            };
        })
        .filter((c) => c.templates.length > 0);
}

describe('every shipped template is installed by a pack', () => {
    const all = catalogues();

    it('sees the population it claims to guard (positive control)', () => {
        // Without this, a glob that matched nothing would make every
        // assertion below pass by operating on an empty list.
        expect(all.length).toBeGreaterThanOrEqual(17);
        expect(all.reduce((n, c) => n + c.templates.length, 0)).toBeGreaterThanOrEqual(300);
        expect(all.every((c) => c.packKey)).toBe(true);
    });

    it('no template ships that its catalogue’s pack does not name', () => {
        // THE UNGUARDED DIRECTION. A tenant installing the baseline pack would
        // simply never receive these, with nothing raising an error.
        const orphans = all.flatMap((c) => {
            const named = new Set(c.packCodes);
            return c.templates.filter((t) => !named.has(t)).map((t) => `${c.file}: ${t}`);
        });
        expect(orphans).toEqual([]);
    });

    it('no pack names a template that does not ship', () => {
        // The loud direction, asserted here too so this file states the whole
        // invariant rather than half of it. `assertCatalogConsistency` also
        // catches this, at seed time; catching it in the suite means a
        // contributor learns before pushing rather than from a failed deploy.
        const dangling = all.flatMap((c) => {
            const shipped = new Set(c.templates);
            return c.packCodes.filter((p) => !shipped.has(p)).map((p) => `${c.file}: ${p}`);
        });
        expect(dangling).toEqual([]);
    });

    it('the two sets are the same size, per catalogue', () => {
        // Equality is what the two assertions above jointly mean; stating it
        // separately makes a duplicate entry in `templateCodes` visible, which
        // subset checks in both directions would each tolerate.
        const mismatched = all
            .filter((c) => new Set(c.packCodes).size !== c.templates.length)
            .map((c) => `${c.file}: ${c.templates.length} templates, ${new Set(c.packCodes).size} distinct pack codes`);
        expect(mismatched).toEqual([]);
    });
});
