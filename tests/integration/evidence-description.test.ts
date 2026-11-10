/**
 * EVIDENCE DESCRIPTION, AGAINST A REAL DATABASE (#5018).
 *
 * `Evidence.description` is new: what the evidence shows and why it supports
 * its controls. It is free text a person types, so it is held to the two rules
 * every such column in this repo is held to:
 *
 *   - sanitised by every writer (the JSON create, the edit), so the stored row
 *     is safe for every renderer that decrypts it — UI, PDF, share link, API;
 *   - encrypted at rest by the Epic B manifest, so the column holds ciphertext
 *     and only the extension's read returns the text.
 *
 * And it is three-state on edit, like the category: omitted leaves it, null or
 * blank clears it.
 */
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { hashForLookup } from '@/lib/security/encryption';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { createEvidence, getEvidence, updateEvidence } from '@/app-layer/usecases/evidence';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `evdesc-${randomUUID().slice(0, 8)}`;
const USER = `${SUITE}-admin`;

/** The column as stored, bypassing every client extension. */
async function storedDescription(id: string): Promise<string | null> {
    const rows = await prisma.$queryRawUnsafe<Array<{ description: string | null }>>(
        'SELECT "description" FROM "Evidence" WHERE "id" = $1',
        id,
    );
    return rows[0]?.description ?? null;
}

describeFn('Evidence.description', () => {
    let ctx: RequestContext;

    beforeAll(async () => {
        const tenantId = SUITE;
        const email = `${USER}@example.test`;
        await prisma.user.upsert({
            where: { id: USER },
            update: {},
            create: { id: USER, email, emailHash: hashForLookup(email) },
        });
        await createTenantWithDek({ id: tenantId, name: tenantId, slug: tenantId });
        await prisma.tenantMembership.create({ data: { tenantId, userId: USER, role: 'ADMIN', status: 'ACTIVE' } });
        ctx = makeRequestContext('ADMIN', { tenantId, tenantSlug: tenantId, userId: USER });
    });

    it('is sanitised on create, encrypted at rest, and read back as text', async () => {
        const created = await createEvidence(ctx, {
            type: 'LINK',
            title: 'Methodology v1',
            content: 'https://example.test/methodology',
            description: '  Accepted by the practice lead.<script>alert(1)</script>  ',
        });

        const read = await getEvidence(ctx, created.id);
        expect(read.description).toBe('Accepted by the practice lead.');

        const raw = await storedDescription(created.id);
        expect(raw).not.toBeNull();
        expect(raw).not.toContain('Accepted by the practice lead');
        expect(raw).toMatch(/^v[12]:/);
    });

    it('a blank description is stored as none', async () => {
        const created = await createEvidence(ctx, {
            type: 'TEXT',
            title: 'A note',
            content: 'body',
            description: '   ',
        });
        expect(await storedDescription(created.id)).toBeNull();
    });

    it('is three-state on edit: omitted leaves it, a new value replaces it, null clears it', async () => {
        const created = await createEvidence(ctx, {
            type: 'TEXT',
            title: 'Edited note',
            content: 'body',
            description: 'First',
        });

        await updateEvidence(ctx, created.id, { title: 'Edited note (renamed)' });
        expect((await getEvidence(ctx, created.id)).description).toBe('First');

        await updateEvidence(ctx, created.id, { description: 'Second <b>bold</b>' });
        expect((await getEvidence(ctx, created.id)).description).toBe('Second bold');

        await updateEvidence(ctx, created.id, { description: null });
        expect(await storedDescription(created.id)).toBeNull();
    });

    it('links every control in one create', async () => {
        const controls = await Promise.all(
            ['A.5.19', 'A.5.20', 'A.5.22'].map((annexId) =>
                prisma.control.create({ data: { tenantId: ctx.tenantId, name: `Supplier control ${annexId}`, annexId } }),
            ),
        );
        const created = await createEvidence(ctx, {
            type: 'LINK',
            title: 'Supplier methodology',
            content: 'https://example.test/m',
            controlIds: controls.map((c) => c.id),
        });
        const links = await prisma.evidenceControlLink.findMany({
            where: { evidenceId: created.id },
            select: { controlId: true },
        });
        expect(links.map((l) => l.controlId).sort()).toEqual(controls.map((c) => c.id).sort());
    });
});
