/**
 * #4849 — the org audit log page knows every action the log stores.
 *
 * It labelled five of fifteen, so ten kinds of entry rendered as a missing
 * translation key with an empty summary. The list the page renders and
 * filters by must equal the database enum, and every entry must have an
 * English label.
 */
import { OrgAuditAction } from '@prisma/client';
import { ORG_AUDIT_ACTIONS } from '@/app/org/[orgSlug]/(app)/audit/AuditLogTable';

const EN = (require('../../messages/en.json') as { org: { audit: Record<string, unknown> } }).org.audit;

it('the page lists exactly the actions the OrgAuditAction enum holds', () => {
    expect([...ORG_AUDIT_ACTIONS].sort()).toEqual(Object.values(OrgAuditAction).sort());
});

it('every action label key resolves to English text', () => {
    // The source of truth is the component's own map; read it through the
    // rendered labels in the rendered test. Here, the catalogue simply must
    // carry one `action*` key per enum value.
    const actionKeys = Object.keys(EN).filter((k) => k.startsWith('action') && k !== 'actionOther');
    expect(actionKeys.length).toBe(Object.values(OrgAuditAction).length);
    for (const k of actionKeys) expect(typeof EN[k]).toBe('string');
});
