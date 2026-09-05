/**
 * A THIRD_PARTY agent is traceable to a named supplier — at registration, after
 * an EDIT, and from the credential it connects with.
 *
 * ## What already existed, and what this file is for
 *
 * The rule "a THIRD_PARTY agent must name a Vendor" is enforced three times on
 * purpose: `UpdateRegisteredAgentSchema` / `CreateRegisteredAgentSchema` /
 * `RegisterAgentSchema` refine it (proved at the schema layer by
 * `tests/unit/agent-registry-input-rules.test.ts`, which reads the Zod issue
 * PATH so a form knows which box to light up), and the migration's
 * `RegisteredAgent_thirdParty_requires_vendor_check` CHECK backstops it (proved
 * against a raw CREATE by `tests/integration/agent-registry-isolation.test.ts`).
 * Neither of those is repeated here.
 *
 * What was NOT covered is the seam between them, and it was a live defect. The
 * schema refinement judges the PAYLOAD; the CHECK judges the RESULTING ROW.
 * `updateRegisteredAgent(ctx, id, { vendorId: null })` names no provenance, so
 * the refinement answers "not an unattributed third party" and passes — and the
 * row it lands on is THIRD_PARTY. Enforcement fell through to Postgres, which
 * has no idea it is answering a validation question: the create path returns a
 * 400 naming `vendorId`, and this path returned a raw constraint violation.
 * `updateRegisteredAgent` now applies the same predicate to the MERGE, and the
 * assertions below are about that: the refusal, the row surviving it unchanged,
 * and the two edits that must still be allowed.
 *
 * ## And the "server" half of the question
 *
 * There is no MCP server or connection RECORD in this codebase to attach a
 * vendor to — this product IS the MCP server (`/api/mcp`), agents connect
 * INBOUND to it, and nothing anywhere holds a remote server URL, transport or
 * connection target. The nearest thing to a per-connection record is
 * `TenantApiKey`, the credential an agent authenticates with, which carries
 * `agentId`. So a third-party CONNECTION is already traceable to a supplier —
 * through the agent, in two hops — and the last `describe` pins that the chain
 * resolves rather than inventing a parallel record to hold the same fact.
 */
import { PrismaClient, MembershipStatus, Role } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { registerAgent, updateRegisteredAgent } from '@/app-layer/usecases/agent-registry';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(30_000);

const TENANT = 'tpvendor-tenant';

let ownerUserId = '';
let vendorId = '';
let secondVendorId = '';

/**
 * `resetDatabase` truncates a fixed table list that includes none of these, so
 * this suite clears its own rows — otherwise it passes exactly once on a fresh
 * database and fails every re-run, and CI always starts clean, which is what
 * would hide it.
 *
 * The AuditLog / TenantMembership deletes go through `session_replication_role
 * = 'replica'`: the immutable-audit-log trigger and the last-OWNER guard both
 * fire on an ordinary DELETE and would take the teardown — and therefore the
 * whole suite — down with them.
 */
async function clearOwnRows(): Promise<void> {
    const t = { tenantId: TENANT };
    // Ordered by FK: the key restricts the agent, the agent references the
    // vendor, and the agent's AI-system entry outlives neither.
    await prisma.tenantApiKey.deleteMany({ where: t });
    await prisma.agentProposal.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await prisma.vendor.deleteMany({ where: t });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, TENANT);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT);
    });
    await prisma.user.deleteMany({
        where: { emailHash: hashForLookup(`owner@${TENANT}.test`) },
    });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
}

const ctx = () =>
    makeRequestContext('OWNER', { tenantId: TENANT, tenantSlug: TENANT, userId: ownerUserId });

/** Register a THIRD_PARTY agent attributed to `vendorId`. Returns its id. */
async function registerThirdParty(name: string): Promise<string> {
    const created = await registerAgent(ctx(), {
        name,
        autonomyLevel: 1,
        dataAccessScope: 'READ_TENANT_DATA',
        reversibility: 'REVERSIBLE',
        provenance: 'THIRD_PARTY',
        vendorId,
        ownerUserId,
    });
    return created.id;
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();

    await prisma.tenant.create({ data: { id: TENANT, name: 'Third-party co', slug: TENANT } });
    const email = `owner@${TENANT}.test`;
    const user = await prisma.user.create({
        data: { email, emailHash: hashForLookup(email) },
    });
    ownerUserId = user.id;
    await prisma.tenantMembership.create({
        data: {
            tenantId: TENANT,
            userId: user.id,
            role: Role.OWNER,
            status: MembershipStatus.ACTIVE,
        },
    });

    const vendor = await prisma.vendor.create({
        data: { tenantId: TENANT, name: 'Acme Agent Supply' },
    });
    vendorId = vendor.id;
    const second = await prisma.vendor.create({
        data: { tenantId: TENANT, name: 'Beta Agent Supply' },
    });
    secondVendorId = second.id;
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('registering a third-party agent without a vendor', () => {
    it('is REFUSED, and leaves no AI-system entry behind', async () => {
        // `registerAgent` AUTHORS the EU AI Act register entry alongside the
        // agent, so a refusal that happened halfway would leave an orphan
        // `AiSystem` nobody can reach — the register would gain a row for an
        // agent that does not exist. The count is the assertion.
        const before = await prisma.aiSystem.count({ where: { tenantId: TENANT } });

        await expect(
            registerAgent(ctx(), {
                name: 'Unattributed third party',
                autonomyLevel: 1,
                dataAccessScope: 'NONE',
                reversibility: 'REVERSIBLE',
                provenance: 'THIRD_PARTY',
                ownerUserId,
            }),
        ).rejects.toThrow(/vendor/i);

        expect(await prisma.aiSystem.count({ where: { tenantId: TENANT } })).toBe(before);
        expect(
            await prisma.registeredAgent.count({
                where: { tenantId: TENANT, name: 'Unattributed third party' },
            }),
        ).toBe(0);
    });

    it('succeeds once the supplier is named, and the row records it', async () => {
        // The positive companion. Without it, a create path that refused
        // everything would satisfy the assertion above.
        const id = await registerThirdParty('Attributed third party');

        const row = await prisma.registeredAgent.findUniqueOrThrow({ where: { id } });
        expect(row.provenance).toBe('THIRD_PARTY');
        expect(row.vendorId).toBe(vendorId);
    });
});

describe('an edit cannot strip the supplier off a third-party agent', () => {
    it('REFUSES an edit that only nulls the vendor — the payload names no provenance', async () => {
        const id = await registerThirdParty('Supplier-stripping probe');

        // The seam. The Zod refinement sees `{ vendorId: null }`, finds no
        // `provenance: 'THIRD_PARTY'` in it, and passes. Only a check against
        // the MERGED row can refuse this, and the refusal has to be an ordinary
        // 400 naming the rule — not a constraint violation from the driver.
        await expect(updateRegisteredAgent(ctx(), id, { vendorId: null })).rejects.toThrow(
            /must name the vendor/i,
        );

        // And the row survived the refusal intact: the write is inside the same
        // transaction, so a check placed after it would leave this assertion
        // green while the column had already moved and rolled back — which is
        // why the supplier, not merely the throw, is what is asserted.
        const row = await prisma.registeredAgent.findUniqueOrThrow({ where: { id } });
        expect(row.vendorId).toBe(vendorId);
        expect(row.provenance).toBe('THIRD_PARTY');
    });

    it('ALLOWS moving the agent to a different supplier', async () => {
        const id = await registerThirdParty('Supplier-swap probe');

        await updateRegisteredAgent(ctx(), id, { vendorId: secondVendorId });

        const row = await prisma.registeredAgent.findUniqueOrThrow({ where: { id } });
        expect(row.vendorId).toBe(secondVendorId);
    });

    it('ALLOWS dropping the vendor in the same edit that stops it being third-party', async () => {
        // The requirement is attached to THIRD_PARTY, not to the column. An
        // agent brought in-house may — and must be able to — release its
        // supplier, and it takes one edit rather than an impossible ordering.
        const id = await registerThirdParty('Brought-in-house probe');

        await updateRegisteredAgent(ctx(), id, {
            provenance: 'FIRST_PARTY',
            vendorId: null,
        });

        const row = await prisma.registeredAgent.findUniqueOrThrow({ where: { id } });
        expect(row.provenance).toBe('FIRST_PARTY');
        expect(row.vendorId).toBeNull();
    });

    it('and the DDL is still the backstop, for a write that goes round the usecase', async () => {
        // The usecase check moved enforcement UP, not away. A raw update — a
        // script, a future code path, anything that does not go through
        // `updateRegisteredAgent` — is still refused by the CHECK constraint.
        const id = await registerThirdParty('Raw-update probe');

        await expect(
            prisma.registeredAgent.update({ where: { id }, data: { vendorId: null } }),
        ).rejects.toThrow();

        const row = await prisma.registeredAgent.findUniqueOrThrow({ where: { id } });
        expect(row.vendorId).toBe(vendorId);
    });

    it('and a supplier cannot be erased out from under the agent it supplies', async () => {
        // `RegisteredAgent_vendorId_fkey` is ON DELETE SET NULL, so deleting the
        // Vendor would null the column — onto a row the CHECK forbids to be
        // null. Postgres evaluates the CHECK on the result, so the DELETE is
        // refused. Pinned because the two clauses were written independently and
        // it is their COMPOSITION that makes a third-party agent permanently
        // attributable; a well-meaning switch to ON DELETE CASCADE or a dropped
        // CHECK would silently orphan the attribution instead.
        const id = await registerThirdParty('Vendor-erasure probe');

        await expect(prisma.vendor.delete({ where: { id: vendorId } })).rejects.toThrow();

        const row = await prisma.registeredAgent.findUniqueOrThrow({ where: { id } });
        expect(row.vendorId).toBe(vendorId);
    });
});

describe('the credential a third-party agent connects with is traceable to its supplier', () => {
    it('resolves TenantApiKey → RegisteredAgent → Vendor in one read', async () => {
        // There is no MCP-server or connection record in this codebase to hang a
        // vendor off — see this file's header. `TenantApiKey.agentId` is the
        // nearest thing, and it already carries the linkage transitively. This
        // asserts the chain RESOLVES, so a change that decouples a key from its
        // agent (or an agent from its vendor) shows up as a failure here rather
        // than as an inbound connection nobody can attribute to a supplier.
        const agentId = await registerThirdParty('Connected third party');

        const key = await prisma.tenantApiKey.create({
            data: {
                tenantId: TENANT,
                name: 'Supplier agent key',
                keyPrefix: 'iflk_tpv',
                keyHash: hashForLookup(`third-party-vendor-linkage-${agentId}`),
                scopes: ['mcp:read'],
                createdById: ownerUserId,
                agentId,
            },
        });

        const resolved = await prisma.tenantApiKey.findUniqueOrThrow({
            where: { id: key.id },
            select: { agent: { select: { provenance: true, vendor: { select: { name: true } } } } },
        });

        expect(resolved.agent?.provenance).toBe('THIRD_PARTY');
        expect(resolved.agent?.vendor?.name).toBe('Acme Agent Supply');
    });
});
