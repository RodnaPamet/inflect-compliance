/**
 * Audit Coherence S10 (2026-05-24) — structural ratchet locking
 * the entity-specific restore validator infrastructure.
 *
 * The audit recommended:
 *   - Gap 1 — entity-specific restore validation: SHIP. Locked here.
 *   - Gap 2 — field-level RBAC: DEFER (no concrete pull yet).
 *   - Gap 3 — ABAC: DEFER (matches audit guidance).
 *
 * The deferral rationale lives in
 * `docs/implementation-notes/2026-05-24-audit-s10-tenant-isolation.md`.
 * This ratchet asserts only the SHIP scope.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mdSection } from '../helpers/markdown-regions';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const readRaw = (rel: string) =>
    fs.readFileSync(path.join(ROOT, rel), 'utf8');
const read = (rel: string) => codeOf(readRaw(rel));

describe('Audit S10 — Tenant Isolation & Authorization', () => {
    describe('Gap 1 — entity-specific restore validators', () => {
        const validators = read('src/app-layer/domain/restore-validators.ts');
        const usecase = read('src/app-layer/usecases/soft-delete-operations.ts');

        it('declares the RestorableModel union with every soft-deletable model', () => {
            // Same set as the legacy SoftDeletableModel union — keep
            // both in sync. Drift would mean the registry doesn't
            // cover a model that restoreEntity allows.
            const expected = [
                'Asset',
                'Risk',
                'Control',
                'Evidence',
                'Policy',
                'Vendor',
                'FileRecord',
                'Task',
                'Finding',
                'Audit',
                'AuditCycle',
                'AuditPack',
            ];
            for (const m of expected) {
                expect(validators).toMatch(
                    new RegExp(`\\|\\s*['"]${m}['"]`),
                );
            }
        });

        it('declares the RestoreValidator signature with ctx + db + record', () => {
            expect(validators).toMatch(
                /export type RestoreValidator =\s*\(\s*ctx:\s*RequestContext,\s*db:\s*PrismaTx,\s*record:\s*unknown,?\s*\)\s*=>\s*Promise<void>/,
            );
        });

        it('RESTORE_VALIDATORS is a total Record<RestorableModel, …>', () => {
            // Total — Record, not Partial. A new model must explicitly
            // declare its validator (NOOP_VALIDATOR is the documented
            // choice for "no preconditions").
            expect(validators).toMatch(
                /export const RESTORE_VALIDATORS:\s*Record<RestorableModel,\s*RestoreValidator>/,
            );
        });

        it('Task / AuditPack / Evidence have concrete (non-noop) validators', () => {
            // The three named validators from the audit decision.
            // A reorganisation that demotes one back to NOOP must
            // bump the doc + this ratchet at the same time.
            expect(validators).toMatch(/Task:\s*TASK_VALIDATOR/);
            expect(validators).toMatch(/AuditPack:\s*AUDIT_PACK_VALIDATOR/);
            expect(validators).toMatch(/Evidence:\s*EVIDENCE_VALIDATOR/);
        });

        it('Task validator checks parent control deletedAt', () => {
            const fnStart = validators.indexOf('const TASK_VALIDATOR');
            const fnBody = validators.slice(fnStart, fnStart + 800);
            expect(fnBody).toMatch(/db\.control\.findFirst/);
            expect(fnBody).toMatch(/deletedAt:\s*null/);
        });

        it('AuditPack validator refuses COMPLETE + deleted parent cycles', () => {
            const fnStart = validators.indexOf('const AUDIT_PACK_VALIDATOR');
            const fnBody = validators.slice(fnStart, fnStart + 1200);
            expect(fnBody).toMatch(/db\.auditCycle\.findFirst/);
            // Both refusal paths must be wired. `COMPLETE` is the
            // terminal status on the AuditCycleStatus enum — the
            // equivalent of CLOSED on other lifecycles.
            expect(fnBody).toMatch(/cycle\.deletedAt/);
            expect(fnBody).toMatch(/cycle\.status\s*===\s*['"]COMPLETE['"]/);
        });

        it('Evidence validator checks active tenant membership', () => {
            const fnStart = validators.indexOf('const EVIDENCE_VALIDATOR');
            const fnBody = validators.slice(fnStart, fnStart + 800);
            expect(fnBody).toMatch(/db\.tenantMembership\.findFirst/);
            expect(fnBody).toMatch(/status:\s*['"]ACTIVE['"]/);
        });

        it('restoreEntity calls getRestoreValidator BEFORE the update', () => {
            const fnStart = usecase.indexOf('export async function restoreEntity');
            const fnBody = usecase.slice(fnStart, fnStart + 2000);
            // Order matters — the gate is between the existence check
            // and the row write. A refactor that moves the validator
            // call below `delegate.update` lets a precondition-violating
            // restore land and emits a bogus audit row before throwing.
            const gateIdx = fnBody.indexOf('await validator(');
            const updateIdx = fnBody.indexOf('delegate.update(');
            expect(gateIdx).toBeGreaterThan(0);
            expect(updateIdx).toBeGreaterThan(gateIdx);
        });
    });

    describe('Gap 2 & Gap 3 — decision docs land alongside the SHIP scope', () => {
        // Markdown: read RAW — codeOf() would mask `//` in prose/URLs, and
        // these assertions are deliberately about the note's prose.
        //
        // NARROWED, NOT MASKED (#2246). Masking is the wrong tool twice over
        // here: `mdCodeOf` keeps a document's code and blanks its prose, and
        // a deferral rationale is entirely prose. The reachable defect was
        // the whole-document read — the note opens with a `## Design` summary
        // that ALSO names "Gap 2" and "Gap 3", so a diff that gutted the
        // decision sections and left the summary intact kept every assertion
        // below green. Each decision is now bound to its own `### Decision —`
        // section, which is the thing the audit trail actually is.
        const note = readRaw(
            'docs/implementation-notes/2026-05-24-audit-s10-tenant-isolation.md',
        );
        const gap2 = mdSection(
            note,
            'Decision — Gap 2: field-level RBAC stays deferred',
        );
        const gap3 = mdSection(
            note,
            'Decision — Gap 3: ABAC deferred (matches audit guidance)',
        );

        it('field-level RBAC defer rationale is documented', () => {
            expect(gap2).toMatch(/field-level RBAC stays deferred/);
            // Anchor to the four reasons so the defer can't quietly
            // shrink to a one-line "no" later.
            expect(gap2).toMatch(/allowlist per field per role/);
            expect(gap2).toMatch(/Repository-layer projection/);
        });

        it('ABAC defer rationale is documented + matches audit guidance', () => {
            expect(gap3).toMatch(/ABAC deferred/);
            expect(gap3).toMatch(/policy engine \(OPA \/ Cedar\)/);
        });
    });
});
