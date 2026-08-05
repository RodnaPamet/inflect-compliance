/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Onboarding Automation Tests
 *
 * Two complementary layers, both binding to the REAL source module:
 *
 *  1. Pure helpers (`inferAssetType`, `STARTER_RISKS`,
 *     `selectApplicableRisks`) — imported directly, never a local shadow
 *     copy. A shadow copy is exactly what let the `DATASTORE` (vs the
 *     real `DATA_STORE` Prisma enum) asset-type mismatch ship
 *     undetected: the test validated its own copy of the bug.
 *
 *  2. Orchestration (`runStepAction`, `storeActionResult`, Wave C) —
 *     branch-exercised against a mocked tenant-scoped `db`, the mocked
 *     `installPack`, the audit emitter, and the onboarding repo. This is
 *     what lifted the file from 0% branch coverage. Each test names the
 *     branch class it protects.
 */

const mockDbHolder: { db: any } = { db: null };

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(
        async (_ctx: any, fn: (db: any) => any) => fn(mockDbHolder.db),
    ),
}));

jest.mock('@/app-layer/usecases/framework', () => ({
    installPack: jest.fn(),
    resolveFrameworkPackKeys: jest.fn(),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

jest.mock('@/app-layer/repositories/OnboardingRepository', () => ({
    OnboardingRepository: {
        getByTenantId: jest.fn(),
        saveStepData: jest.fn(),
    },
}));

import { AssetType } from '@prisma/client';
import { installPack, resolveFrameworkPackKeys } from '@/app-layer/usecases/framework';
import { logEvent } from '@/app-layer/events/audit';
import { OnboardingRepository } from '@/app-layer/repositories/OnboardingRepository';
import {
    inferAssetType,
    selectApplicableRisks,
    STARTER_RISKS,
    runStepAction,
    storeActionResult,
} from '@/app-layer/usecases/onboarding-automation';
import { makeRequestContext } from '../helpers/make-context';

const VALID_ASSET_TYPES = new Set<string>(Object.values(AssetType));

// ─── 1. Pure helpers (real-symbol binding) ───

describe('Onboarding Automation', () => {
    describe('Asset Type Inference', () => {
        it('infers APPLICATION for app-like names', () => {
            expect(inferAssetType('Customer Portal')).toBe('APPLICATION');
            expect(inferAssetType('Mobile App')).toBe('APPLICATION');
            expect(inferAssetType('Internal API')).toBe('APPLICATION');
            expect(inferAssetType('SaaS Platform')).toBe('APPLICATION');
        });

        it('infers DATA_STORE for data-like names', () => {
            expect(inferAssetType('Customer Database')).toBe('DATA_STORE');
            expect(inferAssetType('Data Warehouse')).toBe('DATA_STORE');
            expect(inferAssetType('Backup Storage')).toBe('DATA_STORE');
        });

        it('infers INFRASTRUCTURE for infra-like names', () => {
            expect(inferAssetType('Cloud Infrastructure')).toBe('INFRASTRUCTURE');
            expect(inferAssetType('Production Server')).toBe('INFRASTRUCTURE');
            expect(inferAssetType('AWS VPC')).toBe('INFRASTRUCTURE');
            expect(inferAssetType('Kubernetes Cluster')).toBe('INFRASTRUCTURE');
        });

        it('infers VENDOR for vendor-like names', () => {
            expect(inferAssetType('Payment Vendor')).toBe('VENDOR');
            expect(inferAssetType('Third-Party Processor')).toBe('VENDOR');
        });

        it('infers PROCESS for process-like names', () => {
            expect(inferAssetType('HR Onboarding Process')).toBe('PROCESS');
            expect(inferAssetType('Finance Workflows')).toBe('PROCESS');
        });

        it('defaults to APPLICATION for unknown names', () => {
            expect(inferAssetType('CRM')).toBe('APPLICATION');
            expect(inferAssetType('Something Else')).toBe('APPLICATION');
        });

        it('only ever returns values that exist in the Prisma AssetType enum', () => {
            // Regression guard for the DATASTORE→DATA_STORE bug: a value that
            // is not a real enum member would be rejected by Prisma at
            // asset-create time. Cover every keyword bucket + the default.
            const names = [
                'Mobile App', 'Customer Database', 'Backup Storage', 'Data Warehouse',
                'Cloud Infrastructure', 'AWS VPC', 'Payment Vendor', 'HR Onboarding Process',
                'CRM', 'Totally Unknown Thing',
            ];
            for (const name of names) {
                expect(VALID_ASSET_TYPES.has(inferAssetType(name))).toBe(true);
            }
        });
    });

    describe('Risk Catalog Selection', () => {
        it('returns APPLICATION risks for iso27001 with app assets', () => {
            const risks = selectApplicableRisks(['iso27001'], new Set([AssetType.APPLICATION]));
            expect(risks.some(r => r.title === 'Unauthorized Access to Application')).toBe(true);
            expect(risks.some(r => r.title === 'Application Vulnerability Exploitation')).toBe(true);
            // General risks should also be included
            expect(risks.some(r => r.title === 'Regulatory Non-Compliance')).toBe(true);
        });

        it('returns DATA_STORE risks for nis2 with data assets', () => {
            const risks = selectApplicableRisks(['nis2'], new Set([AssetType.DATA_STORE]));
            expect(risks.some(r => r.title === 'Data Backup Failure')).toBe(true);
            expect(risks.some(r => r.title === 'Data Confidentiality Breach')).toBe(true);
            // iso27001-only risks should NOT be included
            expect(risks.some(r => r.title === 'Data Integrity Compromise')).toBe(false);
        });

        it('returns VENDOR risks for nis2 with vendor assets', () => {
            const risks = selectApplicableRisks(['nis2'], new Set([AssetType.VENDOR]));
            expect(risks.some(r => r.title === 'Supply Chain Dependency Risk')).toBe(true);
            expect(risks.some(r => r.title === 'Third-Party Data Processing Risk')).toBe(true);
        });

        it('returns comprehensive risks for both frameworks + multiple asset types', () => {
            const risks = selectApplicableRisks(['iso27001', 'nis2'], new Set([AssetType.APPLICATION, AssetType.DATA_STORE, AssetType.INFRASTRUCTURE]));
            // Should include all asset-specific risks plus generals
            expect(risks.length).toBeGreaterThanOrEqual(10);
            expect(risks.some(r => r.title === 'Unauthorized Access to Application')).toBe(true);
            expect(risks.some(r => r.title === 'Data Backup Failure')).toBe(true);
            expect(risks.some(r => r.title === 'Network Perimeter Breach')).toBe(true);
            expect(risks.some(r => r.title === 'Regulatory Non-Compliance')).toBe(true);
        });

        it('excludes risks for unselected asset types', () => {
            const risks = selectApplicableRisks(['iso27001'], new Set([AssetType.APPLICATION]));
            // Should NOT include DATA_STORE, INFRASTRUCTURE, VENDOR, PROCESS risks
            expect(risks.some(r => r.title === 'Data Backup Failure')).toBe(false);
            expect(risks.some(r => r.title === 'Network Perimeter Breach')).toBe(false);
            expect(risks.some(r => r.title === 'Third-Party Data Processing Risk')).toBe(false);
        });

        it('selection is deterministic — same inputs always produce same outputs', () => {
            const run1 = selectApplicableRisks(['iso27001'], new Set([AssetType.APPLICATION]));
            const run2 = selectApplicableRisks(['iso27001'], new Set([AssetType.APPLICATION]));
            expect(run1.map(r => r.title)).toEqual(run2.map(r => r.title));
        });
    });

    describe('Risk Catalog Properties', () => {
        it('all risks have unique titles', () => {
            const titles = STARTER_RISKS.map(r => r.title);
            expect(new Set(titles).size).toBe(titles.length);
        });

        it('all risks reference at least one framework', () => {
            for (const risk of STARTER_RISKS) {
                expect(risk.frameworks.length).toBeGreaterThan(0);
            }
        });

        it('total catalog has 15 risks', () => {
            expect(STARTER_RISKS.length).toBe(15);
        });

        it('every catalog assetType is a real Prisma AssetType enum member', () => {
            // Catalog drift guard: a stray value like the old `DATASTORE`
            // would never match an inferred type and would corrupt risk
            // seeding silently. Bind the catalog to the enum.
            for (const risk of STARTER_RISKS) {
                for (const at of risk.assetTypes) {
                    expect(VALID_ASSET_TYPES.has(at)).toBe(true);
                }
            }
        });
    });
});

// ─── 2. Orchestration (Wave C — runStepAction / storeActionResult) ───

const ctx = makeRequestContext('ADMIN');

/** A fresh in-memory db whose finders default to "nothing exists yet". */
function freshDb() {
    return {
        asset: {
            findFirst: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({}),
        },
        risk: {
            findFirst: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({}),
        },
        // Onboarding-seeded risks go through `RiskRepository.create`, which
        // mints the per-tenant `RSK-N` key off this counter before inserting.
        // The previous bare `db.risk.create` skipped it — which is why every
        // onboarding risk landed with `key = NULL` and a blank Code column.
        riskKeySequence: {
            upsert: jest.fn().mockResolvedValue({ tenantId: 't1', lastValue: 1 }),
        },
        task: {
            findFirst: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({}),
        },
        tenant: {
            findUnique: jest.fn().mockResolvedValue({ maxRiskScale: 5 }),
        },
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDbHolder.db = freshDb();
    (installPack as jest.Mock).mockResolvedValue({ controlsCreated: 3, tasksCreated: 2 });
    // Default catalog: the two seeded baseline packs, resolved case-insensitively
    // and keyed by the lowercased framework key (mirrors resolveFrameworkPackKeys).
    (resolveFrameworkPackKeys as jest.Mock).mockImplementation(async (_ctx: unknown, keys: string[]) => {
        const catalog: Record<string, string[]> = {
            iso27001: ['ISO27001_2022_BASE'],
            nis2: ['NIS2_BASELINE'],
        };
        const grouped = new Map<string, string[]>();
        for (const k of keys) {
            const lk = k.toLowerCase();
            if (catalog[lk]) grouped.set(lk, catalog[lk]);
        }
        return grouped;
    });
});

describe('runStepAction routing', () => {
    it('returns null for steps with no automation (COMPANY_PROFILE, REVIEW_AND_FINISH, unknown)', async () => {
        // Branch: switch default arm.
        expect(await runStepAction(ctx, 'COMPANY_PROFILE', {}, {})).toBeNull();
        expect(await runStepAction(ctx, 'REVIEW_AND_FINISH', {}, {})).toBeNull();
        expect(await runStepAction(ctx, 'SOMETHING_ELSE', {}, {})).toBeNull();
    });

    it('routes FRAMEWORK_SELECTION → framework install', async () => {
        const r = await runStepAction(ctx, 'FRAMEWORK_SELECTION', {}, {
            FRAMEWORK_SELECTION: { selectedFrameworks: ['iso27001'] },
        });
        expect(r?.action).toBe('FRAMEWORK_INSTALL');
        // Resolved from the catalog (case-insensitive) to the real pack key.
        expect(installPack).toHaveBeenCalledWith(ctx, 'ISO27001_2022_BASE');
    });
});

describe('executeFrameworkInstall', () => {
    it('installs each selected framework\'s packs and aggregates controls created', async () => {
        const r = await runStepAction(ctx, 'FRAMEWORK_SELECTION', {}, {
            FRAMEWORK_SELECTION: { selectedFrameworks: ['iso27001', 'nis2'] },
        });
        // Both packs resolve from the catalog → installPack succeeds twice.
        expect(r?.created).toBe(6); // 3 + 3
        expect(r?.skipped).toBe(0);
        expect(installPack).toHaveBeenCalledTimes(2);
    });

    it('matches canonical DB keys too (picker now stores uppercase)', async () => {
        const r = await runStepAction(ctx, 'FRAMEWORK_SELECTION', {}, {
            FRAMEWORK_SELECTION: { selectedFrameworks: ['ISO27001', 'NIS2'] },
        });
        expect(r?.created).toBe(6);
        expect(r?.skipped).toBe(0);
        expect(installPack).toHaveBeenCalledTimes(2);
    });

    it('skips frameworks with no pack in the catalog', async () => {
        const r = await runStepAction(ctx, 'FRAMEWORK_SELECTION', {}, {
            FRAMEWORK_SELECTION: { selectedFrameworks: ['unknown-fw'] },
        });
        // Branch: no pack grouped for this framework → details push + skipped++.
        expect(r?.created).toBe(0);
        expect(r?.skipped).toBe(1);
        expect(r?.details).toContain('no installable pack in catalog');
        expect(installPack).not.toHaveBeenCalled();
    });

    it('counts a framework as skipped when installPack throws', async () => {
        (installPack as jest.Mock).mockRejectedValueOnce(new Error('boom'));
        const r = await runStepAction(ctx, 'FRAMEWORK_SELECTION', {}, {
            FRAMEWORK_SELECTION: { selectedFrameworks: ['iso27001'] },
        });
        // Branch: try/catch around installPack.
        expect(r?.created).toBe(0);
        expect(r?.skipped).toBe(1);
        expect(r?.details).toContain('install failed');
    });

    it('handles a missing FRAMEWORK_SELECTION payload (defaults to empty list)', async () => {
        const r = await runStepAction(ctx, 'FRAMEWORK_SELECTION', {}, {});
        // Branch: `allData['FRAMEWORK_SELECTION']?.selectedFrameworks || []`.
        expect(r?.created).toBe(0);
        expect(r?.skipped).toBe(0);
    });
});

describe('executeAssetCreation + inferAssetType (orchestrated)', () => {
    it('creates new assets, infers types per keyword, and emits an audit event', async () => {
        const db = mockDbHolder.db;
        const r = await runStepAction(ctx, 'ASSET_SETUP', {}, {
            ASSET_SETUP: {
                assets: [
                    'Customer Portal',   // APPLICATION (portal)
                    'Postgres Database',  // DATA_STORE (database)
                    'AWS Cluster',        // INFRASTRUCTURE (aws/cluster)
                    'Payroll Vendor',     // VENDOR (vendor)
                    'HR Workflow',        // PROCESS (workflow/hr)
                    'Zphqx Thing',        // default → APPLICATION (no keyword)
                ],
            },
        });
        expect(r?.created).toBe(6);
        expect(r?.skipped).toBe(0);
        // Branch: inferAssetType keyword arms + default (real Prisma enum values).
        const types = db.asset.create.mock.calls.map((c: any) => c[0].data.type);
        expect(types).toEqual([
            'APPLICATION', 'DATA_STORE', 'INFRASTRUCTURE', 'VENDOR', 'PROCESS', 'APPLICATION',
        ]);
        // Branch: created > 0 → logEvent emitted.
        expect(logEvent).toHaveBeenCalledTimes(1);
        expect((logEvent as jest.Mock).mock.calls[0][2].action).toBe('ONBOARDING_ASSETS_CREATED');
    });

    it('skips assets that already exist and does NOT emit an audit event when nothing created', async () => {
        const db = mockDbHolder.db;
        db.asset.findFirst.mockResolvedValue({ id: 'existing' });
        const r = await runStepAction(ctx, 'ASSET_SETUP', {}, {
            ASSET_SETUP: { assets: ['Customer Portal'] },
        });
        // Branch: existing → skipped++, create not called.
        expect(r?.created).toBe(0);
        expect(r?.skipped).toBe(1);
        expect(db.asset.create).not.toHaveBeenCalled();
        // Branch: created === 0 → no logEvent.
        expect(logEvent).not.toHaveBeenCalled();
    });

    it('defaults to an empty asset list when ASSET_SETUP payload is absent', async () => {
        const r = await runStepAction(ctx, 'ASSET_SETUP', {}, {});
        // Branch: `allData['ASSET_SETUP']?.assets || []`.
        expect(r?.created).toBe(0);
        expect(r?.skipped).toBe(0);
    });
});

describe('executeControlInstall', () => {
    it('no-ops when the user did not confirm', async () => {
        const r = await runStepAction(ctx, 'CONTROL_BASELINE_INSTALL', {}, {
            CONTROL_BASELINE_INSTALL: { confirmed: false },
        });
        // Branch: !confirmed early return.
        expect(r?.action).toBe('CONTROL_INSTALL');
        expect(r?.details).toContain('did not confirm');
        expect(installPack).not.toHaveBeenCalled();
    });

    it('re-runs framework install when confirmed', async () => {
        const r = await runStepAction(ctx, 'CONTROL_BASELINE_INSTALL', {}, {
            CONTROL_BASELINE_INSTALL: { confirmed: true },
            FRAMEWORK_SELECTION: { selectedFrameworks: ['iso27001'] },
        });
        // Branch: confirmed → delegates to executeFrameworkInstall.
        expect(r?.action).toBe('FRAMEWORK_INSTALL');
        expect(installPack).toHaveBeenCalledTimes(1);
    });
});

describe('executeRiskGeneration', () => {
    it('opts out when generate === false', async () => {
        const r = await runStepAction(ctx, 'INITIAL_RISK_REGISTER', {}, {
            INITIAL_RISK_REGISTER: { generate: false },
        });
        // Branch: generate === false early return.
        expect(r?.created).toBe(0);
        expect(r?.details).toContain('opted out');
        expect(mockDbHolder.db.risk.create).not.toHaveBeenCalled();
    });

    it('generates framework+assetType-applicable risks and audits them', async () => {
        const db = mockDbHolder.db;
        const r = await runStepAction(ctx, 'INITIAL_RISK_REGISTER', {}, {
            FRAMEWORK_SELECTION: { selectedFrameworks: ['iso27001'] },
            ASSET_SETUP: { assets: ['Customer Portal'] }, // APPLICATION
        });
        // Branch: fwMatch && typeMatch filter selects a subset.
        expect(r?.created).toBeGreaterThan(0);
        expect(db.risk.create).toHaveBeenCalled();
        const titles = db.risk.create.mock.calls.map((c: any) => c[0].data.title);
        // A general (assetTypes:[]) iso27001 risk must be present.
        expect(titles).toContain('Regulatory Non-Compliance');
        // An APPLICATION risk must be present; a DATA_STORE-only risk must not.
        expect(titles).toContain('Unauthorized Access to Application');
        expect(titles).not.toContain('Data Backup Failure');
        // Score is computed from likelihood/impact/maxScale (Math.round path).
        const appRisk = db.risk.create.mock.calls.find((c: any) => c[0].data.title === 'Unauthorized Access to Application');
        expect(appRisk[0].data.score).toBe(appRisk[0].data.inherentScore);
        // Branch: created > 0 → logEvent.
        expect((logEvent as jest.Mock).mock.calls.some((c: any) => c[2].action === 'ONBOARDING_RISKS_GENERATED')).toBe(true);
    });

    it('falls back to APPLICATION risks when no assets are provided', async () => {
        const db = mockDbHolder.db;
        await runStepAction(ctx, 'INITIAL_RISK_REGISTER', {}, {
            FRAMEWORK_SELECTION: { selectedFrameworks: ['iso27001'] },
        });
        // Branch: assetTypes.size === 0 → add('APPLICATION').
        const titles = db.risk.create.mock.calls.map((c: any) => c[0].data.title);
        expect(titles).toContain('Unauthorized Access to Application');
    });

    it('uses default maxRiskScale (5) when tenant row is missing and skips existing risks', async () => {
        const db = mockDbHolder.db;
        db.tenant.findUnique.mockResolvedValue(null); // Branch: tenant?.maxRiskScale || 5
        db.risk.findFirst.mockResolvedValue({ id: 'existing' }); // Branch: existing → skip
        const r = await runStepAction(ctx, 'INITIAL_RISK_REGISTER', {}, {
            FRAMEWORK_SELECTION: { selectedFrameworks: ['iso27001'] },
        });
        expect(r?.created).toBe(0);
        expect(r?.skipped).toBeGreaterThan(0);
        expect(db.risk.create).not.toHaveBeenCalled();
        // Branch: created === 0 → no risk-generation audit.
        expect((logEvent as jest.Mock).mock.calls.some((c: any) => c[2]?.action === 'ONBOARDING_RISKS_GENERATED')).toBe(false);
    });
});

describe('executeTeamSetup', () => {
    it('creates the five starter tasks and audits', async () => {
        const db = mockDbHolder.db;
        const r = await runStepAction(ctx, 'TEAM_SETUP', {}, {});
        expect(r?.created).toBe(5);
        expect(db.task.create).toHaveBeenCalledTimes(5);
        expect((logEvent as jest.Mock).mock.calls[0][2].action).toBe('ONBOARDING_TASKS_CREATED');
    });

    it('skips starter tasks that already exist and emits no audit when none created', async () => {
        const db = mockDbHolder.db;
        db.task.findFirst.mockResolvedValue({ id: 'existing' });
        const r = await runStepAction(ctx, 'TEAM_SETUP', {}, {});
        // Branch: existing → skip; created === 0 → no logEvent.
        expect(r?.created).toBe(0);
        expect(r?.skipped).toBe(5);
        expect(db.task.create).not.toHaveBeenCalled();
        expect(logEvent).not.toHaveBeenCalled();
    });
});

describe('storeActionResult', () => {
    it('returns early when there is no onboarding row', async () => {
        (OnboardingRepository.getByTenantId as jest.Mock).mockResolvedValue(null);
        await storeActionResult(ctx, 'ASSET_SETUP', { action: 'X', created: 1, skipped: 0, details: '' });
        // Branch: !existing → return before save.
        expect(OnboardingRepository.saveStepData).not.toHaveBeenCalled();
    });

    it('merges the result under _actionResults and persists', async () => {
        (OnboardingRepository.getByTenantId as jest.Mock).mockResolvedValue({
            stepData: { _actionResults: { PRIOR: { action: 'PRIOR' } } },
        });
        const result = { action: 'ASSET_CREATION', created: 2, skipped: 0, details: 'd' };
        await storeActionResult(ctx, 'ASSET_SETUP', result);
        expect(OnboardingRepository.saveStepData).toHaveBeenCalledTimes(1);
        const [, , key, payload] = (OnboardingRepository.saveStepData as jest.Mock).mock.calls[0];
        expect(key).toBe('_actionResults');
        // Branch: prior results preserved + new step merged.
        expect(payload.PRIOR).toEqual({ action: 'PRIOR' });
        expect(payload.ASSET_SETUP).toEqual(result);
    });

    it('tolerates a row with no prior stepData (defaults applied)', async () => {
        (OnboardingRepository.getByTenantId as jest.Mock).mockResolvedValue({ stepData: null });
        await storeActionResult(ctx, 'TEAM_SETUP', { action: 'T', created: 0, skipped: 5, details: '' });
        // Branch: `(existing.stepData as any) || {}` and `currentData._actionResults || {}`.
        const [, , key, payload] = (OnboardingRepository.saveStepData as jest.Mock).mock.calls[0];
        expect(key).toBe('_actionResults');
        expect(payload.TEAM_SETUP.action).toBe('T');
    });
});
