/**
 * P2 — the generic connect form renders real field types, carries per-provider
 * setup guidance, labels test-connection honestly, and stops treating internal
 * providers as a free-form Add entry.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const PAGE = 'src/app/t/[tenantSlug]/(app)/admin/integrations/page.tsx';
const TYPES = 'src/app-layer/integrations/types.ts';

describe('P2 — config field types', () => {
    const page = read(PAGE);
    it('renders fields via a type switch (not text-for-everything)', () => {
        expect(page).toMatch(/const renderField/);
        expect(page).toMatch(/case 'select':/);
        expect(page).toMatch(/case 'boolean':/);
        expect(page).toMatch(/case 'number':/);
        expect(page).toMatch(/case 'textarea':/);
        // uses the primitives, not raw inputs, for structured types.
        expect(page).toMatch(/<Combobox\b/);
        expect(page).toMatch(/<Checkbox\b/);
        expect(page).toMatch(/<Textarea\b/);
    });
    it('ConfigField supports textarea; JSON secrets declare it', () => {
        expect(read(TYPES)).toMatch(/'string'\s*\|\s*'number'\s*\|\s*'boolean'\s*\|\s*'select'\s*\|\s*'textarea'/);
        expect(read('src/app-layer/integrations/providers/google-workspace/index.ts')).toMatch(/serviceAccountJson[\s\S]*type:\s*'textarea'/);
        expect(read('src/app-layer/integrations/providers/gcp-posture-provider.ts')).toMatch(/serviceAccountJson[\s\S]*type:\s*'textarea'/);
    });
});

describe('P2 — setup guidance + honest test + internal providers', () => {
    const page = read(PAGE);
    const types = read(TYPES);

    it('providers carry setupGuide + liveValidation, surfaced to the UI', () => {
        expect(types).toMatch(/readonly setupGuide\?/);
        // Was `readonly liveValidation\?` — it pinned the field as OPTIONAL,
        // and optional was the defect: an undeclared provider read as `false`,
        // so a provider was labelled shape-only BY SILENCE rather than by
        // decision. GitHub performs a real authenticated probe and was still
        // shown to admins as unverified because nobody wrote the line.
        // Required now, so tsc enumerates anyone who forgets.
        expect(types).toMatch(/readonly liveValidation:\s*boolean;/);
        expect(types).not.toMatch(/readonly liveValidation\?/);
        expect(read('src/app-layer/integrations/aws-posture-provider.ts')).toMatch(/liveValidation = true/);
        expect(read('src/app-layer/integrations/providers/azure-posture-provider.ts')).toMatch(/liveValidation = false/);
        expect(page).toMatch(/data-testid="provider-setup-guide"/);
    });

    it('test-connection labels shape-only vs live', () => {
        expect(page).toMatch(/liveValidation/);
        expect(page).toMatch(/integrations\.testShapeOnly/);
        expect(page).toMatch(/integrations\.testVerified/);
    });

    it('the edit "leave blank keeps secret" hint exists', () => {
        expect(page).toMatch(/integrations\.leaveBlankHint/);
        expect(page).toMatch(/const handleEdit/);
    });

    it('internal providers are out of the Add dropdown + get a one-click enable', () => {
        // Dropdown options are the credential-taking providers only.
        expect(page).toMatch(/options=\{connectableProviders\.map/);
        expect(page).toMatch(/id="enable-internal-checks-btn"/);
        expect(page).toMatch(/handleEnableInternal/);
    });
});
