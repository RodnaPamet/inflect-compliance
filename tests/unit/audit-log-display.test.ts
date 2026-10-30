/**
 * How the Audit log page shows a stored entry (#4468) —
 * `src/lib/audit/audit-log-display.ts`.
 *
 * The page printed the stored codes (`CUSTOM_ROLE_CREATED`, the Prisma model
 * name `TenantCustomRole`) and the raw `details` column, which ends in the
 * `Context: {"requestId":…}` JSON `logEvent` appends; an entry whose sentence
 * lives in `detailsJson.summary` (every integration create/update/disable)
 * showed only that JSON.
 */
import {
    auditEntityNounKey,
    auditLogDetailsText,
    readableAuditCode,
    withoutRequestContext,
} from '@/lib/audit/audit-log-display';

describe('readableAuditCode', () => {
    test.each([
        ['CUSTOM_ROLE_CREATED', 'Custom role created'],
        ['MEMBER_ROLE_CHANGED', 'Member role changed'],
        ['AUTHZ_DENIED', 'Authorization denied'],
        ['SSO_CONFIG_UPDATED', 'SSO config updated'],
        ['TenantCustomRole', 'Tenant custom role'],
        ['IntegrationConnection', 'Integration connection'],
        ['AiSystem', 'AI system'],
        ['SCIMToken', 'SCIM token'],
        ['Nis2Assessment', 'NIS2 assessment'],
        ['Risk', 'Risk'],
        ['RISK', 'Risk'],
        ['  padded_code ', 'Padded code'],
    ])('%j reads %j', (code, readable) => {
        expect(readableAuditCode(code)).toBe(readable);
    });

    test('a code with nothing to read comes back unchanged', () => {
        expect(readableAuditCode('___')).toBe('___');
        expect(readableAuditCode('')).toBe('');
    });
});

describe('auditEntityNounKey', () => {
    test('an entity the dashboard feed translates keeps that noun, whatever its casing', () => {
        expect(auditEntityNounKey('Risk')).toBe('risk');
        expect(auditEntityNounKey('CONTROL')).toBe('control');
    });

    test('the long tail has no noun', () => {
        expect(auditEntityNounKey('TenantCustomRole')).toBeNull();
    });
});

describe('withoutRequestContext', () => {
    const ref = 'Context: {"requestId":"req-1"}';

    test('drops the reference logEvent appends after a sentence', () => {
        expect(withoutRequestContext(`Created risk "R"\n\n${ref}`)).toBe('Created risk "R"');
    });

    test('a reference with no sentence leaves nothing', () => {
        expect(withoutRequestContext(ref)).toBe('');
    });

    test('keeps a sentence that only mentions the word', () => {
        expect(withoutRequestContext('Context: changed the control owner')).toBe('Context: changed the control owner');
        expect(withoutRequestContext('See Context: {"a":1}')).toBe('See Context: {"a":1}');
    });

    test('keeps text whose trailing braces are not a JSON object', () => {
        expect(withoutRequestContext('Note\n\nContext: {not json}')).toBe('Note\n\nContext: {not json}');
        expect(withoutRequestContext('Note\n\nContext: {"a":1} trailing')).toBe('Note\n\nContext: {"a":1} trailing');
    });

    test("drops only the appended reference when the writer's own text carries one too", () => {
        const own = 'Imported\n\nContext: {"source":"csv"}';
        expect(withoutRequestContext(`${own}\n\n${ref}`)).toBe(own);
    });
});

describe('auditLogDetailsText', () => {
    test("the writer's sentence, without the reference", () => {
        expect(auditLogDetailsText('Finding updated\n\nContext: {"requestId":"r"}', { summary: 'other' })).toBe(
            'Finding updated',
        );
    });

    test('an entry with only the reference shows its detailsJson.summary', () => {
        expect(
            auditLogDetailsText('Context: {"requestId":"r"}', { category: 'entity_lifecycle', summary: 'Updated integration: Jira' }),
        ).toBe('Updated integration: Jira');
    });

    test('neither a sentence nor a summary is nothing, never the JSON', () => {
        expect(auditLogDetailsText('Context: {"requestId":"r"}', { category: 'entity_lifecycle' })).toBeNull();
        expect(auditLogDetailsText(null, null)).toBeNull();
        expect(auditLogDetailsText('Context: {"requestId":"r"}', { summary: '   ' })).toBeNull();
        expect(auditLogDetailsText(null, ['summary'])).toBeNull();
        expect(auditLogDetailsText(null, { summary: 42 })).toBeNull();
    });
});
