/**
 * Roadmap-5 PR-4 — shadow discipline.
 *
 * The Card primitive's docstring is explicit: "Premium products
 * (Linear, Stripe, Vercel) express depth through background-tone
 * changes on dark surfaces, not via box-shadow. Shadows on glass
 * / blurred surfaces look uncertain; tone-based elevation reads
 * as deliberate and quiet."
 *
 * The codebase agreed in spirit. In practice, 16 shadow-* uses
 * shipped across the product. Most were legitimate (floating
 * overlays + moving elements + notifications), but two static
 * page-level surfaces had absorbed shadows by accident:
 *
 *   • `<FileUpload variant="default">` carried `shadow-sm` on
 *     the dropzone card itself — depth on a static surface.
 *   • `<FileUpload>`'s sr-only file input wrapper had a
 *     `shadow-sm` it could never render (sr-only hides it).
 *
 * Both stripped in this PR.
 *
 * What this ratchet locks
 *
 *   `shadow-{sm|md|lg|xl|2xl}` and `drop-shadow-*` may only
 *   appear in the documented allowlist below. Each entry has a
 *   written reason matching the surface's role:
 *
 *     - Floating overlay primitives (Modal, Sheet, Popover,
 *       Tooltip, Command palette, Undo toast).
 *     - Chart / graph tooltips that float above the canvas.
 *     - Hand-rolled overlay menus or toasts (admin/members
 *       overflow menu, controls/[controlId] success toast).
 *     - Moving primitives whose depth communicates state
 *       (Switch thumb).
 *
 * Static page surfaces (cards, banners, form chrome, dropzones)
 * MUST express depth through bg-tone tokens, never `shadow-*`.
 * The Card primitive's `elevation` axis provides the canonical
 * surface-tone ladder (`flat / inset / raised / floating`).
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

interface AllowlistEntry {
    file: string;
    reason: string;
}

const ALLOWLIST: AllowlistEntry[] = [
    {
        file: 'src/components/ui/modal.tsx',
        reason: 'Modal floats above the page; shadow communicates lift.',
    },
    {
        file: 'src/components/ui/sheet.tsx',
        reason: 'Sheet floats above the page; shadow communicates lift.',
    },
    {
        file: 'src/components/ui/popover.tsx',
        reason: 'Popover is a floating overlay — drop-shadow + shadow paint the lift.',
    },
    {
        file: 'src/components/ui/tooltip.tsx',
        reason: 'Tooltip is a floating overlay; shadow communicates lift.',
    },
    {
        file: 'src/components/layout/session-expired-notice.tsx',
        reason:
            'The expired-session banner is `fixed inset-x-0 top-0 z-[100]` — it '
            + 'floats over whatever page the user was on rather than sitting in '
            + 'the document flow, which is the overlay case this rule carves out. '
            + 'It also has to read as interrupting: it is the only signal that a '
            + 'surface has stopped updating, and the elevation axis on Card would '
            + 'put it in the page rather than over it.',
    },
    {
        file: 'src/components/command-palette/command-palette.tsx',
        reason: 'Command palette is a floating modal-like overlay; shadow-2xl communicates the topmost lift.',
    },
    {
        file: 'src/components/processes/CanvasCommandPalette.tsx',
        reason: 'R31 Bundle 8 — canvas-local command palette inherits the same shadow-2xl lift as the app-wide palette. Floating dialog over the canvas plane needs the same topmost emphasis.',
    },
    {
        file: 'src/components/ui/undo-toast.tsx',
        reason: 'Undo toast is a floating notification; shadow communicates lift.',
    },
    {
        file: 'src/components/ui/switch.tsx',
        reason: 'Switch thumb shadow communicates depth on the moving element — sliding without depth reads as flat.',
    },
    {
        file: 'src/components/ui/charts/interaction.tsx',
        reason: 'Chart tooltip floats above the chart canvas; shadow communicates lift.',
    },
    {
        file: 'src/components/ui/charts/funnel-chart.tsx',
        reason: 'Funnel chart tooltip floats above the canvas; shadow communicates lift.',
    },
    {
        file: 'src/components/ui/GraphExplorer.tsx',
        reason: 'Graph node tooltips and the centred overlay banner float above the graph canvas.',
    },
    {
        file: 'src/app/t/[tenantSlug]/(app)/admin/members/page.tsx',
        reason: 'Hand-rolled overflow menu floats above the row; shadow communicates lift. Future PR may migrate to Popover.',
    },
    {
        file: 'src/app/t/[tenantSlug]/(app)/controls/[controlId]/page.tsx',
        reason: 'Inline success toast floats above the page; shadow communicates lift. Future PR may migrate to canonical Toast.',
    },
];

const ALLOWED = new Set(ALLOWLIST.map((e) => e.file));
const SHADOW_RE = /\b(?:shadow|drop-shadow)-(sm|md|lg|xl|2xl)\b/;

interface Offence {
    file: string;
    line: number;
    snippet: string;
}

describe('Shadow discipline (Roadmap-5 PR-4)', () => {
    it('every allowlisted file still exists', () => {
        const stale: string[] = [];
        for (const e of ALLOWLIST) {
            if (!fs.existsSync(path.join(ROOT, e.file))) stale.push(e.file);
        }
        if (stale.length > 0) {
            throw new Error(
                `Allowlist entries no longer reference real files:\n  ${stale.join('\n  ')}`,
            );
        }
        expect(stale).toEqual([]);
    });

    it('no .tsx file under src/ uses shadow-* outside the allowlist', () => {
        const offenders: Offence[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) {
                    if (e.name === 'node_modules' || e.name === '.next')
                        continue;
                    walk(full);
                    continue;
                }
                if (!/\.tsx$/.test(e.name)) continue;
                const rel = path.relative(ROOT, full);
                if (ALLOWED.has(rel)) continue;
                const raw = fs.readFileSync(full, 'utf-8');
                const stripped = raw
                    .replace(/\/\*[\s\S]*?\*\//g, '')
                    .replace(/\/\/[^\n]*/g, '');
                const lines = stripped.split('\n');
                lines.forEach((line, i) => {
                    if (SHADOW_RE.test(line)) {
                        offenders.push({
                            file: rel,
                            line: i + 1,
                            snippet: line.trim().slice(0, 200),
                        });
                    }
                });
            }
        };
        walk(path.join(ROOT, 'src'));
        if (offenders.length > 0) {
            const lines = offenders
                .map((o) => `  ${o.file}:${o.line}\n    ${o.snippet}`)
                .join('\n');
            throw new Error(
                `Shadow-* used on a static page surface. Premium products express depth through background tone, not box-shadow. Use the Card primitive's elevation axis (flat / inset / raised / floating) instead. If the surface is a legitimate floating overlay, add the file to ALLOWLIST with a written reason:\n${lines}`,
            );
        }
        expect(offenders).toEqual([]);
    });
});
