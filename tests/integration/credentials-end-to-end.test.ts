/**
 * End-to-end credentials flow integration test — real DB, real bcrypt,
 * real mailer (stubbed).
 *
 * This is the smoke test for the full production credentials path.
 * Every collaborator the chokepoint touches runs for real:
 *   - `prisma.user` + `prisma.verificationToken` (real DB)
 *   - bcrypt hashing + verify (not mocked)
 *   - `authenticateWithPassword` chokepoint (src/lib/auth/credentials.ts)
 *   - `issueEmailVerification` + `consumeEmailVerification`
 *   - per-identifier rate limit (memory fallback)
 *   - security-event emission (appendAuditEntry → real AuditLog row)
 *
 * Scenarios (mapped to the prompt's success criteria):
 *   1. verified successful login
 *   2. blocked unverified login (AUTH_REQUIRE_EMAIL_VERIFICATION=1)
 *   3. invalid credential attempt
 *   4. rate-limited login attempt
 *
 * The test manages its own fixtures (one tenant + one user) and resets
 * rate-limit + env state between cases so each scenario is isolated.
 */

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { PrismaClient } from '@prisma/client';

import { setEmailProvider, StubEmailProvider } from '@/lib/mailer';
import {
    authenticateWithPassword,
    __resetProgressiveForTests,
} from '@/lib/auth/credentials';
import {
    __resetCredentialsRateLimitForTests,
    CREDENTIALS_RATE_LIMIT,
} from '@/lib/auth/credential-rate-limit';
import {
    issueEmailVerification,
    consumeEmailVerification,
} from '@/lib/auth/email-verification';
import { hashPassword } from '@/lib/auth/passwords';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('Credentials path — end-to-end', () => {
    let prisma: PrismaClient;
    let stub: StubEmailProvider;
    const uniq = `ce2e-${Date.now()}`;
    const email = `${uniq}@example.com`;
    const password = 'CorrectHorseBattery9!'; // pragma: allowlist secret — test-only password
    let tenantId = '';
    let userId = '';

    beforeAll(async () => {
        // Force the in-memory rate-limit fallback. The test env mock
        // defaults to `upstash` but no UPSTASH_REDIS_REST_URL is set,
        // which makes `_limiter.limit()` throw — and the module's
        // fail-open policy would let every attempt through, masking
        // the rate-limit assertions below.
        process.env.RATE_LIMIT_MODE = 'memory';

        prisma = prismaTestClient();
        await prisma.$connect();

        stub = new StubEmailProvider();
        setEmailProvider(stub);

        const tenant = await prisma.tenant.create({
            data: { name: 'CE2E Test Co', slug: uniq },
        });
        tenantId = tenant.id;

        const passwordHash = await hashPassword(password);
        const user = await prisma.user.create({
            data: { email, name: 'CE2E User', passwordHash },
        });
        userId = user.id;

        // Give them a tenant membership so audit events have a home
        await prisma.tenantMembership.create({
            data: { tenantId, userId, role: 'ADMIN', status: 'ACTIVE' },
        });
    });

    afterAll(async () => {
        await prisma.verificationToken.deleteMany({ where: { identifier: email } });
        await prisma.tenantMembership.deleteMany({ where: { userId } });
        await prisma.user.delete({ where: { id: userId } }).catch(() => {});
        await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => {});
        await prisma.$disconnect();
    });

    beforeEach(async () => {
        __resetCredentialsRateLimitForTests();
        // Epic A.3 added a second, independent progressive counter
        // (5s/30s delays + 15-min lockout keyed on SHA-256(email)).
        // Without this reset its state stacks across tests and the
        // rate-limit test burns minutes of delay before hitting the
        // 30s jest timeout.
        await __resetProgressiveForTests(email);
        // Each scenario starts from a known state — no pending tokens,
        // email-verification gate OFF unless the scenario explicitly
        // enables it, no existing audit rows tied to the test user.
        stub.sentMessages = [];
        await prisma.verificationToken.deleteMany({ where: { identifier: email } });
        delete process.env.AUTH_REQUIRE_EMAIL_VERIFICATION;
    });

    // ── 1. Verified successful login ────────────────────────────────────

    it('verifies an email, then authenticates successfully', async () => {
        // issue + consume via the same helpers the app uses
        await issueEmailVerification(email, { userId });
        expect(stub.sentMessages.length).toBe(1);
        const raw = stub.sentMessages[0].text.match(/token=([a-f0-9]{64})/)![1];

        const consumed = await consumeEmailVerification(raw);
        expect(consumed).toEqual({ ok: true, userId, email });

        const userAfter = await prisma.user.findUnique({ where: { id: userId } });
        expect(userAfter?.emailVerified).toBeInstanceOf(Date);

        // Happy-path login
        const result = await authenticateWithPassword({ email, password });
        expect(result).toEqual({
            ok: true,
            userId,
            email,
            name: 'CE2E User',
        });

        // Audit trail carries an AUTH_LOGIN_SUCCESS row for this user
        const audits = await prisma.auditLog.findMany({
            where: { userId, action: 'AUTH_LOGIN_SUCCESS' },
            orderBy: { createdAt: 'desc' },
            take: 1,
        });
        expect(audits.length).toBe(1);
        // Plaintext password must never appear in the audit row
        expect(JSON.stringify(audits[0])).not.toContain(password);
    });

    // ── 2. Blocked unverified login ─────────────────────────────────────

    it('rejects login with email_not_verified when the gate is on and user is unverified', async () => {
        // Flip the gate ON for this scenario only — the env is loaded via
        // a Proxy (src/env.ts) so mutating process.env is visible to the
        // chokepoint on its next read.
        process.env.AUTH_REQUIRE_EMAIL_VERIFICATION = '1';

        // Ensure the test user is unverified for this case
        await prisma.user.update({
            where: { id: userId },
            data: { emailVerified: null },
        });

        const result = await authenticateWithPassword({ email, password });
        expect(result).toEqual({ ok: false, reason: 'email_not_verified' });

        // Audit row uses the dedicated verification-required action
        const audits = await prisma.auditLog.findMany({
            where: {
                userId,
                action: 'AUTH_LOGIN_EMAIL_VERIFICATION_REQUIRED',
            },
            orderBy: { createdAt: 'desc' },
            take: 1,
        });
        expect(audits.length).toBe(1);
    });

    // ── 3. Invalid credential attempt ───────────────────────────────────

    it('rejects a wrong password with credentials_invalid — no raw password in audit', async () => {
        const result = await authenticateWithPassword({
            email,
            password: 'this-is-not-the-password', // pragma: allowlist secret — test-only wrong-password literal
        });
        expect(result).toEqual({ ok: false, reason: 'credentials_invalid' });

        const audits = await prisma.auditLog.findMany({
            where: { userId, action: 'AUTH_LOGIN_FAILURE' },
            orderBy: { createdAt: 'desc' },
            take: 1,
        });
        expect(audits.length).toBe(1);
        expect(JSON.stringify(audits[0])).not.toContain('this-is-not-the-password');
        // Plaintext email also never leaks to audit details (only the hash)
        expect(JSON.stringify(audits[0].detailsJson)).not.toContain(email);
    });

    // ── 4. Rate-limited login attempt ───────────────────────────────────

    // Each bcrypt verify at BCRYPT_COST=12 is ~300ms, so N+2 attempts
    // blows past jest's default 5s timeout. Bump per-test.
    it(`rate-limits after ${CREDENTIALS_RATE_LIMIT.maxAttempts} attempts and resets on success`, async () => {
        // Burn the bucket with wrong-password attempts. Reset the
        // Epic A.3 progressive counter between attempts so its
        // 5s/30s delays don't stack across iterations — we're
        // testing the CREDENTIALS_RATE_LIMIT bucket here, which is a
        // separate mechanism, and there's a dedicated
        // `auth-brute-force.test.ts` suite covering the progressive
        // ladder end-to-end.
        for (let i = 0; i < CREDENTIALS_RATE_LIMIT.maxAttempts; i++) {
            await __resetProgressiveForTests(email);
            const r = await authenticateWithPassword({
                email,
                password: `wrong-${i}`,
            });
            expect(r).toEqual({ ok: false, reason: 'credentials_invalid' });
        }
        // Last progressive reset before the rate-limit-gated attempt
        // so the failure surfaces as `rate_limited`, not a delayed
        // `credentials_invalid`.
        await __resetProgressiveForTests(email);
        // Next attempt is gated by rate limit, not by the password check —
        // correct password would pass if it got there, but it doesn't.
        const blocked = await authenticateWithPassword({ email, password });
        expect(blocked.ok).toBe(false);
        if (!blocked.ok) {
            expect(blocked.reason).toBe('rate_limited');
            expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
        }

        const audits = await prisma.auditLog.findMany({
            where: { userId, action: 'AUTH_LOGIN_RATE_LIMITED' },
            orderBy: { createdAt: 'desc' },
            take: 1,
        });
        expect(audits.length).toBe(1);

        // Reset the bucket (simulating the window elapsing) — next real
        // login should go through cleanly. Uses the test-only reset
        // helper so we don't have to wait 15 minutes of wall clock.
        __resetCredentialsRateLimitForTests();
        const afterReset = await authenticateWithPassword({ email, password });
        expect(afterReset.ok).toBe(true);
    }, 30_000);
});
