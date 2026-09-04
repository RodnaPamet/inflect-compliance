import { PrismaTx } from '@/lib/db-context';

export class ControlTemplateRepository {
    static async list(db: PrismaTx) {
        return db.controlTemplate.findMany({
            orderBy: { code: 'asc' },
            include: {
                tasks: { orderBy: { sortOrder: 'asc' } },
                requirementLinks: {
                    include: {
                        requirement: {
                            include: { framework: { select: { name: true } } },
                        },
                    },
                },
                _count: { select: { tasks: true, requirementLinks: true } },
            },
        });
    }

    static async getById(db: PrismaTx, id: string) {
        return db.controlTemplate.findUnique({
            where: { id },
            include: {
                tasks: { orderBy: { sortOrder: 'asc' } },
                requirementLinks: {
                    include: {
                        requirement: {
                            include: { framework: { select: { name: true } } },
                        },
                    },
                },
            },
        });
    }
}
