import { PrismaTx } from '@/lib/db-context';

export class FrameworkRepository {
    static async listFrameworks(db: PrismaTx) {
        return db.framework.findMany({
            orderBy: { key: 'asc' },
            include: {
                _count: { select: { requirements: true } },
                packs: { select: { id: true, key: true, name: true, version: true } },
            },
        });
    }

    static async getFrameworkByKey(db: PrismaTx, key: string) {
        return db.framework.findUnique({
            where: { key },
            include: {
                requirements: { orderBy: { sortOrder: 'asc' } },
                packs: {
                    include: {
                        templateLinks: { include: { template: { select: { id: true, code: true, title: true } } } },
                    },
                },
            },
        });
    }

    static async listRequirements(db: PrismaTx, frameworkKey: string) {
        const framework = await db.framework.findUnique({ where: { key: frameworkKey } });
        if (!framework) return null;
        return db.frameworkRequirement.findMany({
            where: { frameworkId: framework.id },
            orderBy: { sortOrder: 'asc' },
            include: { framework: { select: { key: true, name: true } } },
        });
    }

    static async getPackByKey(db: PrismaTx, packKey: string) {
        return db.frameworkPack.findUnique({
            where: { key: packKey },
            include: {
                framework: true,
                templateLinks: {
                    include: {
                        template: {
                            include: {
                                tasks: { orderBy: { sortOrder: 'asc' } },
                                requirementLinks: { include: { requirement: true } },
                            },
                        },
                    },
                },
            },
        });
    }

    static async getCoverage(db: PrismaTx, frameworkKey: string, tenantId: string) {
        const framework = await db.framework.findUnique({ where: { key: frameworkKey } });
        if (!framework) return null;

        const requirements = await db.frameworkRequirement.findMany({
            where: { frameworkId: framework.id },
            orderBy: { sortOrder: 'asc' },
            select: { id: true, code: true, title: true, theme: true, themeNumber: true },
        });

        // Find which requirements have mapped controls for this tenant.
        // Reads the canonical controlRequirementLink table (the framework
        // mapping island is retired) so coverage matches SoA/readiness.
        const mappings = await db.controlRequirementLink.findMany({
            where: {
                tenantId,
                requirement: { frameworkId: framework.id },
            },
            select: { requirementId: true, controlId: true },
        });

        const mappedReqIds = new Set(mappings.map(m => m.requirementId));

        const mapped = requirements.filter(r => mappedReqIds.has(r.id));
        const unmapped = requirements.filter(r => !mappedReqIds.has(r.id));

        return {
            total: requirements.length,
            mappedCount: mapped.length,
            unmappedCount: unmapped.length,
            coveragePercent: requirements.length > 0 ? Math.round((mapped.length / requirements.length) * 100) : 0,
            mapped,
            unmapped,
        };
    }

    // Check if pack is installed for tenant (has controls from pack templates)
    static async isPackInstalled(db: PrismaTx, packKey: string, tenantId: string) {
        const pack = await db.frameworkPack.findUnique({
            where: { key: packKey },
            include: { templateLinks: { include: { template: { select: { code: true } } } } },
        });
        if (!pack) return false;

        const templateCodes = pack.templateLinks.map(l => l.template.code);
        if (templateCodes.length === 0) return false;

        // Check if any controls with matching codes exist for this tenant
        const controlCount = await db.control.count({
            where: { tenantId, code: { in: templateCodes } },
        });

        return controlCount > 0;
    }
}
