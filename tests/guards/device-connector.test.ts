/**
 * PR-5 — device monitoring: structural ratchet. Provider registration, token
 * auth, tenant-scoping, and the Device + TenantDeviceToken RLS + index shape.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readPrismaSchema } from '../helpers/prisma-schema';
import { codeOf, sqlCodeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
/**
 * MASKED AT THE READ SEAM — #2246 Class A.
 *
 * Nineteen whole-file assertions, three of them measured prose-inflated:
 * `authorizeDeviceReport`, `runInTenantContext` and `NOT_APPLICABLE` each
 * occur in the prose of the file they are asserted against as well as in its
 * code — `NOT_APPLICABLE` four times raw and once masked, one deletion from
 * green-on-prose.
 *
 * LANGUAGE SPLIT (#2644, #2679): the migration is SQL and takes `readSql`
 * (`sqlCodeOf` lexes `--`); `codeOf` would blank nothing in it. The Prisma
 * schema uses `//` and is masked by `codeOf` like any TypeScript read.
 */
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const readSql = (rel: string) => sqlCodeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

describe('device monitoring — registration + wiring', () => {
    it('DeviceProvider is registered in bootstrap', () => {
        const boot = read('src/app-layer/integrations/bootstrap.ts');
        expect(boot).toMatch(/registry\.register\(new DeviceProvider\(\)\)/);
    });

    it('the report route is token-authed (verifyDeviceToken), not permission-gated', () => {
        const route = read('src/app/api/t/[tenantSlug]/devices/report/route.ts');
        expect(route).toMatch(/authorizeDeviceReport/);
        expect(route).not.toMatch(/requirePermission/);
        // token's tenant must match the URL slug
        expect(route).toMatch(/authed\.tenantId/);
        const auth = read('src/lib/auth/device-token-auth.ts');
        expect(auth).toMatch(/verifyDeviceToken/);
        expect(auth).toMatch(/tenant\.id !== verified\.tenantId/);
    });

    it('device usecase is tenant-scoped; token hashed at rest', () => {
        const uc = read('src/app-layer/usecases/device.ts');
        expect(uc).toMatch(/runInTenantContext/);
        const auth = read('src/lib/auth/device-token-auth.ts');
        expect(auth).toMatch(/createHash\('sha256'\)/);
        // never store plaintext — only tokenHash is persisted
        expect(uc).toMatch(/tokenHash/);
        expect(uc).not.toMatch(/data: \{[^}]*plaintext/);
    });

    it('Device + TenantDeviceToken carry RLS + tenant indexes', () => {
        const compliance = codeOf(readPrismaSchema());
        expect(compliance).toMatch(/model Device \{/);
        expect(compliance).toMatch(/@@unique\(\[tenantId, serialNumber\]\)/);
        const auth = read('prisma/schema/auth.prisma');
        expect(auth).toMatch(/model TenantDeviceToken \{/);
        expect(auth).toMatch(/@@unique\(\[tokenHash\]\)/);
        const mig = readSql('prisma/migrations/20260707120000_device/migration.sql');
        expect(mig).toMatch(/CREATE POLICY tenant_isolation ON "Device"/);
        expect(mig).toMatch(/CREATE POLICY tenant_isolation ON "TenantDeviceToken"/);
        expect(mig).toMatch(/FORCE ROW LEVEL SECURITY/);
    });

    it('null booleans are NOT_APPLICABLE (never counted as fail)', () => {
        const checks = read('src/app-layer/integrations/providers/device/checks.ts');
        expect(checks).toMatch(/NOT_APPLICABLE/);
        expect(checks).toMatch(/notApplicable/);
    });
});
