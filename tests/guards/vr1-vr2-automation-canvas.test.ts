/**
 * VR-1 + VR-2 — Visual Rule Editor foundation ratchet.
 *
 * Locks the additive foundation: the 4 automation node kinds, the
 * mode-gated palette, the ProcessCanvasMode schema + CanvasModeContext,
 * and canvasMode threading through the process-map create/list path.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
// #2246 Class A — comments are masked at the READ SEAM, so an assertion cannot
// be satisfied by a comment instead of the code it names. Every read in this
// file is TypeScript/TSX, re-derived rather than assumed, so `codeOf` is the
// only masker needed here.
import { codeOf } from '../helpers/source-blocks';

const readRaw = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const read = (p: string) => codeOf(readRaw(p));
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

describe('VR-1/VR-2 — automation canvas foundation', () => {
    it('taxonomy declares the 4 automation kinds + a separate order', () => {
        const src = read('src/components/processes/node-taxonomy.ts');
        for (const k of ['trigger', 'condition', 'action', 'slaGate']) {
            expect(src).toMatch(new RegExp(`'${k}'`));
        }
        expect(src).toMatch(/AUTOMATION_NODE_ORDER/);
        expect(src).toMatch(/isAutomationNodeKind/);
    });

    it('the palette gates the automation section on canvas mode', () => {
        const src = read('src/components/processes/ProcessPalette.tsx');
        expect(src).toMatch(/useIsAutomationMode/);
        expect(src).toMatch(/isAutomation &&/);
        expect(src).toMatch(/AUTOMATION_NODE_ORDER/);
    });

    it('the canvas-mode context exists', () => {
        expect(exists('src/lib/processes/canvas-mode-context.tsx')).toBe(true);
        const src = read('src/lib/processes/canvas-mode-context.tsx');
        expect(src).toMatch(/CanvasModeProvider/);
        expect(src).toMatch(/useIsAutomationMode/);
    });

    it('schema carries ProcessCanvasMode + ProcessMap.canvasMode', () => {
        expect(read('prisma/schema/enums.prisma')).toMatch(/enum ProcessCanvasMode\b/);
        expect(read('prisma/schema/processes.prisma')).toMatch(
            /canvasMode\s+ProcessCanvasMode/,
        );
    });

    it('canvasMode threads through create + list', () => {
        expect(read('src/app-layer/schemas/process-map.ts')).toMatch(/canvasMode/);
        expect(read('src/app-layer/repositories/ProcessMapRepository.ts')).toMatch(
            /canvasMode/,
        );
        // ProcessesClient provides the mode to the canvas
        expect(read('src/app/t/[tenantSlug]/(app)/processes/ProcessesClient.tsx')).toMatch(
            /CanvasModeProvider/,
        );
    });
});
