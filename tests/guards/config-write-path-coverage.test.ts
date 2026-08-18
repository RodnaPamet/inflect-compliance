/**
 * Every path that writes `configJson` validates it first.
 *
 * ## Why a guard and not just the wiring
 *
 * The obvious place to validate tenant-admin config is
 * `upsertIntegrationConnection`, and wiring it there feels complete. It is not:
 * `providers/sharepoint/service.ts` creates its connection row with a direct
 * `db.integrationConnection.create()`, bypassing the usecase entirely. Validation
 * wired only at the usecase would have covered eight providers, missed SharePoint,
 * and read as done.
 *
 * That is the same shape as three defects found the same week — Okta's cursor
 * guard anchored to an unvalidated `orgUrl`, Active Directory's `ldaps://` check
 * living on the tested path but not the running one, and a
 * `validateIntegrationConfig` helper that existed with zero callers. In each, the
 * reasoning was done and only the coverage was missing, which is precisely what a
 * reader cannot see.
 *
 * So the invariant is enumerated rather than assumed: find every writer, and
 * require each to validate.
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(process.cwd(), 'src');

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...walk(p));
        else if (e.name.endsWith('.ts')) out.push(p);
    }
    return out;
}

const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * Writers that set `configJson` on a create/update. Sync-state writers
 * (`syncCursor`, `authFailedAt`, `syncLockedAt`) are excluded by construction —
 * they never carry `configJson`, and the assertion below is what proves it.
 */
function configJsonWriters(): string[] {
    return walk(SRC).filter((f) => {
        const src = stripComments(fs.readFileSync(f, 'utf8'));
        if (!/integrationConnection\.(create|update|upsert|updateMany)/.test(src)) return false;
        // `configJson: true` is a SELECT, not a write. Three files were flagged
        // by a looser test that could not tell them apart — they read the column
        // to hand to a provider and never assign it.
        //
        // The value is captured and compared rather than excluded with a
        // negative lookahead: `configJson\s*:\s*(?!true)` backtracks, because
        // `\s*` can match zero characters and the lookahead then runs at the
        // space, where "not true" is trivially satisfied. That version flags
        // every file it examines.
        const assigned = [...src.matchAll(/configJson\s*:\s*([^,\n}]+)/g)].map((m) =>
            m[1].trim(),
        );
        return assigned.some((v) => v !== 'true');
    });
}

describe('configJson cannot be written without validation', () => {
    const writers = configJsonWriters().map((f) => path.relative(process.cwd(), f));

    it('sanity — writers were actually found', () => {
        // Zero writers would make the assertion below vacuously true, which is
        // the failure mode this whole file exists to avoid.
        expect(writers.length).toBeGreaterThanOrEqual(2);
    });

    it('every writer calls validateProviderConfig', () => {
        const offenders = writers.filter((rel) => {
            const src = stripComments(fs.readFileSync(path.join(process.cwd(), rel), 'utf8'));
            return !/validateProviderConfig\s*\(/.test(src);
        });
        expect({ offenders }).toEqual({ offenders: [] });
    });

    it('names the SharePoint bypass explicitly, so renaming it fails loudly', () => {
        // This file is the reason the guard exists; if it moves, the guard
        // should fail rather than quietly stop covering it.
        expect(writers).toContain('src/app-layer/integrations/providers/sharepoint/service.ts');
        expect(writers).toContain('src/app-layer/usecases/integrations.ts');
    });
});
