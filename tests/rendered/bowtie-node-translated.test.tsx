/**
 * The bow-tie canvas's event node in the reader's language (#5313). It
 * printed "Score" and "/yr" in English whatever the locale.
 */
import * as React from 'react';
import { render } from '@testing-library/react';

jest.mock('next-intl', () => {
    const bg = require('../../messages/bg.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), bg[ns]);
    return {
        useTranslations: (ns: string) => (key: string, params?: Record<string, unknown>) => {
            let v = resolve(ns, key);
            if (typeof v !== 'string') return key;
            if (params) for (const [p, val] of Object.entries(params)) v = (v as string).split(`{${p}}`).join(String(val));
            return v;
        },
        useLocale: () => 'bg',
    };
});
jest.mock('@xyflow/react', () => ({
    Handle: () => null,
    Position: { Left: 'left', Right: 'right' },
}));
jest.mock('@/lib/tenant-context-provider', () => ({
    useMoneyFormatter: () => (v: number | null | undefined) => (v == null ? '—' : `€${v}`),
}));

import { BowTieNode, BOWTIE_NODE_TYPES } from '@/app/t/[tenantSlug]/(app)/risks/[riskId]/BowTieNode';

const BG = (jest.requireActual('../../messages/bg.json') as { risks: { bowtie: Record<string, string> } }).risks.bowtie;

it('the event node says its score and annual loss in Bulgarian', () => {
    const Node = BowTieNode as unknown as React.ComponentType<Record<string, unknown>>;
    const { container } = render(
        <Node id="e" type={BOWTIE_NODE_TYPES.bowTieEvent} data={{ title: 'Ransomware', score: 12, ale: 5000 }} />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain(BG.nodeScore.replace('{score}', '12'));
    expect(text).toContain(BG.nodeAlePerYear.replace('{amount}', '€5000'));
    expect(text).not.toMatch(/Score|\/yr/);
});
