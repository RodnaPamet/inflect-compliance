/**
 * A tldraw canvas speaks the reader's language, not the browser's (#5924).
 *
 * tldraw takes its interface language from its own user preferences, which
 * default to the browser's language, and ships no Bulgarian: the phone audit
 * found "Menu" in English on the Bulgarian agent view. Mounted on a REAL
 * editor, the view must set tldraw's locale to the product's and render the
 * menu trigger in Bulgarian; an English reader keeps tldraw's English. The
 * translation itself is held to tldraw's own key list and to Bulgarian text.
 */
import { installTldrawJsdomShims } from '../helpers/tldraw-jsdom';

installTldrawJsdomShims();

let mockLocale = 'bg';
jest.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
    useLocale: () => mockLocale,
}));

import path from 'node:path';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Editor } from 'tldraw';

import { AgentCanvasView } from '@/components/processes/agent-view/AgentCanvasView';
import { TLDRAW_BG } from '@/components/processes/tldraw/translation-bg';
import { tldrawLocaleFor } from '@/components/processes/tldraw/reader-language';
import type { AgentCanvasProjection } from '@/lib/agentic/agent-canvas-projection';

const PROJECTION: AgentCanvasProjection = {
    agent: { id: 'a1', name: 'Posture agent', status: 'ACTIVE', autonomyLevel: 2, riskTier: 'LOW', effectiveCeiling: 2 },
    envelope: { grants: [], policyCardVersion: null, breakerState: null, killScope: null },
    profile: { state: 'NONE' } as unknown as AgentCanvasProjection['profile'],
    workflows: [],
    usedIn: [],
};

async function mount(): Promise<Editor> {
    let editor: Editor | undefined;
    await act(async () => {
        render(
            <div style={{ width: 800, height: 600 }}>
                <AgentCanvasView projection={PROJECTION} onEditorReady={(e) => (editor = e)} />
            </div>,
        );
    });
    if (!editor) throw new Error('the view did not finish mounting');
    return editor;
}

afterEach(() => {
    cleanup();
    window.localStorage.clear();
});

describe('the agent canvas in the reader\'s language', () => {
    it('sets tldraw\'s locale to a Bulgarian reader\'s and labels its menu in Bulgarian', async () => {
        mockLocale = 'bg';
        const editor = await mount();
        await waitFor(() => expect(editor.user.getLocale()).toBe('bg'));
        await waitFor(() => expect(screen.getAllByTitle('Меню').length).toBeGreaterThan(0));
        expect(screen.queryByTitle('Menu')).toBeNull();
    });

    it('keeps tldraw\'s own English for an English reader', async () => {
        mockLocale = 'en';
        const editor = await mount();
        await waitFor(() => expect(editor.user.getLocale()).toBe('en'));
        await waitFor(() => expect(screen.getAllByTitle('Menu').length).toBeGreaterThan(0));
    });

    it('maps the product\'s locale to tldraw\'s code', () => {
        expect(tldrawLocaleFor('bg')).toBe('bg');
        expect(tldrawLocaleFor('en-GB')).toBe('en');
    });
});

describe('the Bulgarian tldraw translation', () => {
    it('names only keys tldraw has, and covers the menu the canvases show', () => {
        // The English tldraw renders when a key is missing: every key we
        // translate must be one of its, or the translation answers nothing.
        // Not in tldraw's public exports, so read by path.
        const { DEFAULT_TRANSLATION } = require(
            path.join(process.cwd(), 'node_modules/tldraw/dist-cjs/lib/ui/hooks/useTranslation/defaultTranslation.js'),
        ) as { DEFAULT_TRANSLATION: Record<string, string> };
        const known = new Set(Object.keys(DEFAULT_TRANSLATION));
        expect(Object.keys(TLDRAW_BG).filter((k) => !known.has(k))).toEqual([]);
        for (const key of ['menu.title', 'menu.edit', 'menu.view', 'menu.preferences', 'action.zoom-to-fit', 'action.zoom-in', 'action.zoom-out']) {
            expect(TLDRAW_BG).toHaveProperty([key]);
        }
    });

    it('is Bulgarian: every value is Cyrillic text, a file format, a percentage or a count', () => {
        const notBulgarian = Object.entries(TLDRAW_BG).filter(
            ([, v]) => !/[Ѐ-ӿ]/.test(v as string) && !/^(?:PNG|SVG|\d+%)$/.test(v as string),
        );
        expect(notBulgarian).toEqual([]);
    });
});
