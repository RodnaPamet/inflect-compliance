/** @jest-environment jsdom */

/**
 * The canvas names node kinds in the reader's language (#5309).
 *
 * The palette's tooltips and accessible names, the label a new step is created
 * with, and the inspector's kind header all read `NODE_TAXONOMY[kind].label`,
 * an English literal — so a Bulgarian reader heard an English noun inside a
 * Bulgarian sentence, and every step they added was stored as "Risk".
 */
import * as React from 'react';
import { render } from '@testing-library/react';

// The Bulgarian catalogue, memoised per namespace. `mock`-prefixed so the
// hoisted factory may read it.
const mockBg: Record<string, unknown> = require('../../messages/bg.json');
jest.mock('next-intl', () => {
    const walk = (root: unknown, path: string) =>
        path.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    const cache = new Map<string, unknown>();
    const make = (ns: string) => {
        const lookup = (key: string) => walk(mockBg, ns ? `${ns}.${key}` : key);
        const t = (key: string, values?: Record<string, unknown>) => {
            const v = lookup(key);
            if (typeof v !== 'string') return key;
            return v.replace(/\{(\w+)\}/g, (m, name) => (values && name in values ? String(values[name]) : m));
        };
        t.rich = t;
        t.has = (key: string) => typeof lookup(key) === 'string';
        return t;
    };
    return {
        useTranslations: (ns = '') => {
            if (!cache.has(ns)) cache.set(ns, make(ns));
            return cache.get(ns);
        },
        useLocale: () => 'bg',
    };
});

import { ProcessPalette } from '@/components/processes/ProcessPalette';
import { ProcessInspector } from '@/components/processes/ProcessInspector';
import { CanvasModeProvider } from '@/lib/processes/canvas-mode-context';

function bg(path: string): string {
    const v = path.split('.').reduce<unknown>(
        (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
        mockBg,
    );
    if (typeof v !== 'string') throw new Error(`no bg message ${path}`);
    return v;
}

describe('node kind labels in Bulgarian', () => {
    it('the palette names each kind, and adds a step under that name', () => {
        const onAdd = jest.fn();
        const { container } = render(
            <CanvasModeProvider mode="DOCUMENT">
                <ProcessPalette onAdd={onAdd} />
            </CanvasModeProvider>,
        );
        const risk = container.querySelector<HTMLButtonElement>('[data-palette-item="risk"]')!;
        const riskBg = bg('automation.palette.kinds.risk');
        expect(risk.getAttribute('title')).toBe(riskBg);
        expect(risk.getAttribute('aria-label')).toContain(riskBg.toLowerCase());
        expect(risk.getAttribute('aria-label')).not.toMatch(/\brisk\b/i);

        risk.click();
        expect(onAdd).toHaveBeenCalledWith('risk', riskBg);
    });

    it('the inspector heads the selected node with its kind in Bulgarian', () => {
        const node = {
            id: 'n1',
            type: 'processStep',
            position: { x: 0, y: 0 },
            data: { label: 'Получаване на поръчка', subtitle: '', kind: 'decision' },
        };
        const { container } = render(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            <ProcessInspector node={node as any} onUpdate={jest.fn()} />,
        );
        expect(container.textContent).toContain(bg('automation.palette.kinds.decision'));
        expect(container.textContent).not.toContain('Decision');
    });
});
