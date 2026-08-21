/**
 * Every path that hands an `AutomationRule` to `executeAction` must have
 * read that rule with the tenant DEK resolvable.
 *
 * `executeAction` signs the outbound webhook with
 * `rule.webhookSecretEncrypted` as the HMAC key. That column is a `v2:`
 * ciphertext under the tenant's DEK, and the encryption middleware resolves
 * the DEK from `getAuditContext()` — which `runJob` does NOT populate (it
 * sets a request context, a different store). Read the rule outside a tenant
 * audit context and the middleware's fail-open catch hands back the raw
 * ciphertext, which then becomes the signing key.
 *
 * The behavioural proof lives in
 * `tests/integration/automation-dispatch-tenant-dek.test.ts`. This guard
 * exists because that test can only cover the call sites that exist today —
 * a FOURTH dispatcher added later would reintroduce the bug with every
 * existing test still green.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KEK_BYPASS_SOURCES, isKekBypassSource } from '@/lib/db/kek-bypass-sources';
import { AUTOMATION_DISPATCH_SOURCE } from '@/app-layer/automation/tenant-dek-read';

const root = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const DISPATCHERS = [
    'src/app-layer/jobs/automation-event-dispatch.ts',
    'src/app-layer/jobs/rule-chain-dispatch.ts',
    'src/app-layer/jobs/subflow-dispatcher.ts',
];

describe('automation dispatch — tenant DEK on the rule read', () => {
    it.each(DISPATCHERS)('%s reads AutomationRule through the wrapper', (file) => {
        const src = read(file);
        expect(src).toContain('readRulesWithTenantDek');
        // Every automationRule read in the file must be inside the wrapper.
        // Checked by requiring the wrapper call to precede each read, which
        // the single-read-per-file shape below makes exact.
        const reads = src.match(/prisma\.automationRule\.(findMany|findFirst|findUnique)\(/g) ?? [];
        expect(reads.length).toBeGreaterThan(0);
        const wrapped = src.match(/readRulesWithTenantDek\([\s\S]{0,200}?prisma\.automationRule\.(findMany|findFirst|findUnique)\(/g) ?? [];
        expect(wrapped.length).toBe(reads.length);
    });

    it('every executeAction caller is one of the guarded dispatchers', () => {
        // A new caller that reads its rule some other way is the regression
        // this catches. Add it to DISPATCHERS *and* route it through the
        // wrapper — not one or the other.
        const { execSync } = require('node:child_process') as typeof import('node:child_process');
        const out = execSync(
            `grep -rln "executeAction(" ${root}/src --include=*.ts || true`,
            { encoding: 'utf8' },
        )
            .split('\n')
            .filter(Boolean)
            .map((p) => p.replace(`${root}/`, ''))
            .filter((p) => !p.endsWith('automation/action-executor.ts'));
        expect(out.sort()).toEqual([...DISPATCHERS].sort());
    });

    it('the dispatch source is NOT one of the encryption BYPASS_SOURCES', () => {
        // The trap. These are jobs, so `source: 'job'` reads as the obvious
        // label — and it resolves to NO_DEK_PAIR, silently restoring the
        // ciphertext-as-signing-key bug with no test failing.
        //
        // This used to slice the literal out of `encryption-middleware.ts`
        // with a regex, which meant it asserted where the list was WRITTEN
        // rather than what the middleware reads. #152 moved the list into a
        // leaf module so three call sites could share one copy, and the regex
        // went green-to-red on a refactor that changed no behaviour — the
        // failure mode the repo's guard-naming rule warns about. Importing the
        // real value costs nothing here (the module has no imports of its own,
        // so this guard stays DB-free) and now tracks the value in use.
        expect(isKekBypassSource(AUTOMATION_DISPATCH_SOURCE)).toBe(false);
        expect([...KEK_BYPASS_SOURCES].sort()).toEqual(['job', 'seed', 'system']);
    });

    it('the wrapper passes a tenantId, not just any audit context', () => {
        // An audit context with no tenantId hits the same `!tenantId ->
        // NO_DEK_PAIR` branch and fixes nothing.
        const helper = read('src/app-layer/automation/tenant-dek-read.ts');
        expect(helper).toMatch(/runWithAuditContext\(\s*\{\s*tenantId\s*,/);
    });
});
