/**
 * PR-D — executor hardening ratchet. Keeps the safety guards present so a
 * refactor can't silently drop them.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const EXEC = read('src/app-layer/automation/action-executor.ts');

describe('executor hardening', () => {
    it('UPDATE_STATUS enforces a transition allowlist', () => {
        expect(EXEC).toMatch(/STATUS_ALLOWLIST/);
        expect(EXEC).toMatch(/Illegal .* status/);
    });

    it('UPDATE_STATUS never writes a status column directly (B2-1b)', () => {
        // The allowlist above constrains WHICH column and value a rule may
        // write; it says nothing about the gates that decide whether the
        // write is legal at all. `db.task.updateMany({ status })` skipped the
        // transition gate, the four-eyes reviewer gate, the required
        // resolution, type relevance, the audit row and the source
        // reconciler — so the allowlist was green while a rule closed a
        // reviewer-gated task with nobody reviewing it. Whole-file rather
        // than a slice: the executor has no legitimate raw status write
        // anywhere, so any reappearance is the regression.
        expect(EXEC).not.toMatch(/db\.(task|risk|control)\.updateMany/);
        // The refusal must be legible on the execution row, not a silent
        // no-op (the #1874 pattern).
        expect(EXEC).toMatch(/refusedSummary/);
    });

    it('WEBHOOK routes the tenant URL through safeFetch (SSRF guard + DNS-rebinding re-check + IP-pin)', () => {
        // The guard is now centralised in webhook-safety.safeFetch, which runs
        // assertPublicAddress (https-only + private/metadata block + DNS re-check
        // of every resolved address + connection IP-pin) before connecting.
        expect(EXEC).toMatch(/safeFetch\(cfg\.url/);
        expect(EXEC).toMatch(/from '\.\/webhook-safety'/);
        // no bare fetch on the tenant-supplied URL
        expect(EXEC).not.toMatch(/await fetch\(cfg\.url/);
    });

    it('CREATE_TASK dedupes before creating', () => {
        expect(EXEC).toMatch(/dedupeKey/);
        expect(EXEC).toMatch(/task\.findFirst/);
    });

    it('NOTIFY_USER respects the tenant notification kill-switch', () => {
        expect(EXEC).toMatch(/isNotificationsEnabled/);
    });

    it('the UPDATE_STATUS allowlist is a single shared source (executor + builder)', () => {
        // PR-E — the builder's entity/status DROPDOWNS and the executor's
        // enforcement both read UPDATE_STATUS_TARGETS, so they can never drift.
        expect(EXEC).toMatch(/UPDATE_STATUS_TARGETS/);
        expect(EXEC).toMatch(/from '@\/lib\/automation\/status-allowlist'/);
        const modal = read('src/components/processes/RuleBuilderModal.tsx');
        expect(modal).toMatch(/UPDATE_STATUS_TARGETS/);
        // No free-text status Input for UPDATE_STATUS — it's a Combobox now.
        expect(modal).toMatch(/statusValueOptions/);
        expect(modal).toMatch(/entityTypeOptions/);
    });
});
