/**
 * EI-3 ratchet — SCIM Groups push provisioning stays wired to the EI-2 engine.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
// #2246 Class A / #2679 LANGUAGE SPLIT — comments are masked at the READ SEAM,
// and WHICH masker depends on the language of the file being read.
//
// `codeOf` lexes TypeScript. Handing it a `.sql` file is the single worst
// outcome available: every `--` comment survives verbatim while the call site
// READS as masked. Migrations therefore go through `readSql`, which lexes
// `--` and `/* */` (and nests, as Postgres does). TypeScript keeps `read`.
// Which extension flows through which helper was re-derived in this file.
import { codeOf, sqlCodeOf } from '../helpers/source-blocks';

const readRaw = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const read = (p: string) => codeOf(readRaw(p));
const readSql = (p: string) => sqlCodeOf(readRaw(p));
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

describe('EI-3 SCIM Groups', () => {
    it('ScimGroup model exists with tenant-scoped uniqueness', () => {
        const schema = read('prisma/schema/auth.prisma');
        expect(schema).toMatch(/model ScimGroup/);
        expect(schema).toMatch(/@@unique\(\[tenantId, externalId\]\)/);
    });

    it('the migration creates ScimGroup with RLS', () => {
        const mig = 'prisma/migrations/20260610320000_ei3_scim_group/migration.sql';
        expect(exists(mig)).toBe(true);
        const sql = readSql(mig);
        expect(sql).toMatch(/CREATE TABLE "ScimGroup"/);
        expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/);
        expect(sql).toMatch(/CREATE POLICY tenant_isolation ON "ScimGroup"/);
    });

    it('the SCIM Groups routes exist (collection + item)', () => {
        expect(exists('src/app/api/scim/v2/Groups/route.ts')).toBe(true);
        expect(exists('src/app/api/scim/v2/Groups/[id]/route.ts')).toBe(true);
        const item = read('src/app/api/scim/v2/Groups/[id]/route.ts');
        for (const verb of ['GET', 'PUT', 'PATCH', 'DELETE']) {
            expect(item).toMatch(new RegExp(`export function ${verb}`));
        }
        expect(item).toMatch(/authenticateScimRequest/);
    });

    it('member changes reconcile through syncEntraMembershipRole (EI-2 engine)', () => {
        const src = read('src/app-layer/usecases/scim-groups.ts');
        // Re-implemented on the shared engine + current model (not the old
        // applyEntraGroupMapping / EntraGroupMapping).
        expect(src).toMatch(/syncEntraMembershipRole/);
        expect(src).toMatch(/tenantEntraGroupMapping/);
        expect(src).not.toMatch(/applyEntraGroupMapping/);
        // PatchOp add/remove + displayName handled.
        expect(src).toMatch(/op\.op === 'add'/);
        expect(src).toMatch(/op\.op === 'remove'/);
        expect(src).toMatch(/displayname/);
    });
});
