/**
 * Set up the pilot auditor agent and its five audit procedure plans in ONE
 * tenant, from the command line (#3676, step 3c; owner decision 8, 2026-10-19).
 *
 * The set-up itself is `setUpAuditPilotAsOwner` in
 * `src/app-layer/usecases/audit-pilot-setup.ts`, whose docstring is the
 * contract: what it writes and through which usecases, which control each
 * plan lands on, the named refusals, dry run by default, idempotence. The
 * product reaches the same usecase on the `/agents/audit-pilot` page as the
 * signed-in owner (#3807). This file only names the owner by e-mail, resolves
 * their own membership's context, and prints each step.
 *
 * ## Usage
 *   npx tsx scripts/audit-pilot-setup.ts --tenant=<slug> --owner=<email>            # dry run
 *   npx tsx scripts/audit-pilot-setup.ts --tenant=<slug> --owner=<email> --apply
 *     [--name="Pilot auditor (library v1)"] [--control=iam.leaver_timeliness=<controlId>] …
 */
import { randomUUID } from 'node:crypto';

import { prisma } from '@/lib/prisma';
import { hashForLookup } from '@/lib/security/encryption';
import { resolveMemberContext } from '@/app-layer/context-system';
import {
    setUpAuditPilotAsOwner,
    type PilotSetupResult,
} from '@/app-layer/usecases/audit-pilot-setup';

// The usecase owns the pilot; this file resolves the owner from an e-mail.
export {
    DEFAULT_AUDITOR_NAME,
    PILOT_PARAMETERS,
    iso27001Identifiers,
    type PilotRefusal,
    type PilotSetupResult,
    type PilotStep,
    type StepOutcome,
} from '@/app-layer/usecases/audit-pilot-setup';

export interface PilotSetupOptions {
    readonly tenantSlug: string;
    readonly ownerEmail: string;
    readonly apply: boolean;
    readonly agentName?: string;
    /** Explicit control per procedure; a procedure not named here is mapped. */
    readonly controls?: Readonly<Record<string, string>>;
    readonly log?: (line: string) => void;
}

/**
 * Resolve the owner named by e-mail to their own membership's context, then
 * run the pilot as them. The two refusals only this lookup can make —
 * `TENANT_NOT_FOUND` and `OWNER_NOT_A_MEMBER` — are decided here; every other
 * one is the usecase's.
 */
export async function setUpAuditPilot(opts: PilotSetupOptions): Promise<PilotSetupResult> {
    const log = opts.log ?? ((line: string) => console.info(line));
    const refuse = (refusal: 'TENANT_NOT_FOUND' | 'OWNER_NOT_A_MEMBER' | 'OWNER_NOT_ACTIVE', detail: string): PilotSetupResult => {
        log(`REFUSED ${refusal}: ${detail}`);
        return { ok: false, refusal, detail };
    };
    const tenant = await prisma.tenant.findUnique({ where: { slug: opts.tenantSlug }, select: { id: true, slug: true } });
    if (!tenant) return refuse('TENANT_NOT_FOUND', `No tenant has the slug "${opts.tenantSlug}".`);
    const user = await prisma.user.findUnique({ where: { emailHash: hashForLookup(opts.ownerEmail) }, select: { id: true } });
    const membership = user
        ? await prisma.tenantMembership.findUnique({
              where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
              select: { status: true },
          })
        : null;
    if (!user || !membership) return refuse('OWNER_NOT_A_MEMBER', `${opts.ownerEmail} is not a member of ${tenant.slug}.`);
    const ctx = await resolveMemberContext({
        tenantId: tenant.id,
        userId: user.id,
        job: 'audit-pilot-setup',
        discriminator: randomUUID(),
    });
    if (!ctx) {
        return refuse('OWNER_NOT_ACTIVE', `${opts.ownerEmail}'s membership of ${tenant.slug} is ${membership.status}, not ACTIVE.`);
    }
    return setUpAuditPilotAsOwner(ctx, {
        apply: opts.apply,
        agentName: opts.agentName,
        controls: opts.controls,
        ownerLabel: opts.ownerEmail,
        log,
    });
}

function parseArgs(argv: readonly string[]): PilotSetupOptions | null {
    const value = (flag: string) => argv.find((a) => a.startsWith(`--${flag}=`))?.slice(flag.length + 3);
    const tenantSlug = value('tenant');
    const ownerEmail = value('owner');
    if (!tenantSlug || !ownerEmail) return null;
    const controls: Record<string, string> = {};
    for (const a of argv.filter((x) => x.startsWith('--control='))) {
        const spec = a.slice('--control='.length);
        const at = spec.lastIndexOf('=');
        if (at <= 0) return null;
        controls[spec.slice(0, at)] = spec.slice(at + 1);
    }
    return { tenantSlug, ownerEmail, apply: argv.includes('--apply'), agentName: value('name'), controls };
}

export async function run(argv: readonly string[]): Promise<number> {
    const opts = parseArgs(argv);
    if (!opts) {
        console.error(
            'usage: audit-pilot-setup --tenant=<slug> --owner=<email> [--apply] [--name=<auditor name>] ' +
                '[--control=<procedure>=<controlId> …]',
        );
        return 2;
    }
    const result = await setUpAuditPilot(opts);
    return result.ok ? 0 : 1;
}

if (require.main === module) {
    run(process.argv.slice(2))
        .then(async (code) => {
            await prisma.$disconnect();
            process.exit(code);
        })
        .catch(async (err) => {
            console.error('[audit-pilot-setup] FAILED', err instanceof Error ? err.message : err);
            await prisma.$disconnect();
            process.exit(1);
        });
}
