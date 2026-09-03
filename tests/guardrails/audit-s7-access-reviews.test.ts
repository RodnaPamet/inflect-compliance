/**
 * Audit Coherence S7 (2026-05-24) — structural ratchet locking the
 * two access-review gap closures.
 *
 * Gap A — `revokeDecision` usecase: reviewers can reset a submitted
 *   decision back to pending before campaign close. Pre-S7 the only
 *   path was an admin + DB intervention.
 *
 * Gap B — overdue escalation cron + email type: tenant ADMIN/OWNERs
 *   get notified when a campaign is more than ESCALATION_DAYS past
 *   `dueAt`. The reviewer reminder (G-4) was the only nudge before
 *   S7; severely overdue campaigns went silent to admins.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) =>
    codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

describe('Audit S7 — Access Review Campaigns', () => {
    describe('schema', () => {
        const enums = read('prisma/schema/enums.prisma');

        it('EmailNotificationType carries ACCESS_REVIEW_OVERDUE_ESCALATION', () => {
            expect(enums).toMatch(
                /enum EmailNotificationType\s*\{[\s\S]*?\bACCESS_REVIEW_OVERDUE_ESCALATION\b[\s\S]*?\}/,
            );
        });

        it('migration SQL exists for the audit S7 changes', () => {
            const migDir = path.join(
                ROOT,
                'prisma/migrations/20260524150000_audit_s7_access_review_escalation',
            );
            expect(fs.existsSync(migDir)).toBe(true);
            const sql = codeOf(fs.readFileSync(
                path.join(migDir, 'migration.sql'),
                'utf8',
            ));
            expect(sql).toMatch(
                /ADD VALUE IF NOT EXISTS 'ACCESS_REVIEW_OVERDUE_ESCALATION'/,
            );
        });
    });

    describe('revokeDecision usecase', () => {
        const src = read('src/app-layer/usecases/access-review.ts');
        const schema = read(
            'src/app-layer/schemas/access-review.schemas.ts',
        );
        const repo = read(
            'src/app-layer/repositories/AccessReviewRepository.ts',
        );

        it('declares RevokeDecisionSchema with a required reason', () => {
            expect(schema).toMatch(/export const RevokeDecisionSchema/);
            expect(schema).toMatch(
                /reason:\s*z\.string\(\)\.min\(3\)/,
            );
        });

        it('exports `revokeDecision` from the usecase', () => {
            expect(src).toMatch(/export async function revokeDecision/);
        });

        it('rejects when the campaign is CLOSED', () => {
            expect(src).toMatch(/decisions are immutable/);
        });

        it('rejects when the decision was never submitted', () => {
            expect(src).toMatch(
                /This decision has not been recorded; nothing to revoke/,
            );
        });

        it('rejects when the decision was executed at closeout', () => {
            expect(src).toMatch(
                /This decision has been executed and cannot be revoked/,
            );
        });

        it('writes the ACCESS_REVIEW_DECISION_REVOKED audit row', () => {
            expect(src).toMatch(/ACCESS_REVIEW_DECISION_REVOKED/);
            expect(src).toMatch(/category:\s*['"]access['"]/);
        });

        it('repository.resetDecision gates on executedAt: null', () => {
            expect(repo).toMatch(/static async resetDecision/);
            expect(repo).toMatch(/executedAt:\s*null/);
        });

        it('repository.resetDecision nulls every verdict field', () => {
            // Spell the field names so a future "partial reset" PR
            // can't drop one silently.
            expect(repo).toMatch(/decision:\s*null/);
            expect(repo).toMatch(/decidedAt:\s*null/);
            expect(repo).toMatch(/decidedByUserId:\s*null/);
            expect(repo).toMatch(/notes:\s*null/);
            expect(repo).toMatch(/modifiedToRole:\s*null/);
            expect(repo).toMatch(/modifiedToCustomRoleId:\s*null/);
        });
    });

    describe('overdue escalation cron', () => {
        const src = read(
            'src/app-layer/jobs/access-review-overdue-escalation.ts',
        );
        const schedules = read('src/app-layer/jobs/schedules.ts');
        const registry = read('src/app-layer/jobs/executor-registry.ts');
        const types = read('src/app-layer/jobs/types.ts');

        it('exports `processAccessReviewOverdueEscalation`', () => {
            expect(src).toMatch(
                /export async function processAccessReviewOverdueEscalation/,
            );
        });

        it('declares ESCALATION_DAYS default', () => {
            expect(src).toMatch(/export const ESCALATION_DAYS\s*=\s*\d+/);
        });

        it('fans out to tenant ADMIN/OWNER memberships', () => {
            expect(src).toMatch(
                /tenantMembership\.findMany[\s\S]{0,200}role:\s*\{\s*in:\s*\[\s*['"]OWNER['"]\s*,\s*['"]ADMIN['"]\s*\]/,
            );
            expect(src).toMatch(/status:\s*['"]ACTIVE['"]/);
        });

        it('queries OPEN/IN_REVIEW campaigns past the cutoff', () => {
            expect(src).toMatch(/status:\s*\{\s*in:\s*\[['"]OPEN['"],\s*['"]IN_REVIEW['"]/);
            expect(src).toMatch(/dueAt:\s*\{[\s\S]{0,80}lt:\s*cutoff/);
            expect(src).toMatch(/deletedAt:\s*null/);
        });

        it('routes through enqueueEmail with the escalation type', () => {
            expect(src).toMatch(/enqueueEmail\(/);
            expect(src).toMatch(/type:\s*['"]ACCESS_REVIEW_OVERDUE_ESCALATION['"]/);
        });

        it('respects tenantId scoping (single-tenant + sweep-all)', () => {
            expect(src).toMatch(/tenantId\?:\s*string/);
            // The destructure-from-options + spread-when-truthy pattern.
            expect(src).toMatch(/const \{ tenantId \} = options/);
            expect(src).toMatch(/\.\.\.\(tenantId \? \{ tenantId \} : \{\}\)/);
        });

        it('bulk-loads admins via a hoisted findMany — no per-candidate query', () => {
            // The candidate loop must be pure in-memory; admin
            // lookup is one `findMany({ tenantId: { in: [...] } })`
            // hoisted ABOVE the loop. Keeps the D1 N+1 guardrail
            // satisfied on multi-tenant sweeps.
            expect(src).toMatch(/async function loadAdmins/);
            expect(src).toMatch(/tenantId:\s*\{\s*in:\s*tenantIds\s*\}/);
            // The per-candidate loop reads from the Map, not the DB.
            expect(src).toMatch(/adminMap\.get\(c\.tenantId\)/);
        });

        it('schedule registered with a 04:15 UTC cron pattern', () => {
            expect(schedules).toMatch(
                /name:\s*['"]access-review-overdue-escalation['"]/,
            );
            expect(schedules).toMatch(/'15 4 \* \* \*'/);
        });

        it('executor registered + JobName union extended', () => {
            expect(registry).toMatch(
                /executorRegistry\.register\(['"]access-review-overdue-escalation['"]/,
            );
            expect(types).toMatch(
                /'access-review-overdue-escalation':\s*AccessReviewOverdueEscalationPayload/,
            );
        });
    });
});
