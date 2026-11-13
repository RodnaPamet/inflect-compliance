/**
 * EVERY PII COLUMN IS REACHED BY ONE OF THE TWO ROTATION SWEEPS — #5070.
 *
 * `pii-middleware` writes its own `*Encrypted` columns with v1 `encryptField`,
 * and they are NOT in `ENCRYPTED_FIELDS`. The master-KEK rotation sweep walked
 * only that manifest, and nothing else re-encrypted them
 * (`scripts/backfill-encryption.ts` skips values that are already encrypted).
 * So the runbook's "every tenant reports zero v1 rows, now remove
 * DATA_ENCRYPTION_KEY_PREVIOUS" was true of the manifest and false of the
 * database, and the first read after that step returned null for every
 * `User.email`, auditor account, vendor contact and stored OAuth token across
 * the deployment — recoverable only with the archived old key.
 *
 * Two sweeps, because one cannot do both: the per-tenant job skips any model
 * with no `tenantId` column (a per-tenant sweep of a global table would run
 * once per tenant or race itself), so the global models go through
 * `scripts/rotate-global-pii.ts`.
 *
 * What this guard holds is the SPLIT, against the live schema. The lists are
 * hand-written because nothing in `src/lib/security/` can read the schema —
 * which is exactly the kind of list that goes stale, so the partition is
 * checked rather than trusted.
 */
import {
    PII_ENCRYPTED_COLUMNS,
    PII_GLOBAL_MODELS,
    PII_TENANT_SCOPED_MODELS,
} from '@/lib/security/pii-middleware';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseSchemaModels } from '../helpers/prisma-schema-models';
import { REPO_ROOT, repoRelativeFiles } from '../helpers/repo-files';

const MODELS = parseSchemaModels();
const byName = new Map(MODELS.map((m) => [m.name, m]));

/**
 * One model's raw schema text. `SchemaModel` exposes field NAMES but not their
 * `@map` targets, and the physical column is what raw SQL needs.
 */
function modelBlock(name: string): string {
    const schema = repoRelativeFiles()
        .filter((rel) => /^prisma\/schema\/.*\.prisma$/.test(rel))
        .map((rel) => readFileSync(join(REPO_ROOT, rel), 'utf8'))
        .join('\n');
    const m = new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, 'm').exec(schema);
    if (!m) throw new Error(`no model block for ${name}`);
    return m[1];
}

const PII_MODELS = Object.keys(PII_ENCRYPTED_COLUMNS);
const CLASSIFIED = [...PII_TENANT_SCOPED_MODELS, ...PII_GLOBAL_MODELS];

describe('the population this guard ranges over', () => {
    it('reads the whole schema and a non-empty PII manifest', () => {
        // The denominator. An empty PII manifest would make every assertion
        // below vacuously true.
        expect(MODELS.length).toBeGreaterThan(100);
        expect(PII_MODELS.length).toBeGreaterThan(0);
    });

    it('names a column for every PII model, derived from the field map', () => {
        for (const model of PII_MODELS) {
            expect({ model, columns: PII_ENCRYPTED_COLUMNS[model].length > 0 })
                .toEqual({ model, columns: true });
        }
    });
});

describe('every PII model is classified exactly once', () => {
    it('is an EXACT partition — nothing unclassified, nothing listed twice', () => {
        // A model added to PII_FIELD_MAP without being classified would be
        // swept by neither, and the symptom only appears after the runbook's
        // irreversible last step.
        expect([...CLASSIFIED].sort()).toEqual([...PII_MODELS].sort());
        expect(new Set(CLASSIFIED).size).toBe(CLASSIFIED.length);
    });

    it('classifies nothing that is not a PII model', () => {
        for (const m of CLASSIFIED) {
            expect({ model: m, inManifest: PII_MODELS.includes(m) })
                .toEqual({ model: m, inManifest: true });
        }
    });
});

describe('the classification matches the live schema', () => {
    it('every tenant-scoped PII model really has a tenantId column', () => {
        // The per-tenant sweep skips a model without it, so a mis-classified
        // model here is a column the rotation silently never reaches.
        for (const name of PII_TENANT_SCOPED_MODELS) {
            const model = byName.get(name);
            expect({ name, found: model !== undefined }).toEqual({ name, found: true });
            const has = model!.fields.some((f) => f.name === 'tenantId' && !f.isList);
            expect({ name, hasTenantId: has }).toEqual({ name, hasTenantId: true });
        }
    });

    it('every global PII model really has NO tenantId column', () => {
        // The other direction: a model that GAINS a tenantId should move to the
        // per-tenant sweep, and this is what notices.
        for (const name of PII_GLOBAL_MODELS) {
            const model = byName.get(name);
            expect({ name, found: model !== undefined }).toEqual({ name, found: true });
            const has = model!.fields.some((f) => f.name === 'tenantId' && !f.isList);
            expect({ name, hasTenantId: has }).toEqual({ name, hasTenantId: false });
        }
    });

    it('every named encrypted column is a real PHYSICAL column', () => {
        // The sweep rewrites through RAW SQL, so these names must be database
        // columns, not Prisma field names — and for the `mapped: true` models
        // they differ: `User.email String @map("emailEncrypted")` means the
        // field is `email` and the column is `emailEncrypted`. Checking
        // `scalarFieldNames` therefore asserts the wrong thing, and said
        // `User.emailEncrypted` did not exist when it does.
        for (const [name, columns] of Object.entries(PII_ENCRYPTED_COLUMNS)) {
            expect({ name, inSchema: byName.has(name) }).toEqual({ name, inSchema: true });
            const block = modelBlock(name);
            for (const column of columns) {
                const asField = new RegExp(`^\\s+${column}\\s`, 'm').test(block);
                const asMapTarget = block.includes(`@map("${column}")`);
                expect({ name, column, physical: asField || asMapTarget })
                    .toEqual({ name, column, physical: true });
            }
        }
    });

    it('no PII model carries a model-level @@map, which the raw SQL would miss', () => {
        // `rewriteV1Field` builds `FROM "<model>"`, so a model-level @@map
        // would point the sweep at a table that does not exist. True today;
        // asserted so that adding one is a deliberate change here too.
        for (const name of Object.keys(PII_ENCRYPTED_COLUMNS)) {
            const model = byName.get(name)!;
            expect({ name, tableName: model.tableName }).toEqual({ name, tableName: name });
        }
    });
});
