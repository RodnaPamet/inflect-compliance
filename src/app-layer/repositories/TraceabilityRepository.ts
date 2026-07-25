import { PrismaTx } from '@/lib/db-context';
import { CoverageType, ExposureLevel } from '@prisma/client';

export class ControlRiskRepository {
    static async listByControl(db: PrismaTx, tenantId: string, controlId: string) {
        return db.riskControl.findMany({
            where: { tenantId, controlId },
            include: { risk: { select: { id: true, title: true, status: true, score: true, category: true } }, createdBy: { select: { id: true, name: true } } },
            orderBy: { createdAt: 'desc' },
            take: 500, // per-control risk-link panel; a control links to a bounded set of risks
        });
    }

    static async listByRisk(db: PrismaTx, tenantId: string, riskId: string) {
        return db.riskControl.findMany({
            where: { tenantId, riskId },
            include: { control: { select: { id: true, code: true, name: true, status: true, category: true } }, createdBy: { select: { id: true, name: true } } },
            orderBy: { createdAt: 'desc' },
        });
    }

    static async link(db: PrismaTx, tenantId: string, controlId: string, riskId: string, rationale: string | null, userId: string) {
        return db.riskControl.create({
            data: { tenantId, controlId, riskId, rationale, createdByUserId: userId },
        });
    }

    static async unlink(db: PrismaTx, tenantId: string, controlId: string, riskId: string) {
        return db.riskControl.delete({
            where: { tenantId_riskId_controlId: { tenantId, riskId, controlId } },
        });
    }
}

export class AssetControlRepository {
    static async listByAsset(db: PrismaTx, tenantId: string, assetId: string) {
        return db.controlAsset.findMany({
            where: { tenantId, assetId },
            include: { control: { select: { id: true, code: true, name: true, status: true, category: true } }, createdBy: { select: { id: true, name: true } } },
            orderBy: { createdAt: 'desc' },
        });
    }

    static async listByControl(db: PrismaTx, tenantId: string, controlId: string) {
        return db.controlAsset.findMany({
            where: { tenantId, controlId },
            include: { asset: { select: { id: true, name: true, type: true, criticality: true, status: true } }, createdBy: { select: { id: true, name: true } } },
            orderBy: { createdAt: 'desc' },
            take: 500, // per-control asset-coverage panel; a control covers a bounded set of assets
        });
    }

    static async link(db: PrismaTx, tenantId: string, assetId: string, controlId: string, coverageType: string | null, rationale: string | null, userId: string) {
        return db.controlAsset.create({
            data: { tenantId, assetId, controlId, coverageType: (coverageType as CoverageType) ?? CoverageType.UNKNOWN, rationale, createdByUserId: userId },
        });
    }

    static async unlink(db: PrismaTx, tenantId: string, assetId: string, controlId: string) {
        return db.controlAsset.delete({
            where: { tenantId_controlId_assetId: { tenantId, controlId, assetId } },
        });
    }
}

export class AssetRiskRepository {
    static async listByAsset(db: PrismaTx, tenantId: string, assetId: string) {
        return db.assetRiskLink.findMany({
            where: { tenantId, assetId },
            include: { risk: { select: { id: true, title: true, status: true, score: true, category: true } }, createdBy: { select: { id: true, name: true } } },
            orderBy: { createdAt: 'desc' },
        });
    }

    static async listByRisk(db: PrismaTx, tenantId: string, riskId: string) {
        return db.assetRiskLink.findMany({
            where: { tenantId, riskId },
            include: { asset: { select: { id: true, name: true, type: true, criticality: true, status: true } }, createdBy: { select: { id: true, name: true } } },
            orderBy: { createdAt: 'desc' },
        });
    }

    static async findLink(db: PrismaTx, tenantId: string, assetId: string, riskId: string) {
        return db.assetRiskLink.findUnique({
            where: { tenantId_assetId_riskId: { tenantId, assetId, riskId } },
        });
    }

    static async link(db: PrismaTx, tenantId: string, assetId: string, riskId: string, exposureLevel: string | null, rationale: string | null, userId: string) {
        return db.assetRiskLink.upsert({
            where: { tenantId_assetId_riskId: { tenantId, assetId, riskId } },
            create: { tenantId, assetId, riskId, exposureLevel: (exposureLevel as ExposureLevel) ?? ExposureLevel.MEDIUM, rationale, createdByUserId: userId },
            update: {
                ...(exposureLevel ? { exposureLevel: exposureLevel as ExposureLevel } : {}),
                ...(rationale !== null ? { rationale } : {}),
            },
        });
    }

    static async unlink(db: PrismaTx, tenantId: string, assetId: string, riskId: string) {
        return db.assetRiskLink.delete({
            where: { tenantId_assetId_riskId: { tenantId, assetId, riskId } },
        });
    }
}
