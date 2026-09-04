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
import { getTenantNotificationSettings, updateTenantNotificationSettings } from '@/app-layer/notifications/settings';
import { UpdateNotificationSettingsSchema } from '@/app-layer/schemas/notification-settings.schemas';
import { makeRequestContext } from '../helpers/make-context';
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

/**
 * Does this file WRITE the placeholder sender, as opposed to discussing it?
 *
 * Comments are masked for `.ts`/`.tsx` ONLY. Many files legitimately name the
 * address in prose, and a docstring is not a second place that decides it.
 *
 * The masking is deliberately NOT applied to other extensions. `codeOf` treats
 * `//` as the start of a line comment, so over Markdown it deletes everything
 * after the `//` in any URL — on a link-dense table like the one in
 * docs/auth.md that hides the very copy this scan exists to catch. Over
 * `.prisma`, `.env` and `.sql` the raw text is what decides behaviour anyway.
 */
const senderScanCache = new Map<string, boolean>();
function writesPlaceholderSender(file: string): boolean {
    const cached = senderScanCache.get(file);
    if (cached !== undefined) return cached;
    const raw = readFileSync(join(REPO_ROOT, file), 'utf8');
    const text = /\.tsx?$/.test(file) ? codeOf(raw) : raw;
    const hit = text.includes(UNCONFIGURED_SENDER);
    senderScanCache.set(file, hit);
    return hit;
}

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

    it('is the ONLY place the repo writes the placeholder sender', () => {
        // PR #2286 gave this address one owner and asserted it appeared once —
        // but only within `src/**/*.ts(x)`. Three copies survived that scan and
        // #2296 found them: a DATABASE COLUMN DEFAULT on the very column that
        // caused the outage (prisma/schema/automation.prisma), the deployment
        // template every self-hoster copies (deploy/.env.prod.example), and the
        // worked example in docs/auth.md. A scan that cannot reach a file is
        // not evidence about that file, so the population is now every tracked
        // file.
        //
        // Population is git-backed via `repoRelativeFiles()`
        // (`git ls-files --cached --others --exclude-standard`), never an fs
        // walk with a hand-maintained skip list — see
        // tests/guardrails/source-scan-population.test.ts.
        const scanned = repoRelativeFiles().filter(
            // Applied migrations are immutable: their checksums are recorded in
            // `_prisma_migrations`, so editing one breaks `migrate deploy` on
            // every existing deployment. 20260317164308 created the column WITH
            // the bad default and 20260904060000 removes it; both necessarily
            // name it, and neither can ever be rewritten.
            (f) => !f.startsWith('prisma/migrations/'),
        );

        const offenders = scanned
            // The notification-settings page shows the address as an input
            // `placeholder` — greyed-out example text for an operator typing
            // their own sender. It is rendered, never read: nothing resolves a
            // from-address through it, so it cannot disagree with the module.
            .filter((f) => f !== 'src/app/t/[tenantSlug]/(app)/admin/notifications/page.tsx')
            .filter((f) => writesPlaceholderSender(f));

        expect(offenders).toEqual(['src/lib/email/sender-identity.ts']);
    });

    it('scans the file types that previously hid a copy', () => {
        // The denominator is part of the result. The assertion above passes
        // vacuously if the population stops reaching the extensions where the
        // three #2296 copies lived, and a scan that silently drops what it
        // cannot see reports full coverage of the subset it understands.
        const scanned = repoRelativeFiles().filter((f) => !f.startsWith('prisma/migrations/'));

        expect(scanned).toContain('prisma/schema/automation.prisma');
        expect(scanned).toContain('deploy/.env.prod.example');
        expect(scanned).toContain('docs/auth.md');
        expect(scanned.length).toBeGreaterThan(4000);
    });
});

/**
 * The path by which the retired address survived PR #2286 (#2296).
 *
 * #2286 removed the literal from `settings.ts` and gave it one owner. What it
 * did not remove was the DATABASE column default on `defaultFromEmail`, and
 * there was a live route into it: the settings PUT had no schema and built its
 * payload unconditionally, so omitting the field passed the key with an
 * undefined VALUE. `{ ...defaults(), ...data }` spreads data last, so undefined
 * overwrote the resolved sender; Prisma drops undefined arguments, so the
 * column left the INSERT and the database decided it.
 *
 * Two independent things now stop that, and each is asserted separately: the
 * route validates its body, and the usecase prunes undefined for every other
 * caller.
 */
describe('a partial update cannot un-resolve the sender', () => {
    const original = process.env.SMTP_FROM;
    afterEach(() => {
        if (original === undefined) delete process.env.SMTP_FROM;
        else process.env.SMTP_FROM = original;
    });

    function dbCapturingUpsert() {
        const calls: { create: Record<string, unknown>; update: Record<string, unknown> }[] = [];
        const db = {
            tenantNotificationSettings: {
                upsert: async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
                    calls.push(args);
                    return {
                        enabled: true,
                        defaultFromName: 'Inflect Compliance',
                        defaultFromEmail: 'stored@example-verified.test',
                        complianceMailbox: null,
                    };
                },
            },
        } as unknown as Parameters<typeof updateTenantNotificationSettings>[0];
        return { db, calls };
    }

    it('keeps the resolved sender when the caller passes the key as undefined', async () => {
        process.env.SMTP_FROM = 'ops@example-verified.test';
        const { db, calls } = dbCapturingUpsert();

        await updateTenantNotificationSettings(db, makeRequestContext('ADMIN'), {
            // Exactly the shape the unvalidated route produced: PRESENT key,
            // undefined value. Before the fix this reached Prisma, which
            // dropped it, and the column default supplied the retired address.
            enabled: false,
            defaultFromEmail: undefined,
        });

        expect(calls[0].create.defaultFromEmail).toBe('ops@example-verified.test');
        expect(calls[0].create.defaultFromEmail).not.toBe(UNCONFIGURED_SENDER);
    });

    it('does not send an undefined-valued key to Prisma at all', async () => {
        process.env.SMTP_FROM = 'ops@example-verified.test';
        const { db, calls } = dbCapturingUpsert();

        await updateTenantNotificationSettings(db, makeRequestContext('ADMIN'), {
            enabled: false,
            defaultFromEmail: undefined,
            complianceMailbox: undefined,
        });

        // `update` has no defaults() underneath it, so an undefined key here is
        // load-bearing in the other direction: it must not reach Prisma and be
        // silently ignored, because that hides a caller bug rather than fixing it.
        expect(Object.hasOwn(calls[0].update, 'defaultFromEmail')).toBe(false);
        expect(Object.hasOwn(calls[0].update, 'complianceMailbox')).toBe(false);
        expect(calls[0].update).toEqual({ enabled: false });
    });
});

describe('the settings PUT body schema', () => {
    it('omits an absent optional key instead of setting it to undefined', () => {
        const parsed = UpdateNotificationSettingsSchema.parse({ enabled: false });

        // This is the property the spread in `updateTenantNotificationSettings`
        // depends on. `hasOwn` is the assertion, not a truthiness check: the
        // whole defect was a key that was PRESENT and undefined.
        expect(Object.hasOwn(parsed, 'defaultFromEmail')).toBe(false);
        expect(parsed).toEqual({ enabled: false });
    });

    it('refuses a sender that is not an address', () => {
        // defaultFromEmail becomes the From header on every message for the
        // tenant, and was previously any string an admin cared to post.
        expect(() => UpdateNotificationSettingsSchema.parse({ defaultFromEmail: 'not-an-address' })).toThrow();
        expect(() => UpdateNotificationSettingsSchema.parse({ defaultFromEmail: '' })).toThrow();
    });

    it('distinguishes "leave the compliance mailbox alone" from "clear it"', () => {
        // The route used to send `body.complianceMailbox || null`
        // unconditionally, so a partial body wiped a stored BCC address.
        expect(Object.hasOwn(UpdateNotificationSettingsSchema.parse({ enabled: true }), 'complianceMailbox')).toBe(false);
        expect(UpdateNotificationSettingsSchema.parse({ complianceMailbox: null }).complianceMailbox).toBeNull();
        expect(UpdateNotificationSettingsSchema.parse({ complianceMailbox: 'sec@example.test' }).complianceMailbox)
            .toBe('sec@example.test');
    });

    it('rejects unknown keys rather than forwarding them to Prisma', () => {
        expect(() => UpdateNotificationSettingsSchema.parse({ tenantId: 'other-tenant' })).toThrow();
    });
});
