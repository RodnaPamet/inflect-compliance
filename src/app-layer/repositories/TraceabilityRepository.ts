import { PrismaTx } from '@/lib/db-context';
import { CoverageType, ExposureLevel } from '@prisma/client';

/*
 * Every list here hides a link whose FAR side is in the trash (#5376 for a
 * risk's controls; #5442, owner decision 2026-11-12, for the rest). Risk,
 * Control and Asset are all in `SOFT_DELETE_MODELS`; a soft delete keeps the
 * join row, and the soft-delete extension filters top-level reads only, never
 * a relation filter or a nested include — so the predicate has to be here.
 */

export class ControlRiskRepository {
    /** A control's linked risks — the control page's Risks panel. */
    static async listByControl(db: PrismaTx, tenantId: string, controlId: string) {
        return db.riskControl.findMany({
            where: { tenantId, controlId, risk: { deletedAt: null } },
            include: { risk: { select: { id: true, title: true, status: true, score: true, category: true } }, createdBy: { select: { id: true, name: true } } },
            orderBy: { createdAt: 'desc' },
            take: 500, // per-control risk-link panel; a control links to a bounded set of risks
        });
    }

    /**
     * A risk's linked controls — the risk page's traceability panel. A control
     * in the trash keeps its join row and the soft-delete extension does not
     * reach a relation filter, so it is excluded here (#5376, owner decision
     * 2026-11-12: risk pages hide controls in the trash).
     */
    static async listByRisk(db: PrismaTx, tenantId: string, riskId: string) {
        return db.riskControl.findMany({
            where: { tenantId, riskId, control: { deletedAt: null } },
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
    /** An asset's linked controls — the asset page's Controls panel. */
    static async listByAsset(db: PrismaTx, tenantId: string, assetId: string) {
        return db.controlAsset.findMany({
            where: { tenantId, assetId, control: { deletedAt: null } },
            include: { control: { select: { id: true, code: true, name: true, status: true, category: true } }, createdBy: { select: { id: true, name: true } } },
            orderBy: { createdAt: 'desc' },
        });
    }

    /** A control's covered assets — the control page's Assets panel. */
    static async listByControl(db: PrismaTx, tenantId: string, controlId: string) {
        return db.controlAsset.findMany({
            where: { tenantId, controlId, asset: { deletedAt: null } },
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
    /** An asset's linked risks — the asset page's Risks panel. */
    static async listByAsset(db: PrismaTx, tenantId: string, assetId: string) {
        return db.assetRiskLink.findMany({
            where: { tenantId, assetId, risk: { deletedAt: null } },
            include: { risk: { select: { id: true, title: true, status: true, score: true, category: true } }, createdBy: { select: { id: true, name: true } } },
            orderBy: { createdAt: 'desc' },
        });
    }

    /** A risk's linked assets — the risk page's Assets panel. */
    static async listByRisk(db: PrismaTx, tenantId: string, riskId: string) {
        return db.assetRiskLink.findMany({
            where: { tenantId, riskId, asset: { deletedAt: null } },
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
