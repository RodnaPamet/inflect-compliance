import type { Prisma } from '@prisma/client';
import { PrismaTx } from '@/lib/db-context';

/**
 * The template tasks a tenant may see or install: live ones, in authored order.
 *
 * `reconcileTemplateTasks` never deletes a template task, because a tenant may
 * have installed it. A task removed from its source file is DEPRECATED instead,
 * and that is how the generic five retire when authored content replaces them:
 * on production every framework that arrived with the generic five and was
 * authored later still holds them, deprecated, beside the authored tasks.
 *
 * Install already skipped them (`installableTemplateTasks`), but every surface
 * that shows a template's tasks read them all: the framework template browser
 * listed the retired generic tasks next to the authored ones, and the install
 * preview and the control-template list counted them. So an MGF template
 * showed ten tasks, four of them generic, and the preview promised ten while
 * install created six. Every read of a template's tasks takes this, so what is
 * shown and what is installed are the same set.
 */
export const LIVE_TEMPLATE_TASKS = {
    where: { deprecatedAt: null },
    orderBy: { sortOrder: 'asc' },
} as const satisfies Prisma.ControlTemplate$tasksArgs;

export class ControlTemplateRepository {
    static async list(db: PrismaTx) {
        return db.controlTemplate.findMany({
            orderBy: { code: 'asc' },
            include: {
                tasks: LIVE_TEMPLATE_TASKS,
                requirementLinks: {
                    include: {
                        requirement: {
                            include: { framework: { select: { name: true } } },
                        },
                    },
                },
                _count: { select: { tasks: { where: { deprecatedAt: null } }, requirementLinks: true } },
            },
        });
    }

    static async getById(db: PrismaTx, id: string) {
        return db.controlTemplate.findUnique({
            where: { id },
            include: {
                tasks: LIVE_TEMPLATE_TASKS,
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
