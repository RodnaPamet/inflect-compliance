/**
 * A domain's modules live inside its directory, or there is no directory.
 *
 * `src/app-layer/usecases/` mixes single files and directories. Nothing stated
 * when to reach for which, so the split kept being argued from file size —
 * which is the wrong trigger. `task.ts` is 1,906 lines and perfectly findable,
 * because no `task/` directory exists for it to be missing from.
 *
 * The defect shape is BARREL BYPASS: a `<domain>-<subdomain>.ts` file sitting
 * beside an existing `<domain>/` directory and absent from that directory's
 * `index.ts`. Such a module is part of the domain by name and outside it by
 * structure, so every consumer must reach around the barrel — and a sibling
 * INSIDE the directory ends up importing `../<domain>-x`, which is what makes
 * a domain impossible to reason about as a unit.
 *
 * That is not hypothetical. `control/health.ts` imported
 * `computeControlEffectivenessMap` from `../control-test`, so control HEALTH
 * could not be computed without leaving `usecases/control/`. Three files moved
 * in as a result (`test-plans.ts`, `exceptions.ts`, `roi.ts`).
 *
 * The rule is written up in `docs/app-layer.md` ("When a usecase becomes a
 * directory"). This enforces it, so the next instance fails CI instead of
 * being noticed in an audit two quarters later.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const USECASES = path.join(ROOT, 'src/app-layer/usecases');

/**
 * Known bypasses, each with a written reason. DOWNWARD RATCHET — entries come
 * off as the modules move in; nothing new goes on without the same kind of
 * reason, and the stale check below deletes an entry the moment it is fixed.
 */
const ALLOWED: Record<string, string> = {
    'framework-delta.ts':
        'Sits beside framework/ with 5 importers and no delta symbols in framework/index.ts. Same shape control-test.ts had; the move is mechanical and tracked separately.',
};

function domainDirectories(): string[] {
    return fs
        .readdirSync(USECASES, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
}

describe('usecase domain barrels', () => {
    const domains = domainDirectories();

    it('finds the domain directories (parser sanity)', () => {
        // A broken read would make every assertion below vacuously pass.
        expect(domains.length).toBeGreaterThanOrEqual(3);
        expect(domains).toContain('control');
    });

    it('no <domain>-<sub>.ts sits outside its domain directory unexplained', () => {
        const files = fs
            .readdirSync(USECASES, { withFileTypes: true })
            .filter((e) => e.isFile() && e.name.endsWith('.ts'))
            .map((e) => e.name);

        const offenders: string[] = [];
        for (const file of files) {
            const domain = domains.find((d) => file.startsWith(`${d}-`));
            if (!domain) continue;

            // Re-exported from the domain barrel? Then it is reachable through
            // the barrel and the bypass does not exist in practice.
            const barrel = path.join(USECASES, domain, 'index.ts');
            const barrelSrc = fs.existsSync(barrel)
                ? fs.readFileSync(barrel, 'utf8')
                : '';
            const stem = file.replace(/\.ts$/, '');
            if (barrelSrc.includes(stem)) continue;

            if (file in ALLOWED) continue;
            offenders.push(`${file} (belongs in ${domain}/, absent from ${domain}/index.ts)`);
        }

        expect(offenders).toEqual([]);
    });

    it('has no stale ALLOWED entries', () => {
        for (const [file, reason] of Object.entries(ALLOWED)) {
            const full = path.join(USECASES, file);
            // A fixed bypass must have its entry deleted in the same diff.
            expect({ file, stillOutside: fs.existsSync(full) }).toEqual({
                file,
                stillOutside: true,
            });
            expect(reason.length).toBeGreaterThan(30);
        }
    });

    /**
     * The consequence the rule exists to prevent, asserted directly: a module
     * INSIDE a domain directory reaching back out to a sibling named for the
     * same domain.
     */
    it('no module inside a domain directory imports ../<domain>-*', () => {
        const offenders: string[] = [];
        for (const domain of domains) {
            const dir = path.join(USECASES, domain);
            for (const entry of fs.readdirSync(dir)) {
                if (!entry.endsWith('.ts')) continue;
                const src = fs.readFileSync(path.join(dir, entry), 'utf8');
                const re = new RegExp(`from\\s+['"]\\.\\./${domain}-[a-z-]+['"]`, 'g');
                for (const m of src.matchAll(re)) {
                    offenders.push(`${domain}/${entry}: ${m[0]}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});
