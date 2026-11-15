/**
 * EVERY HARNESS CRITERION HAS A NAME, IN BOTH LANGUAGES (#5313).
 *
 * The harness matrix labels each column through
 * `agents.harness.criterion.<id>`. `H3.egress_enforced` reached the ladder
 * (the contract package) without one, so its column header showed the raw
 * message key in English and Bulgarian alike. The criteria are read from the
 * ladder itself, so the next one added there fails here until it is named.
 */
import { ALL_HARNESS_CRITERIA } from '@/lib/agentic/harness-ladder';

type Messages = { agents: { harness: { criterion: Record<string, Record<string, unknown>> } } };

const LOCALES: Record<string, Messages> = {
    en: require('../../../messages/en.json'),
    bg: require('../../../messages/bg.json'),
};

describe.each(Object.keys(LOCALES))('%s', (locale) => {
    it.each([...ALL_HARNESS_CRITERIA])('names %s', (criterion) => {
        const [level, key] = criterion.split('.');
        const label = LOCALES[locale].agents.harness.criterion[level]?.[key];
        expect(typeof label).toBe('string');
        expect((label as string).trim()).not.toBe('');
    });
});
