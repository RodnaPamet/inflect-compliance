/**
 * The from-address a tenant with no notification settings row sends AS.
 *
 * WHAT BROKE. `processOutbox` sets `from` from the per-tenant
 * `defaultFromEmail` (processOutbox.ts). The fallback for a tenant with no row
 * was the literal `noreply@inflect.app` — deliverable only from a deployment
 * whose relay has verified that domain. Production's relay had not, so it
 * answered `550 The inflect.app domain is not verified` to every message: 520
 * failures across digests, policy-approval requests and identity-leaver alerts,
 * with the last successful send on 2026-06-03 and no alert on the rate.
 *
 * `SMTP_FROM` held the correct verified sender the entire time. It was simply
 * not on this path — which is the actual defect: two sender defaults, and the
 * one that reached the relay was the hardcoded one.
 *
 * WHY THIS TEST IS SHAPED THIS WAY. Asserting the literal `inflect.bg` would
 * pin one deployment's domain into the suite and fail on the next. What must
 * hold is the RELATION — the fallback is whatever the deployment configured —
 * so that is what is asserted, plus the negative that a configured deployment
 * never emits the hardcoded product domain.
 */
import { getTenantNotificationSettings } from '@/app-layer/notifications/settings';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { deploymentSenderAddress, UNCONFIGURED_SENDER } from '@/lib/email/sender-identity';
import { repoRelativeFiles, REPO_ROOT } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';

type SettingsDb = Parameters<typeof getTenantNotificationSettings>[0];

/** A db whose settings table holds nothing — the state of all 7 prod tenants. */
function dbWithNoRow(): SettingsDb {
    return {
        tenantNotificationSettings: {
            findUnique: async () => null,
        },
    } as unknown as SettingsDb;
}

describe('notification sender fallback', () => {
    const original = process.env.SMTP_FROM;
    afterEach(() => {
        if (original === undefined) delete process.env.SMTP_FROM;
        else process.env.SMTP_FROM = original;
    });

    it('inherits the deployment sender when the tenant has no settings row', async () => {
        process.env.SMTP_FROM = 'noreply@example-verified.test';
        const s = await getTenantNotificationSettings(dbWithNoRow(), 't1');
        expect(s.defaultFromEmail).toBe('noreply@example-verified.test');
    });

    it('never emits the hardcoded product domain on a configured deployment', async () => {
        process.env.SMTP_FROM = 'noreply@example-verified.test';
        const s = await getTenantNotificationSettings(dbWithNoRow(), 't1');
        // The 550 that produced 520 silent failures.
        expect(s.defaultFromEmail).not.toContain('inflect.app');
    });

    it('is read per call, so it survives a mailer initialised after import', async () => {
        // The worker imports this module before initMailerFromEnv runs. Pinning
        // the value at module load would reintroduce the order dependency.
        delete process.env.SMTP_FROM;
        const before = await getTenantNotificationSettings(dbWithNoRow(), 't1');
        process.env.SMTP_FROM = 'later@example-verified.test';
        const after = await getTenantNotificationSettings(dbWithNoRow(), 't1');

        expect(before.defaultFromEmail).not.toBe(after.defaultFromEmail);
        expect(after.defaultFromEmail).toBe('later@example-verified.test');
    });

    it('still yields a syntactically sendable address when nothing is configured', async () => {
        delete process.env.SMTP_FROM;
        const s = await getTenantNotificationSettings(dbWithNoRow(), 't1');
        expect(s.defaultFromEmail).toMatch(/^[^@\s]+@[^@\s]+$/);
    });

    it('a tenant row still wins over the deployment default', async () => {
        process.env.SMTP_FROM = 'deployment@example-verified.test';
        const db = {
            tenantNotificationSettings: {
                findUnique: async () => ({
                    enabled: true,
                    defaultFromName: 'Acme',
                    defaultFromEmail: 'compliance@acme.test',
                    complianceMailbox: null,
                }),
            },
        } as unknown as SettingsDb;

        const s = await getTenantNotificationSettings(db, 't1');
        expect(s.defaultFromEmail).toBe('compliance@acme.test');
    });
});

describe('deploymentSenderAddress (the single owner)', () => {
    const original = process.env.SMTP_FROM;
    afterEach(() => {
        if (original === undefined) delete process.env.SMTP_FROM;
        else process.env.SMTP_FROM = original;
    });

    it('is the configured sender', () => {
        process.env.SMTP_FROM = 'ops@example-verified.test';
        expect(deploymentSenderAddress()).toBe('ops@example-verified.test');
    });

    it('falls back to the placeholder only when nothing is configured', () => {
        delete process.env.SMTP_FROM;
        expect(deploymentSenderAddress()).toBe(UNCONFIGURED_SENDER);
    });

    it('is the ONLY hardcoded sender in src/ code', () => {
        // The defect was two copies of this literal that could disagree. If a
        // third appears, this fails rather than waiting for a relay to reject it.
        //
        // Population comes from `repoRelativeFiles()` (git ls-files --cached
        // --others), NOT `git grep`: git grep skips UNTRACKED files, so the
        // first draft of this test could not see the very module it names.
        //
        // `codeOf` strips comments — every file here discusses the literal in
        // prose, and a docstring naming the address is not a second place that
        // decides it.
        // `.tsx` is in scope deliberately. Scanning only `.ts` would let this
        // assertion keep its name while missing half of `src/` — the reach
        // would not be the thing it claims. It costs one exclusion below.
        const offenders = repoRelativeFiles()
            .filter((f) => f.startsWith('src/') && /\.tsx?$/.test(f))
            // env.ts declares the same literal as the zod default for SMTP_FROM,
            // which is the schema's business, not a second sender decision.
            .filter((f) => f !== 'src/env.ts')
            // The notification-settings page shows the literal as an input
            // `placeholder` — greyed-out example text for an operator typing
            // their own sender. It is rendered, never read: nothing resolves a
            // from-address through it, so it cannot disagree with the module.
            .filter((f) => f !== 'src/app/t/[tenantSlug]/(app)/admin/notifications/page.tsx')
            .filter((f) => codeOf(readFileSync(join(REPO_ROOT, f), 'utf8')).includes(UNCONFIGURED_SENDER));

        expect(offenders).toEqual(['src/lib/email/sender-identity.ts']);
    });
});
