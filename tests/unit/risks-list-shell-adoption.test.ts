/**
 * Structural ratchet — Epic 44.4 risks list upgrades.
 *
 * Locks the wiring so a future "tidy-up" can't quietly drop the
 * owner column, the status badges, the band-aware score chip, or
 * the new <RiskMatrix> heatmap engine. Each invariant maps onto a
 * concrete success criterion the prompt asks for.
 *
 * Mirrors the pattern of `controls-client-shell-adoption.test.ts`
 * (Epic 91) — string-scan the source, anchor the contract.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

// next-intl is ESM (jest can't parse its export); mock it to resolve real
// en.json values so the RisksClient render under test yields the original English.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    return {
        useTranslations: (ns: string) => (key: string, params?: Record<string, unknown>) => {
            let v = key
                .split('.')
                .reduce((o: unknown, k) =>
                    o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined, en[ns]);
            if (typeof v !== 'string') return key;
            if (params) for (const [p, val] of Object.entries(params)) v = (v as string).replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
            return v;
        },
        useLocale: () => 'en',
    };
});

const RISKS_CLIENT = path.resolve(
    __dirname,
    '../../src/app/t/[tenantSlug]/(app)/risks/RisksClient.tsx',
);
const RISKS_PAGE = path.resolve(
    __dirname,
    '../../src/app/t/[tenantSlug]/(app)/risks/page.tsx',
);
const RISK_USECASE = path.resolve(
    __dirname,
    '../../src/app-layer/usecases/risk.ts',
);

const clientSrc = readFileSync(RISKS_CLIENT, 'utf8');
// Column headers migrated to next-intl keys; resolve them against the catalog.
const EN_RISKS = JSON.parse(
    readFileSync(path.join(__dirname, '..', '..', 'messages/en.json'), 'utf8'),
).risks as { colHeaders: Record<string, string> };
const pageSrc = readFileSync(RISKS_PAGE, 'utf8');
const usecaseSrc = readFileSync(RISK_USECASE, 'utf8');

describe('Risks list — Epic 44.4 column + matrix wiring', () => {
    it('still uses <DataTable> from the shared platform', () => {
        expect(clientSrc).toMatch(
            /import\s*\{[^}]*\bDataTable\b[^}]*\}\s*from\s*['"]@\/components\/ui\/table['"]/,
        );
    });

    it('preserves the Epic 53 filter context (search + status + ownerUserId + score range)', () => {
        // Filter wiring stays intact — no per-page filter primitives
        // re-introduced.
        expect(clientSrc).toMatch(
            /import\s*\{[^}]*\buseFilterContext\b[^}]*\}\s*from\s*['"]@\/components\/ui\/filter['"]/,
        );
        expect(clientSrc).toMatch(
            /import\s*\{[^}]*\bFilterToolbar\b[^}]*\}\s*from\s*['"]@\/components\/filters\/FilterToolbar['"]/,
        );
        expect(clientSrc).toContain('toApiSearchParams');
        expect(clientSrc).toContain('RISK_API_TRANSFORMS');
    });

    it('adds the Owner column as name-only (ownerDisplayName → treatmentOwner → —, no email)', () => {
        expect(clientSrc).toContain("id: 'owner'");
        expect(clientSrc).toContain("header: tx('colHeaders.owner')");
        expect(EN_RISKS.colHeaders.owner).toBe('Owner');
        // UI-14: name (or email local-part as username) via ownerDisplayName,
        // then the legacy treatmentOwner read path. The full email is NOT
        // displayed (it stays on the row only for the owner filter).
        expect(clientSrc).toMatch(
            /ownerDisplayName\(r\.owner\?\.name,\s*r\.owner\?\.email\)\s*\?\?\s*r\.treatmentOwner/,
        );
        expect(clientSrc).not.toMatch(/r\.owner\?\.email\s*\?\?\s*r\.treatmentOwner/);
    });

    it('adds the workflow Status column with badge classes per RiskStatus value', () => {
        expect(clientSrc).toContain("id: 'status'");
        expect(clientSrc).toContain("header: tx('colHeaders.status')");
        expect(EN_RISKS.colHeaders.status).toBe('Status');
        // B2-3: the local STATUS_CLASS map was deleted — it duplicated
        // RISK_STATUS_VARIANT byte for byte and was declared inside the
        // component body, so it was rebuilt every render.
        expect(clientSrc).toContain('RISK_STATUS_VARIANT');

        // Every RiskStatus member must map to a variant, or the badge
        // renders unstyled. Asserted against the CANONICAL map rather than
        // against this page's source — that is where the mapping now lives,
        // and checking it there also covers the detail page and the PDF
        // exporter, which read the same constant. Strictly stronger than
        // the old per-file string scan.
        const mapping = readFileSync(
            path.resolve(__dirname, '../../src/app-layer/domain/entity-status-mapping.ts'),
            'utf8',
        );
        const variants = mapping.slice(
            mapping.indexOf('RISK_STATUS_VARIANT'),
            mapping.indexOf('};', mapping.indexOf('RISK_STATUS_VARIANT')),
        );
        // Audit S1 (2026-05-24) added MITIGATED to the RiskStatus enum.
        for (const k of ['OPEN', 'MITIGATING', 'MITIGATED', 'ACCEPTED', 'CLOSED']) {
            expect(variants).toContain(`${k}:`);
        }
    });

    it('upgrades the Score column to a band-aware chip from RiskMatrixConfig', () => {
        // The legacy bold-number `<span>` is replaced with a chip
        // styled from the resolved band.
        expect(clientSrc).toContain('resolveBandForScore');
        expect(clientSrc).toContain('matrixConfig.bands');
        // B2-3: the chip markup moved to <RiskBandChip>, shared with the
        // residual column and the assessment panel. What stays here is the
        // WIRING — the score column mounts the chip with a per-row test id.
        // The chip's own contract (band tint, opaque dot, never colouring
        // the TEXT by band — the ~2:1 contrast regression) is asserted by
        // rendering it in tests/rendered/risk-band-chip.test.tsx.
        expect(clientSrc).toMatch(/<RiskBandChip\b/);
        expect(clientSrc).toContain('testId={`risk-score-${row.original.id}`}');
    });

    it('replaces the inline 5×5 heatmap with the <RiskMatrix> engine', () => {
        // The RiskMatrix engine may be imported statically OR lazily via
        // next/dynamic (it's the heatmap-view-only panel, code-split out of
        // the initial chunk — see the perf(bundle) note). Either form counts
        // as "uses the engine".
        const staticImport = /import\s*\{\s*RiskMatrix\s*\}\s*from\s*['"]@\/components\/risks\/RiskMatrix['"]/;
        const dynamicImport = /import\(\s*['"]@\/components\/risks\/RiskMatrix['"]\s*\)/;
        expect(staticImport.test(clientSrc) || dynamicImport.test(clientSrc)).toBe(true);
        expect(clientSrc).toMatch(/<RiskMatrix\b/);
        // Ensures the bespoke gradient classes from the legacy heatmap
        // are gone — they paint colours independent of config and
        // would silently override a tenant's customisation.
        expect(clientSrc).not.toMatch(/bg-emerald-900\/50/);
        expect(clientSrc).not.toMatch(/bg-orange-900\/50/);
    });

    it('feeds the matrix engine sparse cells with risk titles for bubble overlay', () => {
        expect(clientSrc).toContain('matrixCells');
        expect(clientSrc).toMatch(/<RiskMatrix[\s\S]{0,400}cells=\{matrixCells\}/);
        expect(clientSrc).toMatch(/<RiskMatrix[\s\S]{0,400}config=\{matrixConfig\}/);
    });

    it('preserves row navigation to the detail page', () => {
        // Row navigation is a stable `useCallback` handler, not an inline
        // arrow: a fresh `onRowClick` identity per render rebuilds the
        // DataTable model between a row's two clicks and kills double-click
        // navigation. Assert the behaviour (push to the tenant-scoped
        // /risks/ detail route) against the named handler.
        expect(clientSrc).toMatch(/onRowClick=\{handleRiskRowClick\}/);
        expect(clientSrc).toMatch(
            /handleRiskRowClick\s*=\s*useCallback\([\s\S]{0,160}router\.push\(\s*tenantHref\(`\/risks\//,
        );
    });

    it('column visibility config includes status + owner as default-visible columns', () => {
        // R10-PR6 migrated this page to `useColumnsDropdown` — the
        // `defaultVisible` array literal is replaced by per-column
        // records where `defaultVisible: false` opts out (omitted =
        // visible). Lock that status + owner both appear in the
        // column list AND neither carries an explicit
        // `defaultVisible: false`.
        expect(clientSrc).toMatch(/id:\s*['"]status['"]/);
        expect(clientSrc).toMatch(/id:\s*['"]owner['"]/);
        const statusEntry = clientSrc.match(
            /\{\s*id:\s*['"]status['"][^}]*\}/,
        )?.[0] ?? '';
        const ownerEntry = clientSrc.match(
            /\{\s*id:\s*['"]owner['"][^}]*\}/,
        )?.[0] ?? '';
        expect(statusEntry).not.toMatch(/defaultVisible:\s*false/);
        expect(ownerEntry).not.toMatch(/defaultVisible:\s*false/);
    });

    it('server page fetches the matrix config alongside risks and threads it through', () => {
        expect(pageSrc).toContain('getRiskMatrixConfig');
        expect(pageSrc).toMatch(/Promise\.all\(\s*\[\s*listRisks/);
        expect(pageSrc).toContain('matrixConfig={matrixConfig}');
    });

    it('list usecase batch-attaches the owner relation (no per-row N+1)', () => {
        // Single batched user lookup keyed off the unique
        // ownerUserIds in the page of risks. Without this, the page
        // shows '—' for every owner — silently losing operational
        // signal.
        expect(usecaseSrc).toContain('attachOwnerUsers');
        expect(usecaseSrc).toMatch(/db\.user\.findMany/);
        expect(usecaseSrc).toContain('id: { in: ids }');
    });
});
