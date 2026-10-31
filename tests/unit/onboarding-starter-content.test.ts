/**
 * Every starter risk and task the setup wizard creates has its text in every
 * language the UI ships (#4701). A starter added to the English catalogue
 * without a translation would be written in English for a Bulgarian user.
 */
import { STARTER_RISKS, STARTER_TASKS, localizedStarterRisk } from '@/app-layer/usecases/onboarding-automation';
import { STARTER_RISK_TEXT, STARTER_TASK_TEXT } from '@/data/onboarding-starter-content';
import { RISK_CATEGORIES } from '@/lib/risk/categories';
import { SUPPORTED_LOCALES } from '@/lib/locale-constants';

const CANONICAL: ReadonlySet<string> = new Set(RISK_CATEGORIES);
const translatedLocales = SUPPORTED_LOCALES.filter((l): l is Exclude<typeof l, 'en'> => l !== 'en');

describe.each(translatedLocales)('starter content in %s', (locale) => {
    it('has every starter risk, and no entry the catalogue lacks', () => {
        const titles = STARTER_RISKS.map((r) => r.title).sort();
        expect(Object.keys(STARTER_RISK_TEXT[locale]).sort()).toEqual(titles);
    });

    it('translates a free-text category and leaves a canonical one as stored', () => {
        for (const risk of STARTER_RISKS) {
            const text = STARTER_RISK_TEXT[locale][risk.title];
            if (CANONICAL.has(risk.category)) {
                expect(text.category).toBeUndefined();
                expect(localizedStarterRisk(risk, locale).category).toBe(risk.category);
            } else {
                expect(text.category).toEqual(expect.any(String));
                expect(text.category).not.toBe(risk.category);
            }
            expect(text.title).not.toBe(risk.title);
        }
    });

    it('has every starter task, and no entry the catalogue lacks', () => {
        const titles = STARTER_TASKS.map((t) => t.title).sort();
        expect(Object.keys(STARTER_TASK_TEXT[locale]).sort()).toEqual(titles);
    });

    it('gives each translated title once, so the title check cannot match two starters', () => {
        const risks = Object.values(STARTER_RISK_TEXT[locale]).map((t) => t.title);
        const tasks = Object.values(STARTER_TASK_TEXT[locale]).map((t) => t.title);
        expect(new Set(risks).size).toBe(risks.length);
        expect(new Set(tasks).size).toBe(tasks.length);
    });
});
