/**
 * PR-4 — personnel / HRIS: structural ratchet. Provider registration, HRIS
 * job wiring, tenant-scoping, and the Employee RLS + tenant-index shape.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readPrismaSchema } from '../helpers/prisma-schema';
import { braceBlockAfter } from '../helpers/source-blocks';

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
const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const read = (rel: string) => codeOf(readRaw(rel));
const readSql = (rel: string) => sqlCodeOf(readRaw(rel));
describe('personnel / HRIS — registration + wiring', () => {
    it('BambooHR + Personnel providers are registered in bootstrap', () => {
        const boot = read('src/app-layer/integrations/bootstrap.ts');
        expect(boot).toMatch(/registry\.register\(new BambooHrProvider\(\)\)/);
        expect(boot).toMatch(/registry\.register\(new PersonnelProvider\(\)\)/);
    });

    it('hris-sync jobs are typed + registered', () => {
        const types = read('src/app-layer/jobs/types.ts');
        expect(types).toMatch(/'hris-sync': HrisSyncPayload/);
        expect(types).toMatch(/'hris-sync-dispatch': HrisSyncDispatchPayload/);
        const reg = read('src/app-layer/jobs/executor-registry.ts');
        expect(reg).toMatch(/executorRegistry\.register\('hris-sync'/);
        expect(reg).toMatch(/executorRegistry\.register\('hris-sync-dispatch'/);
        expect(read('src/app-layer/jobs/schedules.ts')).toMatch(/name: 'hris-sync-dispatch'/);
    });

    it('the hris-sync + personnel usecases are tenant-scoped (no global prisma)', () => {
        const hris = read('src/app-layer/usecases/hris-sync.ts');
        // BOUND TO THE IMPORT, not to the bare identifier — see the twin of
        // this assertion in identity-providers-connector.test.ts. A whole-file
        // `/runInTenantContext/` was satisfied by any mention anywhere,
        // including a comment, so #2501's docblock alone moved it from four
        // satisfying positions to five. The import occurs exactly once and is
        // what actually makes the file tenant-scoped.
        //
        // Written out at both call sites rather than hoisted into a variable:
        // the Class D analyser recovers a LITERAL needle and books a variable
        // one as un-analysable, which would trade a capped ambiguity for an
        // uncapped blind spot.
        expect(hris).toMatch(/import \{[^}]*\brunInTenantContext\b[^}]*\} from '@\/lib\/db-context';/);
        expect(hris).not.toMatch(/from '@\/lib\/prisma'/);
        expect(read('src/app-layer/usecases/personnel.ts')).toMatch(/import \{[^}]*\brunInTenantContext\b[^}]*\} from '@\/lib\/db-context';/);
    });

    it('Employee carries RLS + tenant indexes + self-FK', () => {
        const schema = readPrismaSchema();
        // Bound to Employee. `@@index([tenantId, status])` is declared by 32
        // models, so against the whole schema that assertion was satisfied by
        // any of them and said nothing about this one. The anchor's trailing
        // `\s*\{` stops it binding to a longer name that starts with
        // `Employee`, and `braceBlockAfter` throws when the model is gone —
        // which is what the `/model Employee \{/` existence check was for.
        const employee = braceBlockAfter(schema, 'model Employee\\s*\\{');
        expect(employee).toMatch(/@@unique\(\[tenantId, workEmail\]\)/);
        expect(employee).toMatch(/@@index\(\[tenantId, status\]\)/);
        expect(employee).toMatch(/@@index\(\[tenantId, managerEmployeeId\]\)/);
        const mig = readSql('prisma/migrations/20260707110000_personnel/migration.sql');
        expect(mig).toMatch(/ENABLE ROW LEVEL SECURITY/);
        expect(mig).toMatch(/FORCE ROW LEVEL SECURITY/);
        expect(mig).toMatch(/CREATE POLICY tenant_isolation ON "Employee"/);
        expect(mig).toMatch(/Employee_managerEmployeeId_fkey/);
    });

    it('personnel permission key exists in the PermissionSet', () => {
        const perms = read('src/lib/permissions.ts');
        expect(perms).toMatch(/personnel: \{ view: boolean; manage: boolean \}/);
        expect(perms).toMatch(/personnel: \['view', 'manage'\]/);
    });
});
