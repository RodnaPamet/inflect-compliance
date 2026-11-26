/**
 * The public home page and privacy policy render every word they promise, in
 * both languages (#5957).
 *
 * Both pages build their keys from `legal-facts.ts` (`PRIVACY_POLICY_SECTIONS`,
 * `ABOUT_FEATURES`), so `i18n-keys-resolve` cannot see them. This renders the
 * real server components through next-intl's own translator over the real
 * catalogues: a missing key, a missing rich-text tag or a dropped placeholder
 * fails here. The catalogue test beside it holds the other direction, that no
 * paragraph in the catalogue is left unrendered.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import enMessages from '../../messages/en.json';
import bgMessages from '../../messages/bg.json';

const MESSAGES = { en: enMessages, bg: bgMessages } as const;
let locale: 'en' | 'bg' = 'en';

// A STRICT translator over the real catalogues. The repository's manual
// `next-intl` mock reads English only and strips rich-text tags, and the real
// package is ESM, which this project cannot load. This one throws on a missing
// key, a placeholder left unfilled and a tag with no handler, which is what
// the pages' built keys need proving.
function strictTranslator(messages: unknown, namespace: string) {
    const lookup = (key: string): string => {
        let node: unknown = messages;
        for (const part of `${namespace}.${key}`.split('.')) {
            node = node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined;
        }
        if (typeof node !== 'string') throw new Error(`no message at ${namespace}.${key}`);
        return node;
    };
    const fill = (text: string, values: Record<string, unknown>): string =>
        text.replace(/\{(\w+)\}/g, (_, name: string) => {
            if (!(name in values)) throw new Error(`placeholder {${name}} unfilled`);
            return String(values[name]);
        });
    const t = (key: string, values: Record<string, unknown> = {}) => fill(lookup(key), values);
    t.rich = (key: string, values: Record<string, unknown> = {}) => {
        const text = fill(lookup(key), values);
        const parts: React.ReactNode[] = [];
        const re = /<(\w+)>(.*?)<\/\1>/g;
        let last = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
            parts.push(text.slice(last, m.index));
            const tag = values[m[1]];
            if (typeof tag !== 'function') throw new Error(`no handler for <${m[1]}> in ${key}`);
            parts.push(React.createElement(React.Fragment, { key: m.index }, (tag as (c: string) => React.ReactNode)(m[2])));
            last = m.index + m[0].length;
        }
        parts.push(text.slice(last));
        if (/<\/?\w+>/.test(text.slice(last))) throw new Error(`unbalanced tag in ${key}`);
        return parts;
    };
    return t;
}

jest.mock('next-intl/server', () => ({
    getLocale: async () => locale,
    getTranslations: async (namespace: string) => strictTranslator(MESSAGES[locale], namespace),
}));

import AboutPage from '@/app/about/page';
import PrivacyPolicyPage from '@/app/privacy/page';
import { CONTROLLER_UIC, PRIVACY_CONTACT_EMAIL } from '@/lib/public-site/legal-facts';

describe.each(['en', 'bg'] as const)('public legal pages (%s)', (lang) => {
    beforeEach(() => {
        locale = lang;
    });

    it('the privacy policy renders every section, the controller, the contact and the Limited Use link', async () => {
        render(await PrivacyPolicyPage());
        const main = screen.getByRole('main');
        // Twelve sections, each with its heading.
        expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(12);
        expect(main.textContent).toContain(CONTROLLER_UIC);
        expect(main.textContent).not.toMatch(/\{(name|uic|address|date)\}/);
        const mail = screen.getAllByRole('link', { name: PRIVACY_CONTACT_EMAIL });
        expect(mail.length).toBeGreaterThanOrEqual(2);
        for (const a of mail) expect(a.getAttribute('href')).toBe(`mailto:${PRIVACY_CONTACT_EMAIL}`);
        const policy = screen
            .getAllByRole('link')
            .find((a) => a.getAttribute('href') === 'https://developers.google.com/terms/api-services-user-data-policy');
        expect(policy).toBeDefined();
        expect(main.textContent).toContain('Limited Use');
        expect(screen.getByRole('link', { name: lang === 'en' ? 'About Inflect' : 'За Inflect' }).getAttribute('href')).toBe('/about');
    });

    it('the home page says what Inflect is and links to the privacy policy and sign-in', async () => {
        render(await AboutPage());
        const main = screen.getByRole('main');
        expect(screen.getAllByRole('listitem')).toHaveLength(4);
        expect(main.textContent).toContain(CONTROLLER_UIC);
        const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
        expect(hrefs).toEqual(expect.arrayContaining(['/privacy', '/login', `mailto:${PRIVACY_CONTACT_EMAIL}`]));
    });
});
