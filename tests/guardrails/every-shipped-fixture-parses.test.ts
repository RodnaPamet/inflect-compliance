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
