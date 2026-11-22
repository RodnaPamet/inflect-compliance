/**
 * Which language a NIS2 gap-assessment text is shown in (#5764).
 *
 * The upstream question bank is English and German; since #4929 each domain
 * name and each question's plain-language text also carries a Bulgarian
 * translation (`withBulgarianDomain` / `withBulgarianQuestion`). The product
 * ships English and Bulgarian, so a Bulgarian reader reads Bulgarian and any
 * other reader reads English. A text with no translation in the reader's
 * language (the legalese `text` has none in Bulgarian) falls back to English.
 *
 * One rule for every page that shows the questions: the readiness page and
 * the self-assessment step used to disagree, the step picking German or
 * English, so a Bulgarian reader read English there and Bulgarian on the
 * readiness page.
 *
 * Client-safe: no server imports.
 */
export type Nis2QuestionLanguage = 'en' | 'bg';

export function nis2QuestionLanguage(locale: string): Nis2QuestionLanguage {
    return locale === 'bg' ? 'bg' : 'en';
}

/** A localised NIS2 text in `lang`, else its English, else empty. */
export function nis2Text(
    value: Partial<Record<string, string>> | null | undefined,
    lang: Nis2QuestionLanguage,
): string {
    return value?.[lang] ?? value?.en ?? '';
}
