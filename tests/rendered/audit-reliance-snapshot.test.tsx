/**
 * #3681 — how an agent-audit reliance item reads to the external auditor.
 *
 * Driven from the planner's own output, so the view and the snapshot it reads
 * cannot drift apart unseen: a field the planner renames reads as missing here.
 * The two rules the view must not undo are pinned: no concluded review is no
 * rate, in words; and every limit is shown.
 */
import { render, screen } from '@testing-library/react';

jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json');
    const lookup = (ns: string, key: string) =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const make = (ns: string) => (key: string, params?: Record<string, unknown>) => {
        let v = lookup(ns, key);
        if (typeof v !== 'string') return key;
        if (params) for (const [p, val] of Object.entries(params)) {
            v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
        }
        return v;
    };
    return { useTranslations: (ns: string) => make(ns) };
});

import {
    RELIANCE_LIMIT_LABELS,
    RELIANCE_STATE_LABELS,
    RelianceSnapshotBlock,
} from '@/components/audits/RelianceSnapshotBlock';
import {
    RELIANCE_CONTROL_LIMITS,
    RELIANCE_PACK_LIMITS,
    planReliancePack,
    relianceSummaryEntityId,
    type RelianceInput,
    type RelianceWorkpaper,
} from '@/lib/agentic/audit-reliance';
// Loaded untyped: a typed JSON import of the whole catalog is a type the
// checker builds key by key, and two of them exhaust its heap.
const en: unknown = jest.requireActual('../../messages/en.json');
const bg: unknown = jest.requireActual('../../messages/bg.json');

const HEX = 'c'.repeat(64);

function wp(id: string, outcome: 'CONCURRED' | 'DISSENTED' | 'PENDING' | null): RelianceWorkpaper {
    return {
        id,
        procedureId: 'iam.leaver_timeliness',
        catalogueVersion: 1,
        periodLabel: '2026-07',
        populationCount: 4,
        populationDigest: HEX,
        sampleSize: 2,
        exceptionCount: 0,
        conclusion: 'PASS',
        conclusionBasis: 'ALL_SAMPLED_UNITS_PASSED',
        createdAt: new Date('2026-08-02T06:17:00Z'),
        runControlId: 'c_leaver',
        review:
            outcome === null
                ? null
                : {
                      outcome,
                      unassignedReason: null,
                      dissentCodes: outcome === 'DISSENTED' ? ['ATTRIBUTE_NOT_TESTED'] : [],
                      samplePercent: 100,
                      samplingEpoch: 'audit-workpaper-review@2026-07',
                      seedFingerprint: HEX,
                      sampledAt: new Date('2026-08-03T09:40:00Z'),
                      reviewedAt: outcome === 'PENDING' ? null : new Date('2026-08-05T10:00:00Z'),
                  },
    };
}

function snapshots(workpapers: RelianceWorkpaper[]) {
    const input: RelianceInput = {
        cycle: {
            id: 'cyc_1',
            name: 'ISO/IEC 42001 surveillance',
            frameworkKey: 'ISO42001',
            frameworkVersion: '2023',
            periodStartAt: new Date('2026-01-01T00:00:00Z'),
            periodEndAt: new Date('2026-12-31T00:00:00Z'),
        },
        plans: [{ procedureId: 'iam.leaver_timeliness', controlId: 'c_leaver' }],
        controls: new Map([
            [
                'c_leaver',
                { id: 'c_leaver', code: 'A.5.16', annexId: null, name: 'Leaver access', status: 'IMPLEMENTED', mappedRequirementCodes: [] },
            ],
        ]),
        workpapers,
    };
    const plan = planReliancePack(input);
    if (plan.kind !== 'PLAN') throw new Error(plan.reason);
    const byId = new Map(plan.items.map((i) => [i.entityId, JSON.parse(JSON.stringify(i.snapshot))] as const));
    return { control: byId.get('c_leaver'), summary: byId.get(relianceSummaryEntityId('cyc_1')) };
}

describe('a control’s reliance entry', () => {
    it('lists every workpaper with internal audit’s answer, the rate in words and every limit', () => {
        const { control } = snapshots([wp('wp_a', 'CONCURRED'), wp('wp_b', 'DISSENTED'), wp('wp_c', null)]);
        render(<RelianceSnapshotBlock snapshot={control} itemId="item1" />);

        expect(screen.getByTestId('reliance-workpaper-wp_a').textContent).toContain('internal audit: concurred');
        expect(screen.getByTestId('reliance-workpaper-wp_b').textContent).toContain('internal audit: dissented');
        expect(screen.getByTestId('reliance-workpaper-wp_b').textContent).toContain('ATTRIBUTE_NOT_TESTED');
        expect(screen.getByTestId('reliance-workpaper-wp_c').textContent).toContain('internal audit: not drawn');

        expect(screen.getByTestId('reliance-rate-item1').textContent).toContain('Agreement 50%: 1 of 2');
        expect(screen.getByTestId('reliance-limit-DISSENT_RECORDED').textContent).toBe('Internal audit dissented');
        expect(screen.getByTestId('reliance-limit-WORKPAPERS_NOT_DRAWN')).toBeTruthy();
    });

    it('with no concluded review says there is no rate, and shows neither 0% nor 100%', () => {
        const { control } = snapshots([wp('wp_a', 'PENDING')]);
        render(<RelianceSnapshotBlock snapshot={control} itemId="item2" />);
        const rate = screen.getByTestId('reliance-rate-item2').textContent ?? '';
        expect(screen.getByTestId('reliance-no-rate-item2').textContent).toContain('This is not 100% agreement');
        expect(rate).not.toContain('Agreement 100%');
        expect(rate).not.toContain('Agreement 0%');
        expect(screen.getByTestId('reliance-limit-NO_CONCLUDED_REVIEW')).toBeTruthy();
    });
});

describe('the pack’s summary', () => {
    it('states each definition’s population and exclusions, and the catalogue’s standing', () => {
        const { summary } = snapshots([wp('wp_a', 'CONCURRED')]);
        render(<RelianceSnapshotBlock snapshot={summary} itemId="sum" />);
        for (const def of summary.definitions as { id: string; population: string; excludes: string[] }[]) {
            const text = screen.getByTestId(`reliance-definition-${def.id}`).textContent ?? '';
            expect(text).toContain(def.population);
            for (const excluded of def.excludes) expect(text).toContain(excluded);
        }
        expect(screen.getByTestId('reliance-catalogue-sum').textContent).toContain('#3663');
        expect(screen.getByTestId('reliance-limit-CATALOGUE_NOT_APPROVED_BY_INTERNAL_AUDIT')).toBeTruthy();
    });
});

describe('any other pack item', () => {
    it('renders nothing', () => {
        const { container } = render(
            <RelianceSnapshotBlock snapshot={{ code: 'A.5.1', name: 'A control', status: 'IMPLEMENTED' }} itemId="x" />,
        );
        expect(container.innerHTML).toBe('');
    });
});

describe('the vocabulary is the planner’s, labelled in both catalogs', () => {
    const reliance = (catalog: unknown) =>
        (catalog as { external: { auditShare: { reliance: { limit: Record<string, string>; state: Record<string, string> } } } })
            .external.auditShare.reliance;

    it('every limit the planner can write has a label, and no label names a limit it cannot write', () => {
        const planner = new Set<string>([...RELIANCE_CONTROL_LIMITS, ...RELIANCE_PACK_LIMITS]);
        expect([...RELIANCE_LIMIT_LABELS].sort()).toEqual([...planner].sort());
        for (const catalog of [en, bg]) {
            expect(Object.keys(reliance(catalog).limit).sort()).toEqual([...planner].sort());
        }
    });

    it('every sampling state has a label in both catalogs', () => {
        for (const catalog of [en, bg]) {
            expect(Object.keys(reliance(catalog).state).sort()).toEqual([...RELIANCE_STATE_LABELS].sort());
        }
    });
});
