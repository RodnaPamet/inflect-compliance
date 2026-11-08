/**
 * The built-in risk-template library: every global `RiskTemplate` row the
 * product ships, read from fixtures, and the one function that writes them.
 *
 * Two callers, one writer: `scripts/seed-risk-templates.ts` (production, every
 * container start) and `prisma/seed.ts` (dev and E2E). Until 2026-11-08 the
 * first six sets lived inline in `prisma/seed.ts`, which a deploy never runs,
 * so no deployed database received any of them.
 *
 * Upsert by `id`: a row is created once and brought back to the fixture's
 * content on every run. `RiskTemplate` is global reference data with no edit
 * path in the product (`RiskTemplateRepository` only reads), so the fixture is
 * the source of truth and overwriting is correct. A risk created FROM a template
 * is a copy, so changing a template never changes a tenant's risk.
 */
import type { PrismaClient } from '@prisma/client';

import { fixtureObject } from './fixture-io';

export interface RiskTemplateRow {
    id: string;
    title: string;
    description: string;
    category: string;
    defaultLikelihood: number;
    defaultImpact: number;
    frameworkTag: string | null;
    /** LINDDUN privacy-threat codes (src/lib/privacy/linddun.ts); privacy sets only. */
    linddunCategories?: string[];
}

export interface RiskTemplateFixture {
    templates: RiskTemplateRow[];
}

const load = (name: string, value: unknown): RiskTemplateFixture =>
    fixtureObject<RiskTemplateFixture>(`fixtures/${name}`, value, 'templates');

// `require` with a literal path, so esbuild inlines each fixture into the
// production seeder bundle and the runtime image needs no fixture files.
export const RISK_TEMPLATE_FIXTURES: ReadonlyArray<{ label: string; data: RiskTemplateFixture }> = [
    { label: 'generic', data: load('risk-templates-generic', require('./fixtures/risk-templates-generic.json')) },
    { label: 'privacy', data: load('risk-templates-privacy', require('./fixtures/risk-templates-privacy.json')) },
    { label: 'ssdf', data: load('risk-templates-ssdf', require('./fixtures/risk-templates-ssdf.json')) },
    { label: 'cis', data: load('risk-templates-cis', require('./fixtures/risk-templates-cis.json')) },
    { label: 'asvs', data: load('risk-templates-asvs', require('./fixtures/risk-templates-asvs.json')) },
    { label: 'iso27701', data: load('risk-templates-iso27701', require('./fixtures/risk-templates-iso27701.json')) },
    { label: 'finos-aigf', data: load('risk-templates-finos-aigf', require('./fixtures/risk-templates-finos-aigf.json')) },
];

/** Upsert every built-in risk template. Returns the count written per set. */
export async function seedRiskTemplates(
    db: Pick<PrismaClient, 'riskTemplate'>,
): Promise<Array<{ label: string; count: number }>> {
    const written: Array<{ label: string; count: number }> = [];
    for (const { label, data } of RISK_TEMPLATE_FIXTURES) {
        for (const { id, ...fields } of data.templates) {
            await db.riskTemplate.upsert({
                where: { id },
                create: { id, ...fields },
                update: fields,
            });
        }
        written.push({ label, count: data.templates.length });
    }
    return written;
}
