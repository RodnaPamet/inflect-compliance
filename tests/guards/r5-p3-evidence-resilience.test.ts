/**
 * R5-P3 — evidence resilience + hygiene (structural ratchet).
 *
 * This PR ships a focused subset of the resilience sweep; the ratchet locks
 * what landed:
 *   4.  The columns memo depends on hydratedNow (labels ↔ sort agree).
 *   6.  The uploads route validates its metadata with Zod (folder cap,
 *       reviewCycle enum, parseable nextReviewDate).
 *   7.  Reversible/lifecycle mutations bump the list-cache version.
 *   9.  The policy evidence link deep-links the sheet (?ev=), not a dead route.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const CLIENT = 'src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx';
const EVIDENCE = 'src/app-layer/usecases/evidence.ts';
const RETENTION = 'src/app-layer/usecases/evidence-retention.ts';
const UPLOADS_ROUTE = 'src/app/api/t/[tenantSlug]/evidence/uploads/route.ts';
const POLICY_CHECKLIST = 'src/app/t/[tenantSlug]/(app)/policies/[policyId]/PolicyEvidenceChecklist.tsx';

describe('R5-P3 (4) columns memo tracks the hydrated clock', () => {
    it('the columns memo dependency array includes hydratedNow', () => {
        expect(read(CLIENT)).toMatch(/\]\), \[t, permissions, apiUrl, tx, hydratedNow\]\)/);
    });
});

describe('R5-P3 (6) uploads route validates metadata', () => {
    const src = read(UPLOADS_ROUTE);
    it('parses metadata through a Zod schema with the folder cap + reviewCycle enum + date check', () => {
        expect(src).toMatch(/UploadMetadataSchema/);
        expect(src).toMatch(/folder: z\.string\(\)\.max\(120\)/);
        expect(src).toMatch(/reviewCycle: z\.enum\(\['MONTHLY', 'QUARTERLY', 'SEMI_ANNUALLY', 'ANNUALLY'\]\)/);
        expect(src).toMatch(/Number\.isNaN\(Date\.parse/);
        expect(src).toMatch(/safeParse/);
    });
});

describe('R5-P3 (7) mutations bump the list cache', () => {
    it('bulkDeleteEvidence bumps', () => {
        const src = read(EVIDENCE);
        expect(src).toMatch(/export async function bulkDeleteEvidence[\s\S]{0,1200}bumpEntityCacheVersion\(ctx, 'evidence'\)/);
    });
    it('retention update + archive + unarchive bump (3 sites)', () => {
        const src = read(RETENTION);
        expect((src.match(/bumpEntityCacheVersion\(ctx, 'evidence'\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
    });
});

describe('R5-P3 (9) the policy evidence link is not dead', () => {
    it('deep-links the evidence sheet via ?ev=', () => {
        const src = read(POLICY_CHECKLIST);
        expect(src).toMatch(/\/evidence\?ev=\$\{item\.evidence\.id\}/);
        expect(src).not.toMatch(/\/evidence\/\$\{item\.evidence\.id\}/);
    });
});
