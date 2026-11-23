/**
 * @jest-environment jsdom
 *
 * Epic 62 — milestone registry + sessionStorage dedupe helpers.
 *
 * jsdom for `window.sessionStorage`. The hook itself ships its own
 * jsdom render test (`tests/rendered/use-celebration.test.tsx`); this
 * file pins the pure-data registry contract + the SSR-safe storage
 * helpers so they can be relied on outside the React lifecycle.
 */

import {
    MILESTONES,
    celebrationDedupeKey,
    clearCelebrated,
    hasCelebrated,
    markCelebrated,
    milestoneCopy,
    scopedMilestone,
    type MilestoneKey,
} from '@/lib/celebrations';
import { catalogTranslator, catalogValue } from '../helpers/catalog-translator';
import { EVIDENCE_EXPIRING_SOON_DAYS } from '@/app-layer/repositories/EvidenceRepository';

const ALL_KEYS: MilestoneKey[] = [
    'framework-100',
    'evidence-all-current',
    'audit-pack-complete',
    'first-control-mapped',
];

describe('MILESTONES registry', () => {
    it('contains every key the union declares', () => {
        for (const k of ALL_KEYS) {
            expect(MILESTONES[k]).toBeDefined();
            expect(MILESTONES[k].key).toBe(k);
        }
    });

    it('every entry has a valid preset and copy in BOTH catalogs', () => {
        // The copy is read in the viewer's language, so a key only one
        // catalog holds is a toast that throws (or reads raw) in the other.
        for (const def of Object.values(MILESTONES)) {
            expect(['burst', 'rain', 'fireworks']).toContain(def.preset);
            for (const locale of ['en', 'bg'] as const) {
                expect(catalogValue(locale, def.messageKey).length).toBeGreaterThan(0);
                expect(catalogValue(locale, def.descriptionKey).length).toBeGreaterThan(0);
            }
        }
    });

    it('a Bulgarian viewer gets Bulgarian toast copy', () => {
        for (const key of ALL_KEYS) {
            const copy = milestoneCopy(key, catalogTranslator('bg'));
            expect(copy.message).toMatch(/[\u0400-\u04FF]/);
            expect(copy.description).toMatch(/[\u0400-\u04FF]/);
        }
    });

    it('keys are stable identifiers (no rename without intent)', () => {
        // This test exists so a rename of a milestone key is a
        // visible diff in the test file too — keys ride in
        // sessionStorage and analytics, so renames need ceremony.
        expect(Object.keys(MILESTONES).sort()).toEqual([
            'audit-pack-complete',
            'evidence-all-current',
            'first-control-mapped',
            'framework-100',
        ]);
    });
});

describe("'evidence-all-current' names the window it is checked against", () => {
    it('says the same number of days as the expiring-soon window', () => {
        // The celebration fires when nothing is expiring soon, and "soon" is
        // EVIDENCE_EXPIRING_SOON_DAYS. It said "this week" while the window
        // was 30 days (#4277); a window change must move the text with it.
        expect(milestoneCopy('evidence-all-current', catalogTranslator('en')).description).toContain(
            `${EVIDENCE_EXPIRING_SOON_DAYS} days`,
        );
    });
});

describe('celebrationDedupeKey', () => {
    it('namespaces with the inflect prefix to avoid collisions', () => {
        expect(celebrationDedupeKey('framework-100')).toBe(
            'inflect.celebrate:framework-100',
        );
    });
});

describe('hasCelebrated / markCelebrated / clearCelebrated', () => {
    beforeEach(() => {
        window.sessionStorage.clear();
    });

    it('hasCelebrated is false before mark, true after', () => {
        expect(hasCelebrated('framework-100')).toBe(false);
        markCelebrated('framework-100');
        expect(hasCelebrated('framework-100')).toBe(true);
    });

    it('mark is idempotent — second call is a no-op', () => {
        markCelebrated('framework-100');
        const first = window.sessionStorage.getItem(
            celebrationDedupeKey('framework-100'),
        );
        markCelebrated('framework-100');
        const second = window.sessionStorage.getItem(
            celebrationDedupeKey('framework-100'),
        );
        // Second mark overwrites with a new ISO timestamp, but
        // hasCelebrated still returns true and the key still exists.
        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        expect(hasCelebrated('framework-100')).toBe(true);
    });

    it('clearCelebrated lets the milestone fire again', () => {
        markCelebrated('framework-100');
        expect(hasCelebrated('framework-100')).toBe(true);
        clearCelebrated('framework-100');
        expect(hasCelebrated('framework-100')).toBe(false);
    });

    it('different keys do not interfere with each other', () => {
        markCelebrated('framework-100');
        expect(hasCelebrated('framework-100')).toBe(true);
        expect(hasCelebrated('audit-pack-complete')).toBe(false);
    });

    it('scoped keys are independent of the bare milestone key', () => {
        // Per-resource celebration must NOT be deduped by an
        // earlier global mark, and vice-versa.
        markCelebrated('framework-100');
        expect(hasCelebrated('framework-100:iso27001')).toBe(false);
        markCelebrated('framework-100:iso27001');
        expect(hasCelebrated('framework-100:iso27001')).toBe(true);
        expect(hasCelebrated('framework-100:soc2')).toBe(false);
    });
});

describe('scopedMilestone builder', () => {
    const copy = milestoneCopy('framework-100', catalogTranslator('en'));

    it('returns the registry preset + the given copy + colon-namespaced key', () => {
        const out = scopedMilestone('framework-100', 'iso27001', copy);
        expect(out.preset).toBe(MILESTONES['framework-100'].preset);
        expect(out.message).toBe(copy.message);
        expect(out.description).toBe(copy.description);
        expect(out.key).toBe('framework-100:iso27001');
    });

    it('descriptionOverride wins over the copy default', () => {
        const out = scopedMilestone('framework-100', 'iso27001', copy, {
            descriptionOverride: 'ISO 27001:2022 — done.',
        });
        expect(out.description).toBe('ISO 27001:2022 — done.');
        // Other fields untouched.
        expect(out.preset).toBe(MILESTONES['framework-100'].preset);
        expect(out.message).toBe(copy.message);
    });

    it('different scopes produce different dedupe keys for the same milestone', () => {
        const a = scopedMilestone('audit-pack-complete', 'pack_abc', copy);
        const b = scopedMilestone('audit-pack-complete', 'pack_xyz', copy);
        expect(a.key).not.toBe(b.key);
    });

    it('survives sessionStorage throwing (private mode) without crashing', () => {
        // Spy on the prototype so the override reaches the helpers'
        // call sites — jsdom's Storage methods live on the prototype
        // and direct instance assignment doesn't always shadow them.
        const setSpy = jest
            .spyOn(Storage.prototype, 'setItem')
            .mockImplementation(() => {
                throw new Error('quota');
            });
        const getSpy = jest
            .spyOn(Storage.prototype, 'getItem')
            .mockImplementation(() => {
                throw new Error('disabled');
            });
        const removeSpy = jest
            .spyOn(Storage.prototype, 'removeItem')
            .mockImplementation(() => {
                throw new Error('disabled');
            });
        try {
            // None of these may throw.
            expect(() => markCelebrated('framework-100')).not.toThrow();
            expect(hasCelebrated('framework-100')).toBe(false);
            expect(() => clearCelebrated('framework-100')).not.toThrow();
        } finally {
            setSpy.mockRestore();
            getSpy.mockRestore();
            removeSpy.mockRestore();
        }
    });
});
