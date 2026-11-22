/**
 * Test-double support for `enqueueEmail`'s duplicate-safe insert (#5061).
 *
 * `enqueueEmail` writes with `createMany({ skipDuplicates: true })` and reads
 * the row back by `dedupeKey`, so it never throws a unique violation inside
 * the caller's transaction. Many suites model the outbox as a single `create`
 * mock: one that resolves for a new row and rejects with P2002 for a
 * duplicate. `withSkipDuplicates` keeps that one mock as the source of truth
 * and derives the two methods the code now calls from it, so those suites'
 * assertions on `create` keep meaning what they meant.
 */
type CreateMock = (args: { data: Record<string, unknown> }) => Promise<unknown>;

export function withSkipDuplicates<C extends CreateMock>(create: C) {
    const byKey = new Map<string, { id: string }>();
    return {
        create,
        createMany: async (args: { data: Array<Record<string, unknown>>; skipDuplicates?: boolean }) => {
            let count = 0;
            for (const data of args.data) {
                try {
                    const row = (await create({ data })) as { id?: string } | undefined;
                    count++;
                    if (typeof data.dedupeKey === 'string') {
                        byKey.set(data.dedupeKey, { id: row?.id ?? `outbox-${byKey.size + 1}` });
                    }
                } catch (err) {
                    if (args.skipDuplicates && (err as { code?: unknown }).code === 'P2002') continue;
                    throw err;
                }
            }
            return { count };
        },
        findUnique: async (args: { where: { dedupeKey?: string } }) =>
            (args.where.dedupeKey && byKey.get(args.where.dedupeKey)) ?? null,
    };
}
