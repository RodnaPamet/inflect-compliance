/**
 * The Evidence columns an integration check result is stored as.
 *
 * A provider's `mapResultToEvidence` composes the row's title, body and
 * category from its answer, and the answer carries the third party's own text:
 * a GitHub repository, branch and required status-check names, a ServiceNow
 * change number, the control's check type. Both writers that store it, the
 * manual run (`usecases/integrations.ts::runAutomationForControl`) and the
 * scheduled one (`jobs/automation-runner.ts`), go through this function, so a
 * hostile or broken upstream cannot put markup into a row that every renderer
 * reads back, and a provider added later is covered without remembering to be.
 *
 * Title, body and category are prose: `sanitizePlainText`. A body composed of
 * nothing but safe text comes back byte-identical.
 *
 * `contentJson` is appended to the body as pretty-printed JSON, and only its
 * string VALUES are sanitised. Running the serialised JSON through
 * `sanitizePlainText` would parse it as HTML: a `<` inside a value opens a
 * "tag" that swallows the document up to the next `>`, and a legacy entity
 * such as `&reg` is decoded, so the stored body would stop being JSON. A value
 * that is a whole http(s) URL goes through `sanitizeUrlText` instead, because
 * `sanitizePlainText` turns `?a=1&region=us` into `?a=1®ion=us`.
 *
 * @module integrations/evidence-text
 */
import { sanitizePlainText, sanitizeUrlText } from '@/lib/security/sanitize';
import type { EvidencePayload } from './types';

export interface IntegrationEvidenceText {
    title: string;
    content: string;
    category: string;
}

/** Category for a payload that names none, or one that is blank once sanitised. */
const DEFAULT_CATEGORY = 'integration';

/** A string that is one absolute http(s) URL and nothing else. */
const WHOLE_HTTP_URL = /^https?:\/\/\S+$/i;

export function integrationEvidenceText(payload: EvidencePayload): IntegrationEvidenceText {
    const body = sanitizePlainText(payload.content);
    return {
        title: sanitizePlainText(payload.title),
        content:
            payload.contentJson === undefined
                ? body
                : `${body}\n\n${JSON.stringify(sanitizeJsonStringValues(payload.contentJson), null, 2)}`,
        category: sanitizePlainText(payload.category) || DEFAULT_CATEGORY,
    };
}

/**
 * A copy of `value` with every string inside it sanitised, at any depth.
 * Keys, numbers, booleans and null are kept as they are. Anything that is not
 * a plain object or an array (a `Date`, say) is left for `JSON.stringify` to
 * serialise as it would have.
 */
export function sanitizeJsonStringValues(value: unknown): unknown {
    if (typeof value === 'string') {
        return WHOLE_HTTP_URL.test(value) ? sanitizeUrlText(value) : sanitizePlainText(value);
    }
    if (Array.isArray(value)) return value.map(sanitizeJsonStringValues);
    if (isPlainObject(value)) {
        return Object.fromEntries(
            Object.entries(value).map(([key, inner]) => [key, sanitizeJsonStringValues(inner)]),
        );
    }
    return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object') return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}
