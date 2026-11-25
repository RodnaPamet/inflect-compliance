/**
 * The privacy policy's catalogue and its shape agree, in both languages (#5957).
 *
 * `PRIVACY_POLICY_SECTIONS` says which paragraphs the page renders. This holds
 * the other direction from the rendered test: every paragraph in
 * `external.privacyPolicy.sections` is one the page renders, so a sentence
 * added to the catalogue but not to the shape cannot sit there unpublished.
 * It also holds the two languages to the same placeholders and rich-text tags,
 * and the two public paths to exact matches.
 */
import enMessages from '../../../messages/en.json';
import bgMessages from '../../../messages/bg.json';
import { ABOUT_FEATURES, PRIVACY_POLICY_SECTIONS } from '@/lib/public-site/legal-facts';
import { isPublicPath } from '@/lib/auth/guard';

type Tree = { [key: string]: string | Tree };
const CATALOGS = { en: enMessages as unknown as Tree, bg: bgMessages as unknown as Tree };

function leaves(tree: Tree, prefix = ''): Map<string, string> {
    const out = new Map<string, string>();
    for (const [k, v] of Object.entries(tree)) {
        const path = prefix ? `${prefix}.${k}` : k;
        if (typeof v === 'string') out.set(path, v);
        else for (const [kk, vv] of leaves(v, path)) out.set(kk, vv);
    }
    return out;
}

function expectedPolicyKeys(): string[] {
    const keys: string[] = [];
    for (const s of PRIVACY_POLICY_SECTIONS) {
        keys.push(`${s.id}.heading`);
        for (let n = 1; n <= s.before; n++) keys.push(`${s.id}.p${n}`);
        for (const item of s.list ?? []) keys.push(`${s.id}.items.${item}`);
        for (let n = 1; n <= (s.after ?? 0); n++) keys.push(`${s.id}.a${n}`);
    }
    return keys.sort();
}

const markers = (value: string): string[] => [...value.matchAll(/\{\w+\}|<\/?\w+>/g)].map((m) => m[0]).sort();

describe.each(['en', 'bg'] as const)('privacy policy catalogue (%s)', (lang) => {
    const external = CATALOGS[lang].external as Tree;
    const policy = leaves((external.privacyPolicy as Tree).sections as Tree);

    it('holds exactly the paragraphs the page renders, none empty', () => {
        expect([...policy.keys()].sort()).toEqual(expectedPolicyKeys());
        for (const [key, value] of policy) expect([key, value.trim().length > 0]).toEqual([key, true]);
    });

    it('holds exactly the About page features', () => {
        const features = leaves((external.publicAbout as Tree).features as Tree);
        expect([...features.keys()].sort()).toEqual([...ABOUT_FEATURES].sort());
    });
});

describe('the two languages carry the same placeholders and tags', () => {
    const en = leaves(CATALOGS.en.external as Tree);
    const bg = leaves(CATALOGS.bg.external as Tree);
    const ours = [...en.keys()].filter((k) => /^(legal|publicAbout|privacyPolicy)\./.test(k));

    it.each(ours)('%s', (key) => {
        expect(bg.has(key)).toBe(true);
        expect(markers(bg.get(key) ?? '')).toEqual(markers(en.get(key) ?? ''));
    });

    it('the Google section carries the Limited Use statement with its policy link', () => {
        const p8 = en.get('privacyPolicy.sections.google.p8') ?? '';
        expect(p8).toMatch(/^Inflect's use and transfer to any other app of information received from Google APIs will adhere to the <policy>Google API Services User Data Policy<\/policy>, including the Limited Use requirements\.$/);
    });
});

describe('the public paths are exact', () => {
    it.each(['/about', '/privacy'])('%s is public', (p) => expect(isPublicPath(p)).toBe(true));
    it.each(['/about/x', '/privacy/x', '/privacy-admin', '/aboutx'])('%s is not', (p) => expect(isPublicPath(p)).toBe(false));
});
