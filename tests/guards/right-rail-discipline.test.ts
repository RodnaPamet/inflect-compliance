/**
 * Roadmap-2 PR-5 — right-rail master-detail discipline.
 *
 * Detail pages used to scroll: hero, tabs, full-bleed body. On
 * desktop the right 25-30% of the viewport was empty. After PR-5,
 * `<EntityDetailLayout>` carries an opt-in `rail` slot that splits
 * the body into main + rail at xl (1280px+) viewports.
 *
 * What this ratchet locks in
 *   1. The shell carries the `rail` prop in its public props
 *      type — the slot is stable, not implicit.
 *   2. The shell renders an `<aside>` with the canonical
 *      `data-testid="entity-detail-rail"` when a rail is provided.
 *      A future "simplify" PR that drops the aside is silently
 *      losing the master-detail composition; the ratchet shouts.
 *   3. The proof-of-pattern adoption — the risks detail page —
 *      still passes a `rail` prop. Removing it returns the page
 *      to single-column flow.
 *
 * What this ratchet does NOT police
 *   The exact rail content (linked tasks, activity, quick actions)
 *   stays under the page's editorial control. The ratchet only
 *   asserts the rail SLOT is filled, not what fills it.
 */
import * as fs from 'fs';
import * as path from 'path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so a guard can no
// longer be satisfied by a COMMENT naming the thing its assertion is about.
//
// LANGUAGE SPLIT. One seam here carries two things. TypeScript-alikes go
// through `read` and are masked. The JSON fixtures go through `readRaw` and
// are NOT: a JSON read is PARSED as data, never matched as text, so masking it
// would only corrupt the parse — `codeOf` lexes TypeScript and a catalogue is
// not that language.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const read = (rel: string) => codeOf(readRaw(rel));
const SHELL_PATH = 'src/components/layout/EntityDetailLayout.tsx';

// Phase 2 — list-page aside slot.
const LIST_SHELL_PATH = 'src/components/layout/ListPageShell.tsx';
const ENTITY_LIST_PAGE_PATH = 'src/components/layout/EntityListPage.tsx';
const SELECTION_PANEL_PATH =
    'src/components/ui/selection-summary-panel.tsx';
const CONTROLS_CLIENT_PATH =
    'src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx';

// Phase 3 — AI assist rail on the risk register.
const ASIDE_PANEL_PATH = 'src/components/ui/aside-panel.tsx';
const AI_RAIL_PATH = 'src/components/ui/ai-assist-rail.tsx';
const RISKS_CLIENT_PATH =
    'src/app/t/[tenantSlug]/(app)/risks/RisksClient.tsx';

describe('Right-rail master-detail discipline (Roadmap-2 PR-5)', () => {
    it('EntityDetailLayout exposes a `rail` prop in its public type', () => {
        const src = read(SHELL_PATH);
        // The slot must be in the exported props interface — not
        // an internal-only field. Future call sites compile-check
        // against the union; a silent removal is a TypeScript
        // error at the call site.
        expect(src).toMatch(/rail\?:\s*ReactNode/);
    });

    it('EntityDetailLayout renders the rail aside with the canonical test-id', () => {
        const src = read(SHELL_PATH);
        // The aside MUST be a real <aside> with a non-empty aria-label so
        // screen readers announce the column distinctly. The label now flows
        // through the catalog (i18n); assert the wiring + that the key still
        // resolves to the canonical English label.
        expect(src).toMatch(
            /<aside[\s\S]*?aria-label=\{t\(['"]table\.context['"]\)\}[\s\S]*?data-testid=["']entity-detail-rail["']/,
        );
        const en = JSON.parse(readRaw('messages/en.json'));
        expect(en.common.table.context).toBe('Context');
    });

    it('the rail layout activates at the xl breakpoint, not at md/lg', () => {
        // xl = 1280px in Tailwind's default scale. Activating
        // master-detail at md (768px) would crowd a tablet
        // viewport; lg (1024px) is the minimum to host a 320px
        // rail comfortably; xl is the editorial choice — it gives
        // the main column the room to breathe at common
        // 1440px laptop widths AND leaves laptops at 1280px with
        // a workable layout.
        //
        // Right-rail Phase 1: the body became a flex row at xl+
        // (was a fixed `grid-cols-[minmax(0,1fr)_320px]` track).
        // `<AsidePanel>` now owns the rail's own width — 320px
        // expanded, 44px collapsed-to-spine — so a fixed grid
        // track would fight the panel's collapse state. The
        // breakpoint stays xl.
        const src = read(SHELL_PATH);
        expect(src).toMatch(/xl:flex-row/);
        expect(src).not.toMatch(
            /md:grid-cols|lg:grid-cols|md:flex-row|lg:flex-row/,
        );
    });

    it('the shell exposes + renders an opt-in right-rail slot', () => {
        // The risks detail page was the original proof-of-pattern
        // adopter, but its Linked-Tasks rail was removed (the panel
        // moved into the Tasks tab). No page adopts the rail today;
        // the capability still lives in the shell, so assert the shell
        // exposes a `rail?` prop and conditionally renders it. A future
        // adopter just passes `rail={…}`.
        const src = read(SHELL_PATH);
        expect(src).toMatch(/\brail\?:\s*ReactNode/);
        expect(src).toMatch(/\{rail\s*\?/);
    });
});

/**
 * Right-rail roadmap, Phase 2 — the list-page `aside` slot.
 *
 * `<ListPageShell.Body>` and `<EntityListPage>` gain an optional
 * `aside` slot for the multi-select selection-summary use case. The
 * canonical content is `<SelectionSummaryPanel>` (count + batch verbs
 * + clear), docked inside an `<AsidePanel>`. This block locks the slot
 * shape, the a11y wrapper, the xl-only docking, and the controls-page
 * proof-of-pattern adoption — same regression-class lock as Phase 1.
 */
describe('Right-rail list-page aside discipline (Phase 2)', () => {
    it('ListPageShell.Body exposes an `aside` slot in its props type', () => {
        const src = read(LIST_SHELL_PATH);
        // The slot is a typed public prop — `ListPageShellBodyProps`
        // — not an implicit pass-through.
        expect(src).toMatch(/aside\?:\s*ReactNode/);
    });

    it('ListPageShell.Body renders the aside as a real <aside> with the canonical test-id', () => {
        const src = read(LIST_SHELL_PATH);
        // a11y: a real <aside aria-label> so the column is announced
        // as a distinct region.
        expect(src).toMatch(
            /<aside[\s\S]*?aria-label=["'][^"']+["'][\s\S]*?data-testid=["']list-page-aside["']/,
        );
    });

    it('the list-page aside docks at xl, never at md/lg', () => {
        // Same editorial breakpoint as the detail-page rail — the
        // body is a flex row only at xl+; below it the aside stacks.
        const src = read(LIST_SHELL_PATH);
        expect(src).toMatch(/xl:flex-row/);
        expect(src).not.toMatch(/md:flex-row|lg:flex-row/);
    });

    it('EntityListPage exposes `aside` and threads it to ListPageShell.Body', () => {
        const src = read(ENTITY_LIST_PAGE_PATH);
        expect(src).toMatch(/aside\?:\s*ReactNode/);
        expect(src).toMatch(/<ListPageShell\.Body\s+aside=\{aside\}/);
    });

    it('SelectionSummaryPanel is the selection-summary rail content primitive', () => {
        const src = read(SELECTION_PANEL_PATH);
        // Count headline + clear affordance are the two invariants of
        // a selection summary; the batch verbs are caller-supplied.
        expect(src).toMatch(/data-testid=["']selection-summary["']/);
        expect(src).toMatch(/data-testid=["']selection-summary-count["']/);
        expect(src).toContain('Clear selection');
    });

    it('controls list page uses the header-row selection bar (B1), keeping the browse/AI rails', () => {
        // The controls selection actions render via the canonical
        // <BulkActionBar> in the DataTable's header-row `selectionControls`
        // slot (the row-select bar that pops over the column-names row),
        // replacing the earlier `batchActions` verbs. The aside slot
        // persists for the browse + AI assist rails; only the SELECTION
        // rail is retired.
        const src = read(CONTROLS_CLIENT_PATH);
        expect(src).toMatch(/<EntityListPage[\s\S]*?\baside=\{/);
        expect(src).not.toContain('<SelectionSummaryPanel');
        expect(src).toMatch(/selectionControls:\s*canEditControls/);
        expect(src).toMatch(/<BulkActionBar\b/);
    });
});

/**
 * Right-rail roadmap, Phase 3 — the AI assist rail.
 *
 * `<AsidePanel>` gains a `defaultCollapsed` prop (a persistent-but-
 * secondary rail starts as a spine, not a 320px land-grab), and
 * `<AiAssistRail>` is the AI co-pilot rail content — a persistent,
 * co-resident entry point to the AI risk-assessment flow, docked on
 * the risk register. This block locks the prop, the primitive, and
 * the risks-page proof-of-pattern adoption.
 */
describe('Right-rail AI assist rail discipline (Phase 3)', () => {
    it('AsidePanel exposes a `defaultCollapsed` prop in its public type', () => {
        const src = read(ASIDE_PANEL_PATH);
        expect(src).toMatch(/defaultCollapsed\?:\s*boolean/);
        // The prop must seed the persisted collapse state — not be an
        // inert field. `useLocalStorage` takes it as the initial value.
        expect(src).toMatch(/useLocalStorage<boolean>\([\s\S]*?defaultCollapsed/);
    });

    it('AiAssistRail is the AI co-pilot rail content primitive', () => {
        const src = read(AI_RAIL_PATH);
        // The rail carries the launch CTA into the AI flow; the page
        // resolves the href, the primitive never builds tenant URLs.
        expect(src).toMatch(/data-testid=["']ai-assist-rail["']/);
        expect(src).toMatch(/data-testid=["']ai-assist-rail-cta["']/);
        expect(src).toMatch(/aiHref/);
    });

    it('risks register passes the AI assist rail (proof-of-pattern adoption)', () => {
        // The risks list is the canonical adopter — the AI co-pilot
        // belongs on the register it suggests risks for. Removing the
        // aside drops the persistent co-pilot surface.
        const src = read(RISKS_CLIENT_PATH);
        expect(src).toMatch(/<ListPageShell\.Body\s+aside=\{/);
        expect(src).toContain('<AiAssistRail');
    });
});

/**
 * Right-rail roadmap, Phase 4 — refinements on `<AsidePanel>`.
 *
 * The fixed-width, UI-only v1 gains two opt-in refinements: a
 * user-resizable docked width (drag handle + keyboard), and a
 * `?aside=<surfaceKey>` deep-link that force-expands a specific rail
 * on arrival. This block locks both — and locks that the collapse
 * state itself never enters the URL (it stays localStorage-only).
 */
describe('Right-rail AsidePanel refinements discipline (Phase 4)', () => {
    it('the docked panel is user-resizable — a real separator handle', () => {
        const src = read(ASIDE_PANEL_PATH);
        expect(src).toMatch(
            /data-testid=["']aside-panel-resize-handle["']/,
        );
        // a11y: a real separator with a value range, draggable AND
        // keyboard-operable.
        expect(src).toMatch(/role=["']separator["']/);
        expect(src).toMatch(/onMouseDown=/);
        expect(src).toMatch(/onKeyDown=/);
    });

    it('the docked width is state-driven + persisted, not a hard-coded class', () => {
        const src = read(ASIDE_PANEL_PATH);
        // Width flows through inline style from state…
        expect(src).toMatch(/style=\{\{\s*width\s*\}\}/);
        // …persisted per surfaceKey…
        expect(src).toMatch(/aside:width:\$\{surfaceKey\}/);
        // …and the old fixed `w-[320px]` track is gone.
        expect(src).not.toMatch(/w-\[320px\]/);
    });

    it('the `?aside` deep-link force-expands by surfaceKey, additively', () => {
        const src = read(ASIDE_PANEL_PATH);
        expect(src).toMatch(/useSearchParams/);
        // The param is matched against this panel's surfaceKey.
        expect(src).toMatch(
            /searchParams\??\.get\(['"]aside['"]\)\s*===\s*surfaceKey/,
        );
    });

    it('collapse state never enters the URL — it stays localStorage-only', () => {
        // The deep-link is one-directional (URL → open). A future
        // change that pushes collapse state INTO the route would make
        // a shared link carry one user's rail preference — banned.
        const src = read(ASIDE_PANEL_PATH);
        expect(src).not.toMatch(/router\.(push|replace)/);
        expect(src).not.toMatch(/useRouter/);
    });
});
