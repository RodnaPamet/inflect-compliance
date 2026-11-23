/**
 * Every back-link label is a message key that resolves in BOTH catalogues.
 *
 * `canonical-parents.ts` used to store English labels ("Agents", "Controls",
 * "Internal Audit"), which `<BackAffordance>` dropped into the translated
 * "Back to {label}" — so a Bulgarian page read "Обратно към Agents" on about
 * sixty subpages, in the most visible place a phone has (#5823). Each entry
 * now names a key under `common`; this fails if one does not resolve in
 * `en.json` or `bg.json`, or if a key was added to the map without a
 * translation.
 */
import * as fs from 'fs';
import * as path from 'path';

import {
    BACK_LABEL_KEYS,
    CANONICAL_PARENT_MAP_INTERNAL,
    SECTION_LABEL_KEYS,
} from '@/lib/nav/canonical-parents';

type Catalog = Record<string, unknown>;

const read = (locale: string): Catalog =>
    JSON.parse(
        fs.readFileSync(path.resolve(__dirname, `../../messages/${locale}.json`), 'utf-8'),
    ) as Catalog;

const CATALOGS = { en: read('en'), bg: read('bg') };

function resolveCommon(catalog: Catalog, key: string): unknown {
    return `common.${key}`
        .split('.')
        .reduce<unknown>(
            (node, part) =>
                node && typeof node === 'object' ? (node as Catalog)[part] : undefined,
            catalog,
        );
}

const entries = Object.entries(CANONICAL_PARENT_MAP_INTERNAL);

describe('canonical-parent labels are translated', () => {
    it('the map is not empty (or every check below passes on nothing)', () => {
        expect(entries.length).toBeGreaterThan(100);
    });

    it.each(Object.keys(CATALOGS) as Array<keyof typeof CATALOGS>)(
        'every PARENT_MAP entry resolves to a string in %s.json',
        (locale) => {
            const missing = entries
                .filter(([, parent]) => {
                    const v = resolveCommon(CATALOGS[locale], parent.labelKey);
                    return typeof v !== 'string' || v.trim() === '';
                })
                .map(([child, parent]) => `${child} → common.${parent.labelKey}`);
            expect(missing).toEqual([]);
        },
    );

    it.each(Object.keys(CATALOGS) as Array<keyof typeof CATALOGS>)(
        'every key a parent may name, and every section label, resolves in %s.json',
        (locale) => {
            const keys = [
                ...BACK_LABEL_KEYS,
                ...Object.values(SECTION_LABEL_KEYS).map((k) => `sections.${k}`),
            ];
            const missing = keys.filter(
                (k) => typeof resolveCommon(CATALOGS[locale], k) !== 'string',
            );
            expect(missing).toEqual([]);
        },
    );

    it('a Bulgarian back link carries no Latin word (an untranslated label)', () => {
        // Acronyms and product names that ARE the Bulgarian text are allowed.
        const ALLOWED = new Set(['NIS2', 'A2A']);
        const latin = entries
            .map(([, parent]) => String(resolveCommon(CATALOGS.bg, parent.labelKey)))
            .filter((label) =>
                label.split(/\s+/).some((word) => /[A-Za-z]/.test(word) && !ALLOWED.has(word)),
            );
        expect([...new Set(latin)]).toEqual([]);
    });

    it('the agent register has a section label, in both languages', () => {
        // `/agents` was the one section the referrer-derived label had no entry
        // for, so "Back to Agents" fell through to the raw URL segment.
        expect(SECTION_LABEL_KEYS['/agents']).toBe('agents');
        expect(resolveCommon(CATALOGS.en, 'sections.agents')).toBe('Agents');
        expect(resolveCommon(CATALOGS.bg, 'sections.agents')).toBe('Агенти');
    });
});
