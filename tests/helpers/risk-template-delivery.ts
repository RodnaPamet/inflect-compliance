/**
 * Which built-in risk-template sets reach a PRODUCTION database, and with what
 * content.
 *
 * A set counts only when the whole chain holds: `scripts/entrypoint.sh` runs
 * `dist/seed-risk-templates.mjs` on a live (uncommented) line, the worker build
 * bundles `scripts/seed-risk-templates.ts`, that script calls
 * `seedRiskTemplates`, and `RISK_TEMPLATE_FIXTURES` lists the set. Until
 * 2026-11-08 every one of these sets was inline in `prisma/seed.ts`, which a
 * deploy never runs, and the guards that read them there could only say
 * "seeded in dev". Asking this instead makes a green run mean "a customer gets
 * it".
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { RISK_TEMPLATE_FIXTURES, type RiskTemplateRow } from '../../prisma/risk-template-fixtures';
import { codeOf } from './source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Why the production chain is broken, or null when it holds. */
export function riskTemplateDeliveryGap(): string | null {
    const entrypoint = read('scripts/entrypoint.sh')
        .split('\n')
        .filter((l) => !l.trim().startsWith('#'));
    if (!entrypoint.some((l) => l.includes('node dist/seed-risk-templates.mjs'))) {
        return 'scripts/entrypoint.sh does not run dist/seed-risk-templates.mjs';
    }
    if (!codeOf(read('scripts/build-worker.mjs')).includes("entryPoints: ['scripts/seed-risk-templates.ts']")) {
        return 'scripts/build-worker.mjs does not bundle scripts/seed-risk-templates.ts';
    }
    if (!/\bawait seedRiskTemplates\(prisma\)/.test(codeOf(read('scripts/seed-risk-templates.ts')))) {
        return 'scripts/seed-risk-templates.ts does not call seedRiskTemplates';
    }
    return null;
}

/** The templates production receives for one set label, or [] if it receives none. */
export function deliveredRiskTemplates(label: string): RiskTemplateRow[] {
    if (riskTemplateDeliveryGap() !== null) return [];
    return RISK_TEMPLATE_FIXTURES.find((f) => f.label === label)?.data.templates ?? [];
}
