/**
 * Structural ratchet — data-retention policy coverage.
 *
 * Enforces that docs/data-retention.md stays an HONEST, COMPLETE map of
 * the schema:
 *   - the doc exists,
 *   - every Prisma model appears as a row in the inventory table (a new
 *     model can't be added without classifying its retention),
 *   - the "Open questions" section is non-empty (honesty guard — the doc
 *     must not pretend every retention number is decided),
 *   - the cleanup-job inventory names every retention function exported
 *     from jobs/retention*.ts and jobs/data-lifecycle.ts,
 *   - and — the accuracy check — a model's row cites `runRetentionSweep`
 *     IF AND ONLY IF the sweep, when RUN, actually queries that model.
 *
 * That last one exists because the four checks above verify MENTION, not
 * accuracy: five rows claimed a `runRetentionSweep` guarantee for models
 * nothing in `src/` could write, and stayed green for months. The cross-walk
 * drives the claim off observed behaviour (`observedSweptModels`, a DB-free
 * probe that injects an in-memory client) instead of prose.
 *
 * See docs/data-retention.md.
 */
import fs from 'fs';
import path from 'path';
import {
    RETENTION_COLUMN_MODELS,
    observedSweptModels,
} from '../helpers/retention-sweep-probe';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const DOC = path.join(ROOT, 'docs/data-retention.md');
const SCHEMA_DIR = path.join(ROOT, 'prisma/schema');

// codeOf() masks comments at the READ SEAM (#2246), so a COMMENT naming a
// retention function cannot satisfy an assertion about the exported function.
// Masking is the DEFAULT (`read`) so a new assertion inherits it; the policy
// DOC is markdown and calls `readRaw`, because there the prose IS the subject.
const readRaw = (p: string): string =>
    fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';

const read = (p: string): string => codeOf(readRaw(p));

/** Every `model X { ... }` name across the multi-file schema. */
function allModelNames(): string[] {
    const names: string[] = [];
    for (const f of fs.readdirSync(SCHEMA_DIR)) {
        if (!f.endsWith('.prisma')) continue;
        const txt = codeOf(fs.readFileSync(path.join(SCHEMA_DIR, f), 'utf-8'));
        for (const m of txt.matchAll(/^model\s+(\w+)\s*\{/gm)) names.push(m[1]);
    }
    return names;
}

/** Retention functions exported from the cleanup-job sources. */
function retentionFunctions(): string[] {
    const files = [
        'src/app-layer/jobs/retention.ts',
        'src/app-layer/jobs/retention-notifications.ts',
        'src/app-layer/jobs/data-lifecycle.ts',
    ];
    const fns: string[] = [];
    for (const rel of files) {
        const txt = read(path.join(ROOT, rel));
        for (const m of txt.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) fns.push(m[1]);
    }
    return fns;
}

const doc = readRaw(DOC);

describe('data-retention policy doc', () => {
    it('exists', () => {
        expect(doc.length).toBeGreaterThan(0);
    });

    it('lists every Prisma model in the inventory table', () => {
        const models = allModelNames();
        expect(models.length).toBeGreaterThanOrEqual(139);
        // Each model must appear as a table-row anchor: `| `Model` |`.
        const missing = models.filter((m) => !doc.includes(`| \`${m}\` |`));
        expect(missing).toEqual([]);
    });

    it('has a non-empty Open questions section (honesty guard)', () => {
        const m = doc.match(/##\s+Open questions([\s\S]*?)(?:\n##\s|\n#\s|$)/);
        expect(m).not.toBeNull();
        const body = (m?.[1] ?? '').trim();
        // Must contain at least a few enumerated questions, not just a heading.
        const numbered = body.match(/^\d+\.\s+\*\*/gm) ?? [];
        expect(numbered.length).toBeGreaterThanOrEqual(3);
    });

    it('names every retention cleanup function in the job-inventory', () => {
        const fns = retentionFunctions();
        // Sanity: we actually found the known functions.
        expect(fns).toEqual(
            expect.arrayContaining([
                'runEvidenceRetentionSweep',
                'purgeSoftDeletedOlderThan',
                'purgeExpiredEvidenceOlderThan',
                'runRetentionSweep',
            ]),
        );
        const missing = fns.filter((fn) => !doc.includes(fn));
        expect(missing).toEqual([]);
    });

    it('cites runRetentionSweep on a model row iff the sweep actually queries that model', async () => {
        const swept = await observedSweptModels();

        // Sanity: the probe observed a real sweep, not an empty run.
        expect(swept.size).toBeGreaterThan(0);

        const wrong: string[] = [];
        for (const model of RETENTION_COLUMN_MODELS) {
            const row = docRow(model);
            expect(row).not.toBeNull();
            const claims = row!.includes('runRetentionSweep');
            if (claims !== swept.has(model)) {
                wrong.push(
                    `${model}: doc ${claims ? 'claims' : 'does not claim'} runRetentionSweep, ` +
                    `sweep ${swept.has(model) ? 'does' : 'does not'} query it`,
                );
            }
        }
        expect(wrong).toEqual([]);
    });
});

/** The inventory-table row for a model, or null if absent. */
function docRow(model: string): string | null {
    const anchor = `| \`${model}\` |`;
    const at = doc.indexOf(anchor);
    if (at === -1) return null;
    const end = doc.indexOf('\n', at);
    return doc.slice(at, end === -1 ? undefined : end);
}
