/**
 * PR-6 — training + background checks: structural ratchet. Provider
 * registration, encryption of the sensitive field, tenant-scoping, and the
 * three-model RLS + index shape.
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
describe('training / background — registration + wiring', () => {
    it('TrainingProvider is registered in bootstrap', () => {
        expect(read('src/app-layer/integrations/bootstrap.ts')).toMatch(/registry\.register\(new TrainingProvider\(\)\)/);
    });

    it('BackgroundCheck.resultSummary is in the encryption manifest', () => {
        const manifest = read('src/lib/security/encrypted-fields.ts');
        expect(manifest).toMatch(/BackgroundCheck: \['resultSummary'\]/);
    });

    it('the usecase is tenant-scoped; manual entry stands alone', () => {
        const uc = read('src/app-layer/usecases/training.ts');
        expect(uc).toMatch(/runInTenantContext/);
        expect(uc).not.toMatch(/from '@\/lib\/prisma'/);
        // manual create/assign/complete/record all present (no provider needed)
        for (const fn of ['createTrainingCourse', 'assignTraining', 'completeTrainingAssignment', 'recordBackgroundCheck']) {
            expect(uc).toMatch(new RegExp(`export async function ${fn}`));
        }
    });

    it('three models carry RLS + tenant indexes', () => {
        const schema = readPrismaSchema();
        for (const m of ['TrainingCourse', 'TrainingAssignment', 'BackgroundCheck']) {
            expect(schema).toMatch(new RegExp(`model ${m} \\{`));
        }
        // The trailing comment already said which model this is about;
        // now the assertion does too. `@@unique([tenantId, name])` is
        // declared by 6 models (Asset, TenantCustomRole,
        // TenantIdentityProvider, AutomationRule, TrainingCourse, Vendor),
        // so against the whole schema it held whether or not TrainingCourse
        // carried it.
        expect(braceBlockAfter(schema, 'model TrainingCourse\\s*\\{'))
            .toMatch(/@@unique\(\[tenantId, name\]\)/);
        const mig = readSql('prisma/migrations/20260707130000_training_background/migration.sql');
        expect(mig).toMatch(/FORCE ROW LEVEL SECURITY/);
        expect(mig).toMatch(/ARRAY\['TrainingCourse','TrainingAssignment','BackgroundCheck'\]/);
    });

    it('background-check list projection omits the sensitive resultSummary', () => {
        const uc = read('src/app-layer/usecases/training.ts');
        // listBackgroundChecks select must not include resultSummary
        const listBlock = uc.slice(uc.indexOf('export async function listBackgroundChecks'), uc.indexOf('export async function recordBackgroundCheck'));
        expect(listBlock).not.toMatch(/resultSummary: true/);
    });
});
