/**
 * What writes the evidence owner is what reads it.
 *
 * `Evidence` carries two owner columns — the legacy free-text `owner` and the
 * real `ownerUserId` FK. Three surfaces write the FK (the edit modal's
 * `UserCombobox`, the bulk "Assign owner" action, and SoD / notification
 * routing), while every read path rendered the free-text column and NO read
 * path joined the user. Assigning an owner appeared to do nothing.
 *
 * Two halves have to hold together, and each fails differently:
 *
 *   - the SELECT must join `ownerUser`, or the resolver has nothing to read;
 *   - both renderers must go through the resolver, or one of them drifts back
 *     to the legacy column while the other is correct — which is worse than
 *     the original bug, because the two surfaces then disagree about the same
 *     row.
 *
 * The resolution ORDER is covered behaviourally in
 * tests/unit/evidence-owner-label.test.ts; this file guards the wiring.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const codeOnly = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const REPO = 'src/app-layer/repositories/EvidenceRepository.ts';
const LIST = 'src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx';
const SHEET = 'src/app/t/[tenantSlug]/(app)/evidence/EvidenceDetailSheet.tsx';

describe('evidence owner: the column written is the column read', () => {
    it('the list select joins ownerUser, not just the FK', () => {
        // `ownerUserId: true` alone is what made the FK write-only: the id
        // reached the client and there was nothing to render it as.
        const src = codeOnly(read(REPO));
        expect(src).toMatch(/ownerUser:\s*\{\s*select:/);
    });

    it.each([
        ['the list', LIST],
        ['the detail sheet', SHEET],
    ])('%s renders the resolved owner', (_label, file) => {
        const src = codeOnly(read(file));
        expect(src).toMatch(/from '@\/lib\/evidence-owner-label'/);
        expect(src).toMatch(/\bownerLabel\(/);
    });

    it('neither surface renders the legacy column directly any more', () => {
        // The specific expressions that were the bug. A surface that keeps
        // one of these is reading past the resolver.
        expect(codeOnly(read(LIST))).not.toMatch(/\bev\.owner\s*\|\|/);
        expect(codeOnly(read(SHEET))).not.toMatch(/if\s*\(\s*evidence\.owner\s*\)/);
    });

    it('the legacy column is still SELECTED — it is the fallback', () => {
        // Dropping it would silently blank the owner for every pre-FK row and
        // for everything the create-from-text modal writes.
        expect(codeOnly(read(REPO))).toMatch(/^\s*owner:\s*true,/m);
    });
});
