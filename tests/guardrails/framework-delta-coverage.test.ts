/**
 * Framework-version delta-gap coverage ratchet (Epic Regwatch 2A).
 *
 * Locks the delta engine's load-bearing properties:
 *   - the requirement diff is accurate (added/changed/removed) — unit-tested
 *     against the shared `computeRequirementDiff` with known versions;
 *   - the per-tenant delta only covers tenants with the framework INSTALLED
 *     (derived from ControlRequirementLink) and runs per-tenant under RLS
 *     (`withTenantDb`);
 *   - CHANGED requirements flag the tenant's mapped controls for re-review
 *     (`Control.status = NEEDS_REVIEW`);
 *   - finding materialisation is EXPLICIT, idempotent, and source-tagged
 *     `FRAMEWORK_UPDATE`;
 *   - TenantFrameworkDelta is RLS-protected + index-covered.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { computeRequirementDiff } from '@/app-layer/services/library-updater';
import { readPrismaSchema } from '../helpers/prisma-schema';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
/** Comments MASKED at the read seam (#2246) — assertions bind to code, not prose. */
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const engine = read('src/app-layer/usecases/framework-delta.ts');
const importer = read('src/app-layer/services/library-importer.ts');

describe('Framework delta — the diff is accurate (known versions)', () => {
    it('computes ADDED / CHANGED / REMOVED correctly', () => {
        const oldReqs = [
            { code: 'A.1', title: 'One', description: 'orig' },
            { code: 'A.2', title: 'Two', description: 'orig' },
            { code: 'A.3', title: 'Three', description: 'orig' },
        ];
        const newReqs = [
            { code: 'A.1', title: 'One', description: 'orig' }, // unchanged
            { code: 'A.2', title: 'Two (revised)', description: 'changed text' }, // changed
            // A.3 removed
            { code: 'A.4', title: 'Four', description: 'new' }, // added
        ];
        const diff = computeRequirementDiff(oldReqs, newReqs);
        expect(diff.added.map((a) => a.code)).toEqual(['A.4']);
        expect(diff.removed.map((r) => r.code)).toEqual(['A.3']);
        expect(diff.changed.map((c) => c.code)).toEqual(['A.2']);
        expect(diff.unchanged).toContain('A.1');
    });
});

describe('Framework delta — per-tenant, install-scoped, under RLS', () => {
    it('enumerates installed tenants via ControlRequirementLink + writes per-tenant under withTenantDb', () => {
        // Installed = a tenant has a control linked to one of the framework's reqs.
        expect(engine).toMatch(/controlRequirementLink\.findMany/);
        expect(engine).toMatch(/distinct:\s*\['tenantId'\]/);
        expect(engine).toMatch(/withTenantDb\(/);
    });

    it('CHANGED requirements flag the tenant\'s mapped controls for re-review', () => {
        const propagate = engine.slice(engine.indexOf('propagateFrameworkDelta'));
        expect(propagate).toMatch(/changedCodes/);
        expect(propagate).toMatch(/status:\s*'NEEDS_REVIEW'/);
        expect(propagate).toMatch(/control\.updateMany/);
    });
});

describe('Framework delta — finding materialisation is explicit + idempotent + source-tagged', () => {
    it('materialise is a separate opt-in usecase, deduped on sourceKind+sourceRef', () => {
        const m = engine.slice(engine.indexOf('materializeDeltaFindings'));
        expect(m).toMatch(/FRAMEWORK_UPDATE/);
        expect(m).toMatch(/finding\.findFirst/); // idempotent lookup before create
        expect(m).toMatch(/createFinding\(/);
        expect(m).toMatch(/sourceKind:/);
        expect(m).toMatch(/sourceRef/);
    });
});

describe('Framework delta — wired into the library importer', () => {
    it('a version UPDATE triggers recordDiffFromVersionHistory + propagateFrameworkDelta', () => {
        expect(importer).toMatch(/from '@\/app-layer\/usecases\/framework-delta'/);
        expect(importer).toMatch(/recordDiffFromVersionHistory\(/);
        expect(importer).toMatch(/propagateFrameworkDelta\(/);
        // Never on first create (no prior version) + fail-safe (import already committed).
        expect(importer).toMatch(/result\.action === 'updated'/);
        expect(importer).toMatch(/catch/);
    });

    it('the version-history entry carries the real diff codes (not empty placeholders)', () => {
        // The importer must thread the resolved diff codes into the history entry
        // — otherwise recordDiffFromVersionHistory sees no change and no-ops.
        expect(importer).toMatch(/addedCodes:\s*result\.addedCodes/);
        expect(importer).toMatch(/changedCodes:\s*result\.changedCodes/);
        expect(importer).toMatch(/removedCodes:\s*result\.removedCodes/);
    });
});

describe('Framework delta — model hardening', () => {
    it('TenantFrameworkDelta has RLS tenant-isolation in a migration + tenant index', () => {
        const mig = read('prisma/migrations/20260701160000_framework_version_delta/migration.sql');
        expect(mig).toMatch(/ALTER TABLE "TenantFrameworkDelta" FORCE ROW LEVEL SECURITY/);
        expect(mig).toMatch(/CREATE POLICY tenant_isolation ON "TenantFrameworkDelta"/);
        expect(mig).toMatch(/CREATE POLICY superuser_bypass ON "TenantFrameworkDelta"/);
        const schema = readPrismaSchema();
        const block = schema.slice(schema.indexOf('model TenantFrameworkDelta'));
        expect(block).toMatch(/@@index\(\[tenantId, status, createdAt\]\)/);
    });
});
