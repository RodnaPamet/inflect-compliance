/**
 * Limits of the content-translation lookup (#5996), shared by the route and
 * the client store. Client-safe: no imports.
 */

/** Texts per request. The client batches to this; the route refuses more. */
export const CONTENT_TRANSLATION_BATCH = 200;

/**
 * A text longer than this is never looked up. Catalogue strings are titles,
 * descriptions and steps; anything longer is a document a person wrote.
 */
export const CONTENT_TRANSLATION_MAX_CHARS = 4000;

/** The key a text is looked up under: its trimmed form. */
export function contentKey(text: string): string {
    return text.trim();
}
