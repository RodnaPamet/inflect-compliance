/**
 * Proving run, the ROSTER half — drive an HRIS sync against a real instance.
 *
 * ## Why this exists
 *
 * `legacy-reconcile` refuses `NO_FRESH_ROSTER` unless an HRIS sync has PASSED
 * recently, on the documented grounds that a stale roster "mass-produces false
 * orphans and false leavers rather than degrading gently". That gate is right,
 * and it was unreachable: **no HRIS sync had ever executed in production** —
 * zero `IntegrationExecution` rows for `bamboohr`, `workday` or `orangehrm`,
 * ever. #3594 found why for the one provider that could be pointed at a
 * fixture: it authenticated with a grant OrangeHRM does not implement.
 *
 * With that fixed, this drives the half the legacy proving run (#3592) could
 * not reach.
 *
 * ## What it is NOT
 *
 * Not a seeder, a fixture or a migration, and deliberately not wired into
 * `build-worker.mjs`, `package.json` or any job. Run by hand, one phase per
 * invocation, so a human reads each result before the next write happens.
 *
 * ## Phases
 *
 *   tenant       create the proving tenant, a reviewer user and a membership
 *   hrm-connect  create the `orangehrm` connection pointed at the lab
 *   hrm-consent  drive the OAuth consent and store the token pair
 *   hrm-sync     enqueue `hris-sync`. The worker does the work
 *   status       read what the phases produced. Writes nothing
 *
 * ## Why the consent is driven here rather than clicked
 *
 * `OAuth2\AuthorizationController::handle` reads `authorized` off the QUERY
 * STRING and calls `setAuthorizationApproved($authorized === true)`, so
 * approving is a GET to `/oauth2/authorize/consent` with the original
 * parameters plus `authorized=true` — a session cookie, no CSRF token, no
 * browser. Measured against `orangehrm/orangehrm:5.9`, which is also where the
 * rest of this flow's shape came from rather than from a design note.
 *
 * Nothing here prints a credential: the authorization code is reported by
 * length, tokens never leave the usecase, and the admin password arrives on
 * stdin so it never enters an argument vector.
 */

import { buildSystemContext } from '@/app-layer/context-system';
import { upsertIntegrationConnection } from '@/app-layer/usecases/integrations';
import { completeOrangeHrmConsent } from '@/app-layer/usecases/orangehrm-connection-consent';
import { buildOrangeHrmAuthorizeUrl } from '@/app-layer/integrations/providers/orangehrm/token';
import { enqueue } from '@/app-layer/jobs/queue';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { hashForLookup } from '@/lib/security/encryption';
import { prisma } from '@/lib/prisma';

const PROVIDER = 'orangehrm';
const CONNECTION_NAME = 'Proving run — OrangeHRM lab';

function need(name: string): string {
    const v = process.env[name]?.trim();
    if (!v) throw new Error(`${name} is required and is empty`);
    return v;
}

/** PRESENT/ABSENT and a length — never the value. */
function present(v: string | null | undefined): string {
    if (v === null || v === undefined) return 'null';
    return `present:${String(v.length)}`;
}

async function resolveTenant(slug: string): Promise<{ id: string; slug: string } | null> {
    return prisma.tenant.findFirst({ where: { slug }, select: { id: true, slug: true } });
}

async function requireTenant(slug: string): Promise<{ id: string; slug: string }> {
    const t = await resolveTenant(slug);
    if (!t) throw new Error(`no tenant with slug ${slug} — run the tenant phase first`);
    return t;
}

async function findConnection(tenantId: string): Promise<string | null> {
    const c = await prisma.integrationConnection.findFirst({
        where: { tenantId, provider: PROVIDER },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
    });
    return c?.id ?? null;
}

/**
 * Log into the lab instance and come back with an authorization code.
 *
 * Talks to the instance over the COMPOSE NETWORK (`http://orangehrm`) rather
 * than the public hostname, because this half is a browser stand-in and a
 * browser's route is not the integration's. The token EXCHANGE that follows
 * goes through the public HTTPS host, because that is the connection's
 * `baseUrl` and `safeFetch` re-resolves it — so both paths are exercised, each
 * by the thing that really uses it.
 */
async function authorizationCode(opts: {
    readonly internalBase: string;
    readonly user: string;
    readonly pass: string;
    readonly clientId: string;
    readonly redirectUri: string;
    readonly publicHost: string;
}): Promise<string> {
    const jar = new Map<string, string>();
    const cookieHeader = (): string => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const absorb = (res: Response): void => {
        for (const c of res.headers.getSetCookie()) {
            const pair = c.split(';')[0];
            const i = pair.indexOf('=');
            if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
        }
    };
    const go = async (url: string, init: RequestInit = {}): Promise<Response> => {
        const res = await fetch(url, {
            redirect: 'manual',
            ...init,
            headers: { Cookie: cookieHeader(), ...(init.headers ?? {}) },
        });
        absorb(res);
        return res;
    };

    const root = `${opts.internalBase}/web/index.php`;

    const page = await go(`${root}/auth/login`);
    const html = await page.text();
    // The token is a JSON string inside an HTML attribute. Two shapes because
    // 5.9 emits the escaped-entity form and older builds a plain one — the
    // adapter in `deploy/orangehrm-mcp/server.mjs` reads the same thing.
    const token = /:token="&quot;([^&]+)&quot;"/.exec(html)?.[1]
        ?? /"token":"([^"]+)"/.exec(html)?.[1];
    if (!token) throw new Error('the login page carried no CSRF token');

    const validated = await go(`${root}/auth/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ _token: token, username: opts.user, password: opts.pass }),
    });
    const landed = validated.headers.get('location') ?? '';
    // A wrong password REDIRECTS BACK TO THE LOGIN PAGE rather than returning a
    // 4xx, so the status cannot tell success from failure and the destination
    // is what has to be read.
    if (landed.includes('/auth/login')) throw new Error('the lab rejected the admin credentials');

    // Built by the PRODUCTION builder, against the PUBLIC host, so the
    // parameters this consent approves are the ones a real admin would be sent
    // with — including the `redirect_uri` the exchange must then byte-match.
    const authorizeUrl = buildOrangeHrmAuthorizeUrl({
        client: { host: opts.publicHost, clientId: opts.clientId },
        redirectUri: opts.redirectUri,
        state: 'proving-run-state',
    });
    const query = authorizeUrl.slice(authorizeUrl.indexOf('?') + 1);

    // `authorized=true` IS the consent. See the module docblock.
    const consent = await go(`${root}/oauth2/authorize/consent?${query}&authorized=true`);
    const location = consent.headers.get('location') ?? '';
    const code = /[?&]code=([^&]+)/.exec(location)?.[1];
    const state = /[?&]state=([^&]+)/.exec(location)?.[1];
    if (!code) {
        throw new Error(
            `consent did not issue a code (status ${String(consent.status)}) — `
            + 'the client must be CONFIDENTIAL and its redirect_uri must match exactly',
        );
    }
    if (state !== 'proving-run-state') {
        throw new Error(`consent echoed state '${state ?? 'absent'}' — refusing a code we cannot tie to our request`);
    }
    return code;
}

async function main(): Promise<void> {
    const phase = process.argv[2] ?? '';
    const slug = need('PROVING_TENANT_SLUG');

    if (phase === 'tenant') {
        const existing = await resolveTenant(slug);
        if (existing) {
            console.log(`exists      ${existing.slug} (${existing.id})`);
        } else {
            // `createTenantWithDek`, not `prisma.tenant.create`: a tenant
            // without a wrapped DEK depends on a backfill to become usable, and
            // every secret this run stores is encrypted under it.
            const t = await createTenantWithDek({ name: 'Proving run', slug });
            console.log(`created     ${t.slug} (${t.id})`);
        }
        const tenant = await requireTenant(slug);

        // A real reviewer user, because phase 5's campaign requires a
        // `reviewerUserId` that resolves — and because an access review
        // assigned to a principal that is not a person is not a review.
        const email = `reviewer@${slug}.proving.test`;
        const user = await prisma.user.upsert({
            where: { emailHash: hashForLookup(email) },
            create: { email, emailHash: hashForLookup(email), name: 'Proving run reviewer' },
            update: {},
            select: { id: true },
        });
        await prisma.tenantMembership.upsert({
            where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
            create: { tenantId: tenant.id, userId: user.id, role: 'OWNER', status: 'ACTIVE' },
            update: {},
        });
        console.log(`reviewer    ${user.id} (email ${present(email)})`);
        return;
    }

    const tenant = await requireTenant(slug);
    const ctx = buildSystemContext({
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        job: 'proving-run-roster',
    });
    console.log(`tenant      ${tenant.slug} (${tenant.id})`);
    console.log(`phase       ${phase || '(none given)'}`);

    if (phase === 'hrm-connect') {
        const baseUrl = need('PROVING_HRM_HOST');
        const clientId = need('PROVING_HRM_CLIENT_ID');
        const clientSecret = need('PROVING_HRM_CLIENT_SECRET');
        const existing = await findConnection(tenant.id);
        const conn = await upsertIntegrationConnection(ctx, {
            id: existing ?? undefined,
            provider: PROVIDER,
            name: CONNECTION_NAME,
            configJson: { baseUrl, clientId },
            secrets: { clientSecret },
            isEnabled: true,
        });
        console.log(`${existing ? 'updated' : 'created'}     ${conn.id}  baseUrl=${baseUrl}`);
        console.log(`secret      clientSecret ${present(clientSecret)}`);
        return;
    }

    if (phase === 'hrm-consent') {
        const id = await findConnection(tenant.id);
        if (!id) throw new Error('no orangehrm connection — run hrm-connect first');
        const code = await authorizationCode({
            internalBase: need('PROVING_HRM_INTERNAL_BASE'),
            user: need('PROVING_HRM_ADMIN_USER'),
            pass: need('PROVING_HRM_ADMIN_PASSWORD'),
            clientId: need('PROVING_HRM_CLIENT_ID'),
            redirectUri: need('PROVING_HRM_REDIRECT_URI'),
            publicHost: need('PROVING_HRM_HOST'),
        });
        console.log(`code        captured, ${code.length} chars`);
        const r = await completeOrangeHrmConsent(ctx, {
            connectionId: id,
            code,
            redirectUri: need('PROVING_HRM_REDIRECT_URI'),
        });
        console.log(`authorized  "${r.connectionName}" — the token pair is on the connection`);
        return;
    }

    if (phase === 'hrm-sync') {
        const id = await findConnection(tenant.id);
        if (!id) throw new Error('no orangehrm connection — run hrm-connect first');
        const job = await enqueue('hris-sync', { tenantId: tenant.id, connectionId: id });
        console.log(`enqueued    hris-sync jobId=${job.id ?? '(none)'}`);
        return;
    }

    if (phase === 'status') {
        const conns = await prisma.integrationConnection.findMany({
            where: { tenantId: tenant.id },
            select: { id: true, provider: true, name: true, isEnabled: true, secretEncrypted: true },
            orderBy: { createdAt: 'asc' },
        });
        console.log(`connections ${conns.length}`);
        for (const c of conns) {
            // The SHAPE of the secret, never its content — whether a token pair
            // is on file is the fact this phase reports.
            console.log(`  ${c.provider.padEnd(12)} ${c.id} enabled=${String(c.isEnabled)} secret=${present(c.secretEncrypted)}`);
        }

        const execs = await prisma.integrationExecution.findMany({
            where: { tenantId: tenant.id },
            select: { automationKey: true, status: true, errorMessage: true, executedAt: true },
            orderBy: { executedAt: 'asc' },
            take: 20,
        });
        console.log(`executions  ${execs.length}`);
        for (const e of execs) {
            console.log(`  ${String(e.automationKey).padEnd(22)} ${String(e.status).padEnd(8)} ${e.errorMessage ?? ''}`);
        }

        const employees = await prisma.employee.count({ where: { tenantId: tenant.id } });
        console.log(`employees   ${employees}`);
        if (employees > 0) {
            const rows = await prisma.employee.findMany({
                where: { tenantId: tenant.id },
                select: { externalId: true, hrisRecordId: true, fullName: true, workEmail: true, status: true, department: true, employeeNumber: true },
                orderBy: { externalId: 'asc' },
                take: 20,
            });
            for (const r of rows) {
                // `workEmail` is NOT NULL on this model and is the field the
                // reconcile engine matches on, so its PRESENCE is the fact
                // worth printing — a row whose address did not survive the
                // mapping would reconcile against nothing.
                console.log(
                    `  emp external=${present(r.externalId)} hrisId=${present(r.hrisRecordId)} `
                    + `name=${present(r.fullName)} workEmail=${present(r.workEmail)} `
                    + `empNo=${present(r.employeeNumber)} `
                    + `status=${String(r.status)} dept=${r.department ?? 'null'}`
                );
            }
        }
        return;
    }

    throw new Error('phase must be one of: tenant hrm-connect hrm-consent hrm-sync status');
}

main()
    .then(async () => {
        await prisma.$disconnect();
        process.exit(0);
    })
    .catch(async (err: unknown) => {
        console.error(err instanceof Error ? `FAILED: ${err.message}` : `FAILED: ${String(err)}`);
        if (err instanceof Error && err.stack) console.error(err.stack);
        await prisma.$disconnect();
        process.exit(1);
    });
