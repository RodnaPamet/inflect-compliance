/**
 * UNCLASSIFIED AI-system risk tier (#3691, deploy 1 of 2) — the readers.
 *
 * UNCLASSIFIED marks a provisional AiSystem entry nobody has classified. It is
 * a value the COLUMN can hold, not a tier the Act defines, so:
 *
 *   (a) the classifier can never return it, over its whole input space — and
 *       its empty-input default is MINIMAL, which is exactly why a provisional
 *       entry must not be stored by running the classifier on nothing;
 *   (b) `isClassifiedTier` singles it out and nothing else;
 *   (c) the shared tone table covers every stored tier and does not tone it
 *       like MINIMAL, and an unknown value is a warning, never neutral;
 *   (d) the AI-system register's filter offers it as its own value, first, with
 *       a label in every shipped catalog.
 *
 * The stored-tier population is read from the Prisma schema itself, so a tier
 * added to the column without a tone or a filter value fails here.
 */
import * as fs from 'fs';
import * as path from 'path';

import {
    ANNEX_III_AREAS,
    ART5_PROHIBITED_PRACTICES,
    ART50_TRANSPARENCY_CASES,
    classifyAiSystem,
    isClassifiedTier,
    type AiRiskTier,
    type ClassificationInput,
    type StoredAiRiskTier,
} from '@/lib/eu-ai-act/classification';
import { AI_ACT_TIER_TONE, aiActTierTone } from '@/lib/eu-ai-act/tier-display';
import { buildAiSystemFilters } from '@/app/t/[tenantSlug]/(app)/risks/ai-systems/filter-defs';
import { parseDeclaredEnums } from '../helpers/prisma-enum-order';

/** The four tiers the Act defines — the classifier's whole codomain. */
const CLASSIFIED: readonly AiRiskTier[] = ['PROHIBITED', 'HIGH', 'LIMITED', 'MINIMAL'];

/** What `AiSystem.riskTier` can hold, in declaration order, from the schema. */
function storedTiers(): StoredAiRiskTier[] {
    const decl = parseDeclaredEnums().find((e) => e.prismaName === 'AiRiskTier');
    if (!decl) throw new Error('enum AiRiskTier not found in prisma/schema');
    return decl.members as StoredAiRiskTier[];
}

describe('the stored-tier population', () => {
    it('is UNCLASSIFIED followed by the four classified tiers, in that order', () => {
        expect(storedTiers()).toEqual(['UNCLASSIFIED', ...CLASSIFIED]);
    });
});

describe('(a) classifyAiSystem never returns UNCLASSIFIED', () => {
    const prohibited = [...ART5_PROHIBITED_PRACTICES.map((o) => o.id), null];
    const annexIII = [...ANNEX_III_AREAS.map((o) => o.id), null];
    const annexI = [true, false, null];
    const transparency = [...ART50_TRANSPARENCY_CASES.map((o) => o.id), null];

    function* everyInput(): Generator<ClassificationInput> {
        for (const prohibitedPractice of prohibited)
            for (const annexIIIArea of annexIII)
                for (const isAnnexIProductSafetyComponent of annexI)
                    for (const transparencyCase of transparency)
                        yield { prohibitedPractice, annexIIIArea, isAnnexIProductSafetyComponent, transparencyCase };
    }

    it('returns one of the four classified tiers for every combination of answers', () => {
        const seen = new Map<string, number>();
        let combinations = 0;
        const offending: Array<{ input: ClassificationInput; tier: unknown }> = [];
        for (const input of everyInput()) {
            combinations += 1;
            const { tier } = classifyAiSystem(input);
            seen.set(tier, (seen.get(tier) ?? 0) + 1);
            if (!(CLASSIFIED as readonly string[]).includes(tier)) offending.push({ input, tier });
        }

        // The whole product, not a sample — and a non-empty one.
        expect(combinations).toBe(prohibited.length * annexIII.length * annexI.length * transparency.length);
        expect(combinations).toBeGreaterThan(0);
        expect(offending).toEqual([]);
        expect(seen.has('UNCLASSIFIED')).toBe(false);
        // Not vacuous: the enumeration reaches every classified tier.
        expect([...seen.keys()].sort()).toEqual([...CLASSIFIED].sort());
    });

    it('classifies an all-empty input as MINIMAL — the Act’s default, which a provisional entry must never be stored through', () => {
        expect(classifyAiSystem({}).tier).toBe('MINIMAL');
        expect(
            classifyAiSystem({
                prohibitedPractice: null,
                annexIIIArea: null,
                isAnnexIProductSafetyComponent: null,
                transparencyCase: null,
            }).tier,
        ).toBe('MINIMAL');
    });
});

describe('(b) isClassifiedTier', () => {
    it('is false for UNCLASSIFIED and for nothing else', () => {
        const tiers = storedTiers();
        expect(tiers.filter((t) => !isClassifiedTier(t))).toEqual(['UNCLASSIFIED']);
        expect(tiers.filter((t) => isClassifiedTier(t))).toEqual([...CLASSIFIED]);
    });
});

describe('(c) the shared tone table', () => {
    it('has exactly the stored tiers as keys', () => {
        expect(Object.keys(AI_ACT_TIER_TONE).sort()).toEqual(storedTiers().sort());
    });

    it('does not tone UNCLASSIFIED as neutral, nor like MINIMAL', () => {
        expect(AI_ACT_TIER_TONE.UNCLASSIFIED).not.toBe('neutral');
        expect(AI_ACT_TIER_TONE.UNCLASSIFIED).not.toBe(AI_ACT_TIER_TONE.MINIMAL);
        expect(aiActTierTone('UNCLASSIFIED')).not.toBe('neutral');
    });

    it('tones an unknown stored value as a warning, never neutral', () => {
        expect(aiActTierTone('SOME_FUTURE_TIER')).toBe('warning');
        expect(aiActTierTone('')).toBe('warning');
    });

    it('agrees with the table for every stored tier', () => {
        for (const tier of storedTiers()) expect(aiActTierTone(tier)).toBe(AI_ACT_TIER_TONE[tier]);
    });
});

describe('(d) the AI-systems register filter', () => {
    type Catalog = Record<string, unknown>;
    const loadCatalog = (locale: string): Catalog =>
        JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'messages', `${locale}.json`), 'utf-8')) as Catalog;
    const CATALOGS: Record<string, Catalog> = { en: loadCatalog('en'), bg: loadCatalog('bg') };

    /** `AiSystemsClient` resolves these labels with `useTranslations('risks')`. */
    const NAMESPACE = 'risks';
    const MISSING = '\u0000missing:';

    function lookup(catalog: Catalog, dotted: string): unknown {
        return dotted
            .split('.')
            .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Catalog)[k] : undefined), catalog);
    }

    function resolverFor(catalog: Catalog) {
        return (key: string) => {
            const v = lookup(catalog, `${NAMESPACE}.${key}`);
            return typeof v === 'string' ? v : `${MISSING}${key}`;
        };
    }

    /** Echo resolver: each label IS its message key, so the key can be read back. */
    const echo = (key: string) => key;
    const tGroup = (key: string) => key;

    function riskTierOptions(t: (key: string) => string) {
        const def = buildAiSystemFilters(t, tGroup).find((f) => f.key === 'riskTier');
        if (!def) throw new Error('riskTier filter not defined');
        return def.options ?? [];
    }

    it('offers every stored tier, UNCLASSIFIED first', () => {
        const values = riskTierOptions(echo).map((o) => o.value);
        expect(values[0]).toBe('UNCLASSIFIED');
        expect(values).toEqual(storedTiers());
    });

    it.each(Object.keys(CATALOGS))(
        'resolves the UNCLASSIFIED label key to a non-empty string of its own in %s',
        (locale) => {
            const catalog = CATALOGS[locale];
            const unclassified = riskTierOptions(echo).find((o) => o.value === 'UNCLASSIFIED');
            expect(unclassified).toBeDefined();
            const key = String(unclassified?.label);

            const message = lookup(catalog, `${NAMESPACE}.${key}`);
            expect(typeof message).toBe('string');
            expect((message as string).trim()).not.toBe('');

            // And the built filter actually renders that string — not a
            // missing-key fallback, and not MINIMAL's label.
            const localized = riskTierOptions(resolverFor(catalog));
            const label = localized.find((o) => o.value === 'UNCLASSIFIED')?.label;
            expect(label).toBe(message);
            expect(String(label).startsWith(MISSING)).toBe(false);
            expect(label).not.toBe(localized.find((o) => o.value === 'MINIMAL')?.label);
        },
    );
});
