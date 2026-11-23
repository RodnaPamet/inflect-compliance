/**
 * The English-on-a-Bulgarian-page detector (`scripts/mobile-audit/leaks.ts`)
 * calls a leak a leak, and does not call seeded data, brands or acronyms one.
 * It backs the `englishLeaks` count in the mobile audit and the mobile E2E
 * ratchet, so a detector that drifted would move a baseline on its own.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildLeakCatalog, findEnglishLeaks } from '../../scripts/mobile-audit/leaks';

const en = {
    nav: { back: 'Back to {section}', agents: 'Agents', controls: 'Controls' },
    filters: { clear: 'Clear filters', none: 'No results match these filters' },
    brand: { okta: 'Okta', iso: 'ISO 27001', ad: 'Active Directory' },
    login: { orgPlaceholder: 'Acme Corp' },
    untranslated: { principal: 'Service principal: {status} for the agent' },
    short: { user: 'User {name}' },
    plural: { items: '{count, plural, one {# item} other {# items}}' },
};
const bg = {
    nav: { back: 'Обратно към {section}', agents: 'Агенти', controls: 'Контроли' },
    filters: { clear: 'Изчисти филтрите', none: 'Няма резултати за тези филтри' },
    brand: { okta: 'Okta', iso: 'ISO 27001', ad: 'Active Directory (локален)' },
    login: { orgPlaceholder: 'Акме ООД' },
    untranslated: { principal: 'Service principal: {status} for the agent' },
    short: { user: 'Потребител {name}' },
    plural: { items: '{count, plural, one {# елемент} other {# елемента}}' },
};
const catalog = buildLeakCatalog(en, bg);
const leaksIn = (texts: string[], chromeTexts: string[] = [], names: string[] = []) =>
    findEnglishLeaks({ texts, chromeTexts }, catalog, new Set(names));

describe('findEnglishLeaks', () => {
    it('finds an English catalog message rendered on a Bulgarian page', () => {
        expect(leaksIn(['Clear filters'])).toEqual([{ text: 'Clear filters', reason: 'CATALOG' }]);
    });

    it('finds a placeholder message by its literal text', () => {
        expect(leaksIn(['Service principal: ACTIVE for the agent'])).toEqual([
            { text: 'Service principal: ACTIVE for the agent', reason: 'CATALOG' },
        ]);
    });

    it('finds an English label embedded in a Bulgarian sentence', () => {
        expect(leaksIn(['Обратно към Agents'])).toEqual([{ text: 'Обратно към Agents', reason: 'EMBEDDED' }]);
    });

    it('finds an English month and a relative time', () => {
        expect(leaksIn(['29 November 2026', 'преди 20 minutes ago']).map((l) => l.reason)).toEqual(['DATE', 'DATE']);
    });

    it('finds a short hard-coded English control label that never reached the catalog', () => {
        expect(leaksIn(['Expand all'], ['Expand all'])).toEqual([{ text: 'Expand all', reason: 'CHROME' }]);
    });

    it('does not call Bulgarian text, a kept brand or an acronym a leak', () => {
        expect(leaksIn(['Изчисти филтрите', 'Okta', 'ISO 27001', 'Обратно към Контроли'], ['Okta'])).toEqual([]);
    });

    it('does not call a product name the Bulgarian catalog keeps a leak', () => {
        expect(leaksIn(['Active Directory (локален)', 'Свързва се с Active Directory през LDAPS'])).toEqual([]);
    });

    it('does not call a seeded name a leak, alone or inside a sentence', () => {
        expect(leaksIn(['Acme Corp', 'Acme Corp: 4 риска'], [], ['Acme Corp'])).toEqual([]);
    });

    it('does not judge a seeded title by the word heuristic, even on a button', () => {
        expect(leaksIn(['Implement MFA for privileged accounts'], ['Implement MFA for privileged accounts'])).toEqual([]);
    });

    it('does not match data against a placeholder message with a short literal', () => {
        // "User {name}" would otherwise match the seeded control "User Endpoint Devices".
        expect(leaksIn(['User Endpoint Devices'])).toEqual([]);
    });

    it('skips ICU plurals, whose literal text is not one string', () => {
        expect(catalog.patterns.some((p) => p.literal.includes('item'))).toBe(false);
    });
});

describe('the catalog built from the repository', () => {
    const root = path.resolve(__dirname, '..', '..');
    const real = buildLeakCatalog(
        JSON.parse(readFileSync(path.join(root, 'messages', 'en.json'), 'utf8')),
        JSON.parse(readFileSync(path.join(root, 'messages', 'bg.json'), 'utf8')),
    );

    it('is non-empty, so a parse change cannot silently zero every leak count', () => {
        expect(real.exact.size).toBeGreaterThan(1000);
        expect(real.patterns.length).toBeGreaterThan(100);
    });

    it('holds no Bulgarian text', () => {
        expect(Array.from(real.exact).filter((s) => /[Ѐ-ӿ]/.test(s))).toEqual([]);
    });
});
