/**
 * Tasks roadmap TP-6 (P4.7) — no-swallowed-mutation ratchet.
 *
 * The task detail page and the create-task form fire a fistful of
 * `fetch(...)` mutations (assign, reviewer, link, comment, status,
 * watch, pending-link-attach). Before TP-6 several of them were
 * fire-and-forget: they never inspected `res.ok`, so a 4xx/5xx was
 * swallowed and the UI reported success while nothing changed
 * server-side (the assign snapped back; the create-form dropped a
 * link, leaving an AUDIT_FINDING task later un-closable).
 *
 * This guard locks the fix structurally: every mutation handler in
 * these two files MUST inspect the response (`res.ok` / an equivalent
 * ok-check) AND surface a failure (a `toast.error(...)` or a `throw`)
 * — never a silent swallow. A future handler that regresses to
 * fire-and-forget, or a re-introduced empty `.catch(() => {})`, fails
 * CI.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DETAIL_PAGE = path.join(
    REPO_ROOT,
    'src/app/t/[tenantSlug]/(app)/tasks/[taskId]/page.tsx',
);
const NEW_TASK_FORM = path.join(
    REPO_ROOT,
    'src/app/t/[tenantSlug]/(app)/tasks/_form/useNewTaskForm.ts',
);

function read(file: string): string {
    return fs.readFileSync(file, 'utf8');
}

/**
 * Return the brace-matched body `{ ... }` that follows the first
 * occurrence of `anchor` in `src`. Empty string if not found.
 */
function bodyAfter(src: string, anchor: string): string {
    const i = src.indexOf(anchor);
    if (i < 0) return '';
    const open = src.indexOf('{', i);
    if (open < 0) return '';
    let depth = 0;
    for (let k = open; k < src.length; k++) {
        if (src[k] === '{') depth++;
        else if (src[k] === '}') {
            depth--;
            if (depth === 0) return src.slice(open, k + 1);
        }
    }
    return src.slice(open);
}

describe('TP-6 — task detail mutation handlers surface failures', () => {
    const src = read(DETAIL_PAGE);

    // Curated list of the page's fetch-driven mutation handlers. A NEW
    // handler that mutates via fetch MUST be added here (and satisfy the
    // ok-check + surface-error contract) — that's the ratchet.
    const HANDLERS = [
        'const handleAssign = async',
        'const handleAssignReviewer = async',
        'const addLink = async',
        'const addComment = async',
        'const commitStatus = async',
        'const toggleWatch = async',
        // Not `= async`: Epic 67 moved the destructive removes onto the
        // undo-toast, whose `action:` callback owns the await. The
        // ok-check + throw contract below is unchanged — it is now
        // satisfied inside that callback, which `bodyAfter` still
        // captures since it brace-matches the whole handler.
        'const removeWatcher =',
        'const handleDeleteTask =',
    ];

    it.each(HANDLERS)('handler `%s` inspects res.ok', (anchor) => {
        const body = bodyAfter(src, anchor);
        expect(body).not.toBe('');
        // Accept `res.ok`, `linkRes.ok`, or any `<name>Res.ok` / `.ok` check.
        expect(body).toMatch(/\bif\s*\(\s*!\s*\w*[rR]es\.ok\s*\)/);
    });

    it.each(HANDLERS)('handler `%s` surfaces a failure (toast.error or throw)', (anchor) => {
        const body = bodyAfter(src, anchor);
        expect(body).not.toBe('');
        expect(/toast\.error\(|throw\s+new\s+Error/.test(body)).toBe(true);
    });

    it('has no empty fire-and-forget .catch swallow', () => {
        // `res.json().catch(() => ({}))` is a legitimate parse fallback;
        // an empty `.catch(() => {})` / `.catch(() => {/* … */})` on a
        // mutation is the swallow anti-pattern this ratchet bans.
        expect(src).not.toMatch(/\.catch\(\s*\(\)\s*=>\s*\{\s*(\/\*[^*]*\*\/\s*)?\}\s*\)/);
    });
});

describe('TP-6 — create-form pending-link failures are not swallowed', () => {
    const src = read(NEW_TASK_FORM);

    it('no longer carries the best-effort swallow comment', () => {
        expect(src).not.toMatch(/swallow\s+—\s+link is best-effort/i);
        expect(src).not.toMatch(/\.catch\(\s*\(\)\s*=>\s*\{\s*(\/\*[^*]*\*\/\s*)?\}\s*\)/);
    });

    it('collects failed links and surfaces them (toast + throw)', () => {
        // The link loop must inspect each response and, on any failure,
        // both toast AND throw so the form does not report clean success.
        expect(src).toMatch(/failedLinks/);
        expect(src).toMatch(/if\s*\(\s*!\s*linkRes\.ok\s*\)/);
        expect(src).toMatch(/toast\.error\(/);
        expect(src).toMatch(/throw\s+new\s+Error/);
    });
});
