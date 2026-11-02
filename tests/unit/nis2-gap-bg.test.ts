/**
 * The Bulgarian NIS2 gap-assessment text (#4929) covers every domain and
 * every question in the vendored fixture, names nothing the fixture lacks,
 * and is merged into the stored `{ en, de }` text when a row is read.
 *
 * The overlay is keyed by id beside the fixture rather than inside it, so a
 * re-sync that adds a question would otherwise leave it English-only on a
 * Bulgarian page with nothing to say so.
 */
import fixture from '../../prisma/fixtures/nis2-gap-assessment.json';
import overlay from '@/lib/nis2/gap-assessment-bg.json';
import { withBulgarianDomain, withBulgarianQuestion } from '@/lib/nis2/gap-assessment-bg';


describe('NIS2 gap-assessment Bulgarian text', () => {
    it('has a Bulgarian name for every domain, and for no other', () => {
        const fixtureIds = fixture.domains.map((d) => String(d.id)).sort();
        expect(Object.keys(overlay.domains).sort()).toEqual(fixtureIds);
    });

    it('has a Bulgarian question for every question, and for no other', () => {
        const fixtureIds = fixture.questions.map((q) => q.id).sort();
        expect(Object.keys(overlay.questions).sort()).toEqual(fixtureIds);
    });

    it('is Bulgarian text, never an empty or copied English string', () => {
        const english = new Map<string, string>(
            fixture.questions.map((q) => [q.id, (q as { plainText: { en: string } }).plainText.en]),
        );
        const isBulgarian = (text: string) => text.trim() !== '' && /[\u0400-\u04FF]/.test(text);
        const badQuestions = Object.entries(overlay.questions)
            .filter(([id, text]) => !isBulgarian(text) || text === english.get(id))
            .map(([id]) => id);
        const badDomains = Object.entries(overlay.domains)
            .filter(([, text]) => !isBulgarian(text))
            .map(([id]) => id);
        expect({ badQuestions, badDomains }).toEqual({ badQuestions: [], badDomains: [] });
    });

    it('carries the CC BY 4.0 attribution beside the text', () => {
        expect(overlay.notice).toContain('CC BY 4.0');
        expect(overlay.notice).toContain('nis2-gap-assessment-schema');
    });

    it('adds bg to a domain and a question as they are read, keeping en and de', () => {
        const domain = withBulgarianDomain({ id: 0, name: { en: 'Scoping & Registration', de: 'Anwendungsbereich' } });
        expect(domain.name).toEqual({
            en: 'Scoping & Registration',
            de: 'Anwendungsbereich',
            bg: overlay.domains['0'],
        });

        const question = withBulgarianQuestion({ id: 'gap-0-01', plainText: { en: 'Q', de: 'F' } });
        expect(question.plainText).toEqual({ en: 'Q', de: 'F', bg: overlay.questions['gap-0-01'] });
    });

    it('leaves a row it has no translation for unchanged', () => {
        const question = { id: 'gap-99-99', plainText: { en: 'Q' } };
        expect(withBulgarianQuestion(question)).toEqual(question);
        const notAnObject = { id: 'gap-0-01', plainText: null };
        expect(withBulgarianQuestion(notAnObject)).toEqual(notAnObject);
    });
});
