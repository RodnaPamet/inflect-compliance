import { PrismaTx } from '@/lib/db-context';

export class PolicyTemplateRepository {
    static async list(db: PrismaTx) {
        return db.policyTemplate.findMany({
            where: { isGlobal: true },
            orderBy: { title: 'asc' },
        });
    }

    /**
     * `isGlobal` is filtered here as well as in `list()`.
     *
     * Only global templates are offered, so only global templates should be
     * instantiable — but `findUnique({ where: { id } })` accepted ANY row.
     * The id comes from a request body, so a non-global template (one seeded
     * for another purpose, or added later) could be instantiated by id alone
     * without ever appearing in the list. Matching the list's filter keeps
     * "what you can pick" and "what you can use" the same set.
     */
    static async getById(db: PrismaTx, id: string) {
        return db.policyTemplate.findFirst({
            where: { id, isGlobal: true },
        });
    }
}
