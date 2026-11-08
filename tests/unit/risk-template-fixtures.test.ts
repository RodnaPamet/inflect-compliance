/**
 * The built-in risk-template library: one writer, every set, stable ids.
 *
 * `seedRiskTemplates` is what both the production seeder and the dev seed run,
 * so these are the properties a deploy depends on:
 *   - every row is upserted by its id, and an existing row is brought back to
 *     the fixture's content (the update carries every field but the id);
 *   - ids are unique across ALL sets, or one set would overwrite another's row;
 *   - the generic set keeps the ids the old inline seed derived from each
 *     title, or every database seeded before the move would get duplicates.
 */
import { RISK_TEMPLATE_FIXTURES, seedRiskTemplates } from '../../prisma/risk-template-fixtures';

const all = RISK_TEMPLATE_FIXTURES.flatMap((f) => f.data.templates.map((t) => ({ label: f.label, t })));

describe('the built-in risk-template library', () => {
    it('carries every set, none empty', () => {
        expect(RISK_TEMPLATE_FIXTURES.map((f) => [f.label, f.data.templates.length > 0])).toEqual([
            ['generic', true], ['privacy', true], ['ssdf', true], ['cis', true],
            ['asvs', true], ['iso27701', true], ['finos-aigf', true],
        ]);
    });

    it('never gives two templates the same id, across sets', () => {
        const seen = new Map<string, string>();
        const clashes: string[] = [];
        for (const { label, t } of all) {
            const prior = seen.get(t.id);
            if (prior) clashes.push(`${t.id}: ${prior} and ${label}`);
            else seen.set(t.id, label);
        }
        expect(clashes).toEqual([]);
    });

    it('keeps the ids the generic set had when the dev seed derived them from titles', () => {
        const legacy = (title: string) => title.replace(/\s+/g, '-').toLowerCase().slice(0, 25);
        const generic = RISK_TEMPLATE_FIXTURES.find((f) => f.label === 'generic')!.data.templates;
        expect(generic.filter((t) => t.id !== legacy(t.title)).map((t) => t.id)).toEqual([]);
    });
});

describe('seedRiskTemplates', () => {
    it('upserts every template by id, with the fixture content as both create and update', async () => {
        const upsert = jest.fn().mockResolvedValue({});
        const written = await seedRiskTemplates({ riskTemplate: { upsert } } as never);

        expect(upsert).toHaveBeenCalledTimes(all.length);
        for (const [i, { t }] of all.entries()) {
            const { id, ...fields } = t;
            expect(upsert.mock.calls[i]![0]).toEqual({ where: { id }, create: t, update: fields });
        }
        expect(written).toEqual(RISK_TEMPLATE_FIXTURES.map((f) => ({ label: f.label, count: f.data.templates.length })));
    });
});
