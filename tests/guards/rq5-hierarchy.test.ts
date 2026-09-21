/**
 * RQ-5 ratchet — risk hierarchy stays wired: two models + migration (RLS),
 * the pure recursive roll-up + CRUD/aggregation service, the routes, and
 * the hierarchy page.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readPrismaSchema } from '../helpers/prisma-schema';

// #2246 Class A / #2679 LANGUAGE SPLIT — comments are masked at the READ SEAM,
// and WHICH masker depends on the language of the file being read.
//
// `codeOf` lexes TypeScript. Handing it a `.sql` file is the single worst
// outcome available: every `--` comment survives verbatim while the call site
// READS as masked. Migrations therefore go through `readSql`, which lexes
// `--` and `/* */` (and nests, as Postgres does). TypeScript keeps `read`.
// Which extension flows through which helper was re-derived in this file, not
// assumed from the directory it lives in.
import { codeOf, sqlCodeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const readRaw = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const read = (p: string) => codeOf(readRaw(p));
const readSql = (p: string) => sqlCodeOf(readRaw(p));
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

describe('RQ-5 hierarchy', () => {
    it('schema declares both models + migration with RLS', () => {
        const schema = readPrismaSchema();
        expect(schema).toMatch(/model RiskHierarchyNode/);
        expect(schema).toMatch(/model RiskHierarchyLink/);
        const mig = 'prisma/migrations/20260610200000_rq5_hierarchy/migration.sql';
        expect(exists(mig)).toBe(true);
        expect(readSql(mig)).toMatch(/CREATE POLICY tenant_isolation ON "RiskHierarchyNode"/);
        expect(readSql(mig)).toMatch(/CREATE POLICY tenant_isolation ON "RiskHierarchyLink"/);
    });

    it('the service exposes the pure roll-up + CRUD + aggregation', () => {
        const src = read('src/app-layer/usecases/risk-hierarchy.ts');
        expect(src).toMatch(/export function aggregateTree/);
        for (const fn of ['createNode', 'updateNode', 'deleteNode', 'getTree', 'linkRisk', 'unlinkRisk', 'aggregateByHierarchy', 'getTreemapData']) {
            expect(src).toContain(`export async function ${fn}`);
        }
        expect(src).toMatch(/resolveALE/);
    });

    it('the routes + hierarchy page exist', () => {
        expect(exists('src/app/api/t/[tenantSlug]/risks/hierarchy/route.ts')).toBe(true);
        expect(exists('src/app/api/t/[tenantSlug]/risks/hierarchy/[nodeId]/route.ts')).toBe(true);
        expect(exists('src/app/api/t/[tenantSlug]/risks/hierarchy/[nodeId]/links/route.ts')).toBe(true);
        expect(exists('src/app/t/[tenantSlug]/(app)/risks/hierarchy/page.tsx')).toBe(true);
    });
});
