/**
 * The language the product's shipped LIBRARY is written in.
 *
 * Framework requirements, ISO clause titles and guidance, control and policy
 * templates are English, and stay English on a Bulgarian page: translating
 * them is a content project, not an interface defect (owner decision,
 * 2026-11-23). A page that shows one marks it with this as its `lang`
 * (WCAG 3.1.2, Language of Parts), so a screen reader reads it in English
 * rather than spelling English words with a Bulgarian voice — and the phone
 * audit's leak detector, which skips text a page declares to be in another
 * language, does not count it as interface text that missed the catalog.
 *
 * A record that carries its own language (`PolicyTemplate.language`,
 * `Policy.language`) is marked with that instead.
 */
export const LIBRARY_LANG = 'en';
