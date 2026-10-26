/**
 * Structural ratchet for the cross-region warm-standby design doc
 * (docs/multi-region.md).
 *
 * Keeps the design artefact complete: all four migration phases, the
 * three RPO/RTO tiers, the five engineering-review open questions, and
 * the cross-references that ground it in the real system (the production
 * compose file its "Current state" inventories, Epic B encryption-at-rest,
 * the Epic C.3 session model). A future edit that guts a section fails CI.
 *
 * The inventory cross-reference used to be `infra/terraform`. That tree
 * described an AWS estate that was never provisioned and was removed on
 * 2026-09-02 (#2226), so requiring it pinned the doc to infrastructure that
 * does not exist (#4308). Production is `deploy/docker-compose.prod.yml`.
 */
import * as fs from 'fs';
import * as path from 'path';

const DOC = path.resolve(__dirname, '../../docs/multi-region.md');

describe('multi-region design doc coverage', () => {
    it('docs/multi-region.md exists', () => {
        expect(fs.existsSync(DOC)).toBe(true);
    });

    const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf-8') : '';

    it('covers all four migration phases', () => {
        for (const p of ['Phase 1', 'Phase 2', 'Phase 3', 'Phase 4']) {
            expect(doc).toContain(p);
        }
    });

    it('defines the three RPO/RTO tiers', () => {
        for (const tier of ['same-region HA', 'cross-region warm-standby', 'cross-region active-active']) {
            expect(doc).toContain(tier);
        }
    });

    it('has an Open Questions section with five numbered decision gates', () => {
        const m = doc.match(/##\s*Open questions[\s\S]*$/i);
        expect(m).not.toBeNull();
        const section = m?.[0] ?? '';
        const numbered = (section.match(/^\d+\.\s+\*\*/gm) ?? []).length;
        expect(numbered).toBeGreaterThanOrEqual(5);
    });

    it('cross-references the production compose file, Epic B encryption, and Epic C.3 sessions', () => {
        expect(doc).toMatch(/deploy\/docker-compose\.prod\.yml/);
        // Epic B encryption-at-rest (per-tenant DEK / master KEK).
        expect(doc).toMatch(/epic-b-encryption|Tenant\.encryptedDek|Epic B/);
        // Epic C.3 session model.
        expect(doc).toMatch(/UserSession|Epic C\.3/);
    });
});
