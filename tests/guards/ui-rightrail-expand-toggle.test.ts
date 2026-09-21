/**
 * UI roadmap 13 — controls Browse right-rail expand toggle.
 *
 * The "Expand all / Collapse all" control is a single chevron toggle:
 * ChevronDown when every section is expanded, ChevronLeft when collapsed.
 * The hint rides a canonical <Tooltip>; the E2E test-id is preserved.
 *
 * Layout revision: the toggle now rides the AsidePanel HEADER (to the left
 * of the panel collapse toggle) via the `headerActions` slot — it is no
 * longer rendered below the header in the rail content.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// Every path this file READS is a TypeScript-alike: the `.json` it touches
// arrives through `require()`, which is a module import, not a text read — so
// it never reaches this seam and needs no separate reader.
import { codeOf } from '../helpers/source-blocks';

const SRC = codeOf(fs.readFileSync(
    path.resolve(__dirname, '../../src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx'),
    'utf8',
));

describe('UI-13 — browse expand toggle is a chevron, not a text button', () => {
    it('renders ChevronDown when expanded and ChevronLeft when collapsed', () => {
        expect(SRC).toMatch(/allExpanded \? <ChevronDown \/> : <ChevronLeft \/>/);
        expect(SRC).toMatch(/ChevronDown,\s*ChevronLeft/);
    });
    it('rides the AsidePanel header via headerActions, not a below-header block', () => {
        // The toggle is now mounted in the panel header (left of the collapse
        // toggle) through the AsidePanel `headerActions` slot.
        expect(SRC).toMatch(/headerActions=\{browseExpandAll\}/);
        expect(SRC).toContain('controls-browse-expand-all');
        // The old below-header, left-aligned wrapper is gone.
        expect(SRC).not.toContain('flex justify-start');
        // The visible button label is no longer the literal text — it's an icon
        // with the hint on aria-label / Tooltip.
        expect(SRC).not.toMatch(/>\s*\{allExpanded \? 'Collapse all' : 'Expand all'\}\s*</);
    });
    it('keeps the canonical Tooltip hint + preserved test-id + aria-label', () => {
        // The hint copy migrated to next-intl; the toggle still branches on
        // allExpanded and the keys resolve to the canonical Collapse/Expand copy.
        expect(SRC).toMatch(/<Tooltip\s+content=\{allExpanded \? t\('list\.collapseAll'\) : t\('list\.expandAll'\)\}/);
        expect(SRC).toMatch(/data-testid="controls-browse-expand-all"/);
        expect(SRC).toMatch(/aria-label=\{allExpanded \? t\('list\.collapseAll'\) : t\('list\.expandAll'\)\}/);
        const en = require('../../messages/en.json') as { controls: { list: Record<string, string> } };
        expect(en.controls.list.collapseAll).toBe('Collapse all');
        expect(en.controls.list.expandAll).toBe('Expand all');
    });
});
