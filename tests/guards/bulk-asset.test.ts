/**
 * Phase 2 — Asset bulk actions on the canonical BulkActionBar.
 * Asset criticality is DERIVED from C/I/A (display only), so the bulk actions
 * are the two settable, displayed columns: Set status + Assign owner.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// At the seam, not per assertion, so a new `expect(read(...))` inherits it.
// String literals are KEPT — masking them would silently empty assertions that
// harvest codes or ids from source. Every path this file reads is a
// TypeScript-alike, re-derived per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => codeOf(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

describe('Asset bulk — backend', () => {
    it('has bulk status + assign API routes', () => {
        expect(exists('src/app/api/t/[tenantSlug]/assets/bulk/status/route.ts')).toBe(true);
        expect(exists('src/app/api/t/[tenantSlug]/assets/bulk/assign/route.ts')).toBe(true);
    });
    it('usecases assert write + use a tenant-scoped bulk update', () => {
        const uc = read('src/app-layer/usecases/asset.ts');
        expect(uc).toMatch(/export async function bulkSetAssetStatus/);
        expect(uc).toMatch(/export async function bulkAssignAsset/);
        expect(uc).toMatch(/assertCanWrite\(ctx\)/);
        expect(uc).toMatch(/AssetRepository\.bulkUpdate/);
        const repo = read('src/app-layer/repositories/AssetRepository.ts');
        expect(repo).toMatch(/static async bulkUpdate/);
        expect(repo).toMatch(/tenantId: ctx\.tenantId/);
    });
    it('schemas cap the batch + enum the status', () => {
        const sch = read('src/lib/schemas/index.ts');
        expect(sch).toMatch(/BulkAssetStatusSchema/);
        expect(sch).toMatch(/BulkAssetAssignSchema/);
        expect(sch).toMatch(/z\.enum\(\['ACTIVE', 'RETIRED'\]\)/);
    });
});

describe('Asset bulk — client', () => {
    const client = read('src/app/t/[tenantSlug]/(app)/assets/AssetsClient.tsx');
    it('mounts BulkActionBar with status + assign actions', () => {
        expect(client).toMatch(/<BulkActionBar\b/);
        expect(client).toMatch(/value: 'status'/);
        expect(client).toMatch(/value: 'assign'/);
    });
});
