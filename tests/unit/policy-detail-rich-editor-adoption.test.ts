/**
 * Structural ratchet — Epic 45.2 policy detail editor migration.
 *
 * Locks the policy detail page to:
 *   - Lazy-loaded RichTextEditor (bundle posture).
 *   - HTML rendering branch with `sanitizeRichTextHtml` (XSS guard).
 *   - The createVersion path forwards the editor's contentType
 *     instead of forcing 'MARKDOWN'.
 *   - Open-editor seeds the editor's mode from the current version's
 *     stored contentType (HTML versions reopen in WYSIWYG).
 *
 * Mirrors the Epic 91 / Epic 44 / Epic 92 shell-adoption ratchets —
 * one canonical pattern, one place to update when the contract
 * changes.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// String literals are KEPT, so assertions that harvest codes or ids from source
// still see them. Every path this file reads is a TypeScript-alike, re-derived
// per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const POLICY_DETAIL = path.resolve(
    __dirname,
    '../../src/app/t/[tenantSlug]/(app)/policies/[policyId]/page.tsx',
);
const source = codeOf(readFileSync(POLICY_DETAIL, 'utf8'));

describe('Policy detail — Epic 45.2 RichTextEditor adoption', () => {
    it('lazy-loads RichTextEditor via next/dynamic with ssr: false', () => {
        // Bundle posture: ~200KB Tiptap chunks must not land on the
        // first paint of the policy detail page.
        expect(source).toMatch(
            /dynamic\(\s*\(\)\s*=>\s*import\(['"]@\/components\/ui\/RichTextEditor['"]\)[\s\S]{0,200}ssr:\s*false/,
        );
    });

    it('imports sanitizeRichTextHtml for the render branch', () => {
        expect(source).toMatch(
            /import\s*\{[^}]*\bsanitizeRichTextHtml\b[^}]*\}\s*from\s*['"]@\/lib\/security\/sanitize['"]/,
        );
    });

    it('renders HTML versions via dangerouslySetInnerHTML with sanitization', () => {
        // The legacy whitespace-pre fallback stays for MARKDOWN
        // versions; HTML versions now branch into the sanitized
        // dangerouslySetInnerHTML path.
        expect(source).toMatch(
            /v\.contentType\s*===\s*['"]HTML['"][\s\S]{0,400}sanitizeRichTextHtml\(/,
        );
        // The sanitised HTML is then enriched (heading anchors + auto
        // Table of Contents) before it's rendered.
        expect(source).toMatch(/const\s+enriched\s*=\s*enrichPolicyHtml\(safe\)/);
        expect(source).toMatch(
            /dangerouslySetInnerHTML=\{\{\s*__html:\s*enriched\s*\}\}/,
        );
    });

    it('forwards the editor contentType into the createVersion payload', () => {
        // The legacy code hardcoded `contentType: 'MARKDOWN'`. The
        // wire payload now reflects whichever mode the editor is
        // in (MARKDOWN or HTML) so HTML round-trips end-to-end.
        expect(source).toContain('editorContentType');
        expect(source).toContain('wireContentType');
    });

    it('open-editor seeds editorContentType from the current version', () => {
        // A version saved as HTML should reopen in WYSIWYG mode —
        // that branch is locked here so a future refactor cannot
        // silently downgrade HTML versions to plain markdown.
        expect(source).toMatch(
            /currentVersion\?\.contentType === ['"]HTML['"][\s\S]{0,80}'HTML'/,
        );
    });

    it('reset-after-save clears editorContentType back to MARKDOWN', () => {
        // The default mode for fresh authoring; forcing this back
        // means the next "Save as new version" doesn't accidentally
        // ship as HTML if the operator had toggled WYSIWYG once.
        expect(source).toMatch(
            /setEditorContentType\(['"]MARKDOWN['"]\)/,
        );
    });

    it('mounts <RichTextEditor> in the editor tab with the canonical id', () => {
        // E2E selector preserved (`#version-editor`) — keeps existing
        // policy-page tests working.
        expect(source).toMatch(/<RichTextEditor[\s\S]{0,400}id="version-editor"/);
    });
});
