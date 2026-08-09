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
        const helper = read('src/app-layer/automation/tenant-dek-read.ts');
        const source = helper.match(/AUTOMATION_DISPATCH_SOURCE\s*=\s*'([^']+)'/)?.[1];
        expect(source).toBeTruthy();

        const mw = read('src/lib/db/encryption-middleware.ts');
        const block = mw.slice(mw.indexOf('BYPASS_SOURCES'));
        const bypass = (block.slice(0, block.indexOf(']')).match(/'([a-z]+)'/g) ?? []).map((s) =>
            s.replace(/'/g, ''),
        );
        expect(bypass).toEqual(expect.arrayContaining(['seed', 'job', 'system']));
        expect(bypass).not.toContain(source);
    });

    it('the wrapper passes a tenantId, not just any audit context', () => {
        // An audit context with no tenantId hits the same `!tenantId ->
        // NO_DEK_PAIR` branch and fixes nothing.
        const helper = read('src/app-layer/automation/tenant-dek-read.ts');
        expect(helper).toMatch(/runWithAuditContext\(\s*\{\s*tenantId\s*,/);
    });
});
