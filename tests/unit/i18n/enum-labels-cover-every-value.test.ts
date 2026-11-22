/**
 * Every value of an enum a page renders through a message key has a label
 * in every locale (#5273, #5295).
 *
 * The public audit-share page rendered `external.auditShare.entityType.TEST_RUN`
 * and the vendor page `vendors.linkRelation.ASSESSMENT_SOURCED` as raw keys,
 * because each enum gained a value its labels never did. Reading the values
 * from the generated client means a value added later fails here, not on a
 * customer's screen.
 */
import { AuditPackItemEntityType, VendorLinkRelation } from '@prisma/client';

const LOCALES = ['en', 'bg'] as const;

function at(messages: Record<string, unknown>, path: string): Record<string, unknown> {
    return path.split('.').reduce<Record<string, unknown>>(
        (o, k) => (o?.[k] ?? {}) as Record<string, unknown>,
        messages,
    );
}

const CASES: Array<{ name: string; path: string; values: string[] }> = [
    { name: 'AuditPackItemEntityType', path: 'external.auditShare.entityType', values: Object.values(AuditPackItemEntityType) },
    { name: 'VendorLinkRelation', path: 'vendors.linkRelation', values: Object.values(VendorLinkRelation) },
];

describe.each(LOCALES)('%s', (locale) => {
    const messages = require(`../../../messages/${locale}.json`) as Record<string, unknown>;

    it.each(CASES)('labels every $name value at $path', ({ path, values }) => {
        const labels = at(messages, path);
        const missing = values.filter((v) => typeof labels[v] !== 'string' || labels[v] === '');
        expect(missing).toEqual([]);
    });
});
