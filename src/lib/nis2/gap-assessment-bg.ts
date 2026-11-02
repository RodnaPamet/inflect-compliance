/**
 * The Bulgarian NIS2 gap-assessment text (#4929; owner decision, 2026-11-02):
 * each domain's name and each question's plain-language restatement, merged
 * into the stored `{ en, de }` objects as `bg` when they are read.
 *
 * The upstream question set is imported verbatim, in English and German, by
 * its own sync (`prisma/fixtures/nis2-gap-assessment.json`). The translation
 * lives beside it rather than in it, so a re-sync never drops it. It is
 * licensed and attributed as the source is (CC BY 4.0); see the `notice` in
 * the JSON and prisma/fixtures/nis2-gap-assessment.LICENSE.md.
 *
 * Only the two texts a page shows are translated. The legalese `text` and the
 * domain descriptions stay English and German, and the legal references in
 * the questions are the source's own (German law); they are translated, not
 * adapted.
 */
import overlay from './gap-assessment-bg.json';

const DOMAINS: Readonly<Record<string, string>> = overlay.domains;
const QUESTIONS: Readonly<Record<string, string>> = overlay.questions;

type Localised = Record<string, unknown>;

function withBg(value: unknown, bg: string | undefined): unknown {
    if (!bg || !value || typeof value !== 'object' || Array.isArray(value)) return value;
    return { ...(value as Localised), bg };
}

/** A domain row with `name.bg` added when a translation exists. */
export function withBulgarianDomain<T extends { id: number; name: unknown }>(domain: T): T {
    return { ...domain, name: withBg(domain.name, DOMAINS[String(domain.id)]) as T['name'] };
}

/** A question row with `plainText.bg` added when a translation exists. */
export function withBulgarianQuestion<T extends { id: string; plainText: unknown }>(question: T): T {
    return { ...question, plainText: withBg(question.plainText, QUESTIONS[question.id]) as T['plainText'] };
}
