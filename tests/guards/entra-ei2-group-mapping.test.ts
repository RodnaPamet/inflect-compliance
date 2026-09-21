/**
 * EI-2 ratchet — the Entra group → IC-role mapping plane must stay wired:
 * model + RLS migration, the role-mapping resolver, the CRUD usecase + routes,
 * and the OWNER exclusion (groups must never confer ownership).
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

describe('EI-2 Entra group → role mapping', () => {
    it('the TenantEntraGroupMapping model is tenant-scoped + uniquely keyed', () => {
        const schema = read('prisma/schema/auth.prisma');
        expect(schema).toMatch(/model TenantEntraGroupMapping \{/);
        expect(schema).toMatch(/@@unique\(\[tenantId, aadGroupId\]\)/);
        expect(schema).toMatch(/@@index\(\[tenantId\]\)/);
    });

    it('the migration adds the table with the three RLS policies', () => {
        const dir = 'prisma/migrations/20260609090000_ei2_tenant_entra_group_mapping/migration.sql';
        expect(exists(dir)).toBe(true);
        const sql = readSql(dir);
        expect(sql).toMatch(/CREATE TABLE "TenantEntraGroupMapping"/);
        expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/);
        expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/);
        expect(sql).toMatch(/CREATE POLICY tenant_isolation ON "TenantEntraGroupMapping"/);
        expect(sql).toMatch(/CREATE POLICY tenant_isolation_insert ON "TenantEntraGroupMapping"/);
        expect(sql).toMatch(/CREATE POLICY superuser_bypass ON "TenantEntraGroupMapping"/);
    });

    it('OWNER is not a mappable role — groups never confer ownership', () => {
        const schema = read('src/app-layer/schemas/entra-group-mapping.schemas.ts');
        expect(schema).toMatch(/ENTRA_MAPPABLE_ROLES/);
        expect(schema).not.toMatch(/'OWNER'/);
    });

    it('the pure role resolver exists', () => {
        expect(exists('src/lib/auth/entra-role-mapping.ts')).toBe(true);
        expect(read('src/lib/auth/entra-role-mapping.ts')).toMatch(/export function resolveRoleFromGroups/);
    });

    it('the CRUD usecase is admin-gated + audit-logged', () => {
        const uc = read('src/app-layer/usecases/entra-group-mappings.ts');
        expect(uc).toMatch(/assertCanAdmin/);
        expect(uc).toMatch(/logEvent/);
        for (const fn of [
            'listEntraGroupMappings',
            'createEntraGroupMapping',
            'updateEntraGroupMapping',
            'deleteEntraGroupMapping',
        ]) {
            expect(uc).toContain(`export async function ${fn}`);
        }
    });

    it('the admin API routes exist (collection + item)', () => {
        expect(exists('src/app/api/t/[tenantSlug]/sso/entra/group-mappings/route.ts')).toBe(true);
        expect(exists('src/app/api/t/[tenantSlug]/sso/entra/group-mappings/[mappingId]/route.ts')).toBe(true);
        const collection = read('src/app/api/t/[tenantSlug]/sso/entra/group-mappings/route.ts');
        expect(collection).toMatch(/requirePermission\('admin\.manage'/);
    });
});
