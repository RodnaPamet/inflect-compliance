/**
 * Facts the public pages (`/about`, `/privacy`) state about who runs Inflect
 * (#5957: Google's OAuth verification needs a public home page and privacy
 * policy on a verified domain; owner decision 2026-11-25 to host them in the
 * app).
 *
 * The controller's identity is read from the Bulgarian Commercial Register
 * (Агенция по вписванията), UIC 208694564, on 2026-11-25. The localised name
 * and registered address are in `messages/*.json` under `external.legal`;
 * what does not change with the language lives here.
 *
 * Client-safe: no imports.
 */

/** The company's unified identification code (ЕИК) in the Commercial Register. */
export const CONTROLLER_UIC = '208694564';

/** The public mailbox for data-protection questions and requests (owner decision 2026-11-25). */
export const PRIVACY_CONTACT_EMAIL = 'privacy@inflect.bg';

/** The date the current privacy policy took effect, ISO. Change it with the text. */
export const PRIVACY_POLICY_EFFECTIVE = '2026-11-25';

/** Google's policy the Limited Use statement names. */
export const GOOGLE_API_USER_DATA_POLICY_URL = 'https://developers.google.com/terms/api-services-user-data-policy';

/**
 * The privacy policy's sections, in order. Each section's text is in
 * `external.privacyPolicy.sections.<id>`: `heading`, paragraphs `p1..p<before>`,
 * then the list `items.<key>` when there is one, then paragraphs `a1..a<after>`.
 * `tests/unit/public-site/legal-pages-messages.test.ts` holds this shape and the
 * message files equal, in both languages.
 */
export interface PolicySection {
    readonly id: string;
    readonly before: number;
    readonly list?: readonly string[];
    readonly after?: number;
}

export const PRIVACY_POLICY_SECTIONS: readonly PolicySection[] = [
    { id: 'scope', before: 2 },
    { id: 'controller', before: 2 },
    { id: 'roles', before: 2 },
    { id: 'data', before: 5 },
    { id: 'purposes', before: 4 },
    { id: 'google', before: 8 },
    { id: 'processors', before: 1, list: ['hosting', 'email', 'signin', 'billing', 'ai', 'hibp'], after: 3 },
    { id: 'retention', before: 5 },
    { id: 'security', before: 1 },
    { id: 'cookies', before: 1 },
    { id: 'rights', before: 2 },
    { id: 'changes', before: 1 },
];

/** The About page's feature list, in order (`external.publicAbout.features.<key>`). */
export const ABOUT_FEATURES: readonly string[] = ['frameworks', 'registers', 'access', 'calendar'];
