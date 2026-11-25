/**
 * `local/no-person-identity-in-audit-payload` — RuleTester (#5950).
 *
 * The `valid` cases are the load-bearing half: each narrowing the rule makes
 * has one here that goes red if the narrowing breaks. A bare `.name` is a
 * control's or a vendor's name, not a person's; a digest of an address is not
 * the address; a field outside the stored payload is not the row; the
 * person's id is exactly what the row should carry.
 *
 * Parsed with `@typescript-eslint/parser`, because the writers it reads are
 * TypeScript (`as`, `!`, `?.`), and a default-parser suite would prove the rule
 * on syntax it never meets.
 */
import { RuleTester } from 'eslint';
import * as tsParser from '@typescript-eslint/parser';

// CommonJS on purpose — see eslint-rules/index.js for why `.mjs` and `.cjs`
// both fail in this repo.
const rule = require('../rules/no-person-identity-in-audit-payload');

const ruleTester = new RuleTester({
    languageOptions: { parser: tsParser, ecmaVersion: 2022, sourceType: 'module' },
});

const err = { messageId: 'personIdentity' };

describe('local/no-person-identity-in-audit-payload', () => {
    ruleTester.run('no-person-identity-in-audit-payload', rule, {
        valid: [
            {
                name: 'the person by id: targetUserId in detailsJson, a sentence with no address',
                code: `logEvent(db, ctx, { action: 'MEMBER_REMOVED', entityType: 'TenantMembership', entityId: m.id, details: 'Removed member', detailsJson: { category: 'entity_lifecycle', targetUserId: m.userId } });`,
            },
            {
                name: 'a bare `.name` is an entity, not a person: a control, a vendor, a campaign',
                code: `logEvent(db, ctx, { action: 'CONTROL_CREATED', entityType: 'Control', entityId: c.id, details: \`Created control: \${control.name}\`, detailsJson: { summary: \`Closed review "\${review.name}"\`, after: { name: vendor.name } } });`,
            },
            {
                name: 'a digest of an address is not the address',
                code: `appendAuditEntry({ tenantId, userId, entity: 'Auth', entityId: userId, action: a, detailsJson: { category: 'custom', auth: { identifierHash: hashEmailForLog(params.email) } } });`,
            },
            {
                name: 'members of the call that are not stored in the row are not read',
                code: `appendAuditEntry({ tenantId, userId: user.id, entity: 'Tenant', entityId: t.id, action: 'TENANT_CREATED', detailsJson: { ownerUserId: user.id } }, clientFor(user.email));`,
            },
            {
                name: 'a call that is not an audit writer is not read',
                code: `sendMail({ details: \`Hello \${user.name}\`, to: user.email });`,
            },
            {
                name: 'a `let` is not followed: only a `const` has one value to read',
                code: `let summary = \`x \${user.email}\`; summary = 'Removed'; logEvent(db, ctx, { action: 'A', entityType: 'E', entityId: 'e', details: summary });`,
            },
            {
                name: 'a key that names a domain or a group, not a person',
                code: `logEvent(db, ctx, { action: 'UPDATE', entityType: 'P', entityId: 'p', detailsJson: { after: { emailDomains: d, aadGroupName: g, entityName: 'X', toolName: t } } });`,
            },
            {
                name: 'a const read for one member is not followed: `auditor.id` is an id, whatever built `auditor`',
                code: `const auditor = flag ? await db.auditorAccount.update({ data: { name } }) : await db.auditorAccount.upsert({ create: { email, name } }); logEvent(db, ctx, { action: 'AUDITOR_INVITED', entityType: 'AuditorAccount', entityId: auditor.id, detailsJson: { targetUserId: auditor.id } });`,
            },
            {
                name: 'a computed read of a const object is one unknown member, not the object',
                code: `const after = { enabled: row.enabled, defaultFromEmail: row.defaultFromEmail }; logEvent(db, ctx, { action: 'X', entityType: 'S', entityId: 't', detailsJson: { after: Object.fromEntries(changed.map((f) => [f, after[f]])) } });`,
            },
            {
                name: 'a wrapper argument that is not the configured payload is not read',
                code: `emitScimAudit(lookup(user.email), 'SCIM_USER_CREATED', userId, { role });`,
                options: [{ payloadArgs: { emitScimAudit: 3 } }],
            },
        ],
        invalid: [
            {
                name: 'the #5950 shape: a member e-mail interpolated into details',
                code: `logEvent(db, ctx, { action: 'MEMBER_REMOVED', entityType: 'TenantMembership', entityId: m.id, details: \`Removed member: \${membership.user.email}\` });`,
                errors: [err],
            },
            {
                name: 'an e-mail in detailsJson.summary (ACCESS_REVIEW_DECISION_EXECUTED)',
                code: `logEvent(db, ctx, { action: 'ACCESS_REVIEW_DECISION_EXECUTED', entityType: 'AccessReviewDecision', entityId: d.id, detailsJson: { summary: \`Closeout executed on subject \${d.subjectUser.email}\`, targetUserId: d.subjectUserId } });`,
                errors: [err],
            },
            {
                name: 'an e-mail KEY in detailsJson, shorthand',
                code: `appendOrgAuditEntry({ organizationId, actorUserId, action: a, detailsJson: { inviteId: invite.id, email } });`,
                errors: [err],
            },
            {
                name: 'a camelCase …Email key with any value',
                code: `appendAuditEntry({ tenantId, userId, entity: 'Tenant', entityId: t, action: 'TENANT_CREATED', detailsJson: { ownerUserId: user.id, ownerEmail: input.address } });`,
                errors: [err],
            },
            {
                name: "a person's name through a person-shaped object",
                code: `logEvent(db, ctx, { action: 'X', entityType: 'E', entityId: 'e', details: \`for \${membership.user.name}\` });`,
                errors: [err],
            },
            {
                name: 'a name field of an employee record',
                code: `logEvent(db, ctx, { action: 'CREATE', entityType: 'Employee', entityId: e.id, detailsJson: { summary: \`Created employee: \${employee.fullName}\` } });`,
                errors: [err],
            },
            {
                name: 'followed one step to a const template',
                code: `const summary = \`HRIS role change for \${m.prior.fullName}\`; logEvent(db, ctx, { action: 'UPDATE', entityType: 'Employee', entityId: m.prior.id, details: summary, detailsJson: { summary } });`,
                errors: [err],
            },
            {
                name: 'followed one step to a const object whose WHOLE value is stored',
                code: `const who = { email: user.email, role }; logEvent(db, ctx, { action: 'X', entityType: 'E', entityId: 'e', details: JSON.stringify(who) });`,
                errors: [err, err],
            },
            {
                name: 'an address inside JSON.stringify in details',
                code: `logEvent(db, ctx, { action: 'AUDITOR_INVITED', entityType: 'AuditorAccount', entityId: a.id, details: JSON.stringify({ email, reactivated }) });`,
                errors: [err],
            },
            {
                name: 'a detailsJson property anywhere, so a wrapper taking { detailsJson } is covered',
                code: `emitOrgAudit(ctx, { action: a, targetUserId: u.id, detailsJson: { email: u.email } });`,
                errors: [err, err],
            },
            {
                name: 'the configured positional payload of a wrapper',
                code: `emitScimAudit(ctx.tenantId, 'SCIM_USER_CREATED', userId, { email, role, displayName });`,
                options: [{ payloadArgs: { emitScimAudit: 3 } }],
                errors: [err, err],
            },
            {
                name: 'metadata is stored in the row too (logEvent appends it to details)',
                code: `logEvent(db, ctx, { action: 'X', entityType: 'E', entityId: 'e', metadata: { respondentEmail } });`,
                errors: [err],
            },
            {
                name: 'TypeScript syntax around the read: `!` and `?.`',
                code: `logEvent(db, ctx, { action: 'X', entityType: 'E', entityId: 'e', details: \`to \${assessment!.respondentEmail} and \${owner?.name}\` });`,
                errors: [err, err],
            },
        ],
    });
});
