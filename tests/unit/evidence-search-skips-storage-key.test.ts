/**
 * Evidence search does not match a FILE's storage key (#4277).
 *
 * The free-text search ran `contains` over `content`, and for a FILE row
 * `content` is the object-storage key —
 * `tenants/<tenantId>/evidence/<yyyy>/<mm>/<uuid>_<name>`. Searching
 * "evidence", "tenants" or a year therefore returned every uploaded file.
 * `content` is searched only where it is something a user wrote: a note's
 * body or a link's address (`evidenceContentRole` — `note` / `url`).
 *
 * Asserted on the `where` handed to Prisma, as
 * `repositories/list-filter-enum-validation.test.ts` does.
 */
import { EvidenceRepository } from '@/app-layer/repositories/EvidenceRepository';
import { evidenceContentRole } from '@/lib/evidence-content';
import { makeRequestContext } from '../helpers/make-context';

import type { PrismaTx } from '@/lib/db-context';

const ctx = makeRequestContext('ADMIN');

type Branch = Record<string, { contains?: string; mode?: string; in?: string[] }>;

/** The OR branches of the free-text search, as handed to Prisma. */
async function searchBranches(q: string): Promise<Branch[]> {
    const findMany = jest.fn().mockResolvedValue([]);
    await EvidenceRepository.list({ evidence: { findMany } } as unknown as PrismaTx, ctx, { q });
    const where = findMany.mock.calls[0]![0].where as { AND: Array<{ OR?: Branch[] }> };
    const group = where.AND.find((c) => Array.isArray(c.OR));
    return group!.OR!;
}

describe('evidence free-text search', () => {
    it('matches content only on types whose content a user wrote', async () => {
        const branches = await searchBranches('2026');
        const onContent = branches.filter((b) => 'content' in b);
        expect(onContent).toHaveLength(1);
        expect(onContent[0].content).toEqual({ contains: '2026', mode: 'insensitive' });
        expect(onContent[0].type).toEqual({ in: ['TEXT', 'LINK'] });
        // Never FILE — its content is the storage key.
        expect(onContent[0].type.in).not.toContain('FILE');
    });

    it('the content types searched are exactly the ones whose content is not internal', async () => {
        const branches = await searchBranches('x');
        const searched = branches.find((b) => 'content' in b)!.type.in!;
        for (const type of ['FILE', 'LINK', 'TEXT']) {
            expect(searched.includes(type)).toBe(evidenceContentRole(type) !== 'internal');
        }
    });

    it('still matches a file by its title and its file name', async () => {
        const branches = await searchBranches('soc2');
        expect(branches).toEqual(
            expect.arrayContaining([
                { title: { contains: 'soc2', mode: 'insensitive' } },
                { fileName: { contains: 'soc2', mode: 'insensitive' } },
            ]),
        );
    });
});
