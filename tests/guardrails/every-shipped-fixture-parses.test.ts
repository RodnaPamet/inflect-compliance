import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadCatalogFile } from '../../prisma/catalog-loader';

/**
 * Every catalogue fixture the seeders ship must satisfy the SCHEMA, not merely
 * be valid JSON.
 *
 * WHY THIS EXISTS. `prisma/fixtures/*-control-templates.json` is read by 66
 * test suites, and not one of them parsed a fixture through
 * `loadCatalogFile` — they all read it with `JSON.parse` and then assert about
 * the object. So a fixture could be well-formed JSON, satisfy every guard in
 * the repo, and still be REFUSED by `CatalogFileSchema` at the only place that
 * applies it: the seeder.
 *
 * That is not a test-only inconvenience. `scripts/entrypoint.sh` runs the
 * framework seeder on EVERY container start, and `assertCatalogConsistency`
 * throws before any write — so a fixture this schema rejects does not degrade
 * the catalogue, it aborts the boot.
 *
 * Measured 2026-09-19: a template `description` was written as
 * `{ en: '…' }` — the LocaleString shape that a TASK description genuinely
 * uses — on 49 templates. `CatalogTemplateSchema.description` is
 * `z.string().optional()`. Every guard passed; the E2E "Seed test database"
 * step failed in 85 seconds with 49 validation errors.
 */

const FIXTURE_DIR = path.resolve(__dirname, '../../prisma/fixtures');

function shippedFixtures(): string[] {
    return fs
        .readdirSync(FIXTURE_DIR)
        .filter((f) => f.endsWith('-control-templates.json'))
        .sort();
}

describe('every shipped catalogue fixture parses under the loader', () => {
    // An empty population would make the loop below pass by vacuity, which is
    // the whole failure mode this file exists to prevent one level down.
    it('is looking at something', () => {
        expect(shippedFixtures().length).toBeGreaterThan(10);
    });

    it.each(shippedFixtures())('%s satisfies CatalogFileSchema', (file) => {
        // Not wrapped: the thrown CatalogValidationError enumerates the exact
        // offending paths, which is more useful than any message we could add.
        expect(() => loadCatalogFile(`prisma/fixtures/${file}`)).not.toThrow();
    });

    /**
     * A shipped template must carry a `description`, unless its catalogue is one
     * of the three FROZEN for want of a grounding library.
     *
     * #2614 found 163 of 342 templates with no description, across eleven whole
     * catalogues. It is now 59 of 473, and the 59 are exactly ISO 9001, ISO
     * 39001 and ISO 28000 — the three that `FROZEN_UNGROUNDED_POPULATIONS` in
     * control-task-actionability.test.ts refuses on a named precondition, because
     * no library under src/data/libraries grounds them.
     *
     * WHERE THIS FIELD ACTUALLY SHOWS. `Control` has no `description` column and
     * `ControlTemplateProjectionSource` (usecases/control/template-projection.ts)
     * declares none, so this never reaches an installed control and is not
     * supposed to. It is a PRE-INSTALL BROWSE field — the templates DataTable
     * column and the per-framework template list — which is where an operator
     * decides whether to install a framework at all. That is the whole of its
     * job, and the reason a half-empty column there is worth closing.
     */
    const DESCRIPTION_EXEMPT = ['iso9001', 'iso39001', 'iso28000'];

    it.each(shippedFixtures())('%s carries a description on every template, or is frozen', (file) => {
        const name = file.replace('-control-templates.json', '');
        const templates = (JSON.parse(
            fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf-8'),
        ) as { templates?: Array<{ code: string; description?: unknown }> }).templates ?? [];
        const blank = templates
            .filter((t) => typeof t.description !== 'string' || t.description.trim() === '')
            .map((t) => t.code);

        if (DESCRIPTION_EXEMPT.includes(name)) {
            // The exemption is falsifiable in BOTH directions: a frozen catalogue
            // that has gained descriptions is no longer frozen, and leaving it
            // listed here would hide the next regression behind a stale carve-out.
            expect(blank.length).toBeGreaterThan(0);
            return;
        }
        expect(blank).toEqual([]);
    });

    it('the description exemption names the same catalogues the content freeze does', () => {
        // The freeze lives in control-task-actionability.test.ts and cannot be
        // imported — importing a test file runs its suite a second time — so it is
        // read as source. Comments are stripped first: this repo has been caught
        // four separate times by a needle that matched PROSE ABOUT a constant
        // rather than the constant, and prose here would name all three anyway.
        const src = fs.readFileSync(
            path.join(__dirname, 'control-task-actionability.test.ts'),
            'utf-8',
        );
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        const frozen = [...code.matchAll(/libraryPattern:\s*\/(\d+)\//g)].map((m) => m[1]).sort();

        // Positive control: if the parse returns nothing, the comparison below
        // would pass by vacuity against an empty set.
        expect(frozen.length).toBeGreaterThanOrEqual(3);
        expect(frozen).toEqual(DESCRIPTION_EXEMPT.map((n) => n.replace('iso', '')).sort());
    });

    /**
     * MUTATION PROOF. The assertions above are `not.toThrow()`, which a loader
     * that had been reduced to `JSON.parse` would satisfy for every fixture.
     * So break a real fixture the same way the measured defect broke it and
     * require the loader to refuse it — a green run above means nothing unless
     * this one is red when it should be.
     */
    it('the loader actually refuses the shape that caused this', () => {
        const file = shippedFixtures()[0];
        const parsed = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf-8')) as {
            templates: Array<{ description?: unknown }>;
        };
        // The task shape, applied to a template. Valid JSON, wrong schema.
        parsed.templates[0].description = { en: 'a locale string where a plain string belongs' };

        // Written OUTSIDE the repo on purpose. `loadCatalogFile` resolves any
        // path, so there is no reason for a guard to mutate a tracked file —
        // a run killed between the write and the restore would leave a live
        // mutation staged by the next `git add -A`.
        //
        // `mkdtempSync` rather than a name built from the pid: the temp dir is
        // world-writable, so a predictable path is a symlink-swap target
        // (js/insecure-temporary-file, which CodeQL raised on exactly that
        // first version of this line). mkdtemp creates the directory itself,
        // 0700 and randomly suffixed, so the file inside it is unreachable.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-mutation-'));
        try {
            const scratch = path.join(dir, 'fixture.json');
            fs.writeFileSync(scratch, JSON.stringify(parsed, null, 2));
            expect(() => loadCatalogFile(scratch)).toThrow(/templates\.0\.description/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
