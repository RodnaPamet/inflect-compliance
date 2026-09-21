/**
 * SP-F3 ratchet — Word (.docx) policy sync (pull-authoritative).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

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
const readRaw = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const read = (p: string) => codeOf(readRaw(p));
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

describe('SP-F3 DOCX policy sync', () => {
    it('the docx module converts via mammoth + sanitises', () => {
        expect(exists('src/app-layer/integrations/providers/sharepoint/docx.ts')).toBe(true);
        const src = read('src/app-layer/integrations/providers/sharepoint/docx.ts');
        expect(src).toMatch(/mammoth/);
        expect(src).toMatch(/export function isDocxItem/);
        expect(src).toMatch(/export async function docxToPolicyHtml/);
        expect(src).toMatch(/sanitize/i);
    });

    it('pull converts Word → HTML, push is disabled for Word-linked policies', () => {
        const src = read('src/app-layer/usecases/policy-sharepoint-sync.ts');
        expect(src).toMatch(/isDocxItem/);
        expect(src).toMatch(/docxToPolicyHtml/);
        // push bails for docx-linked policies (SharePoint-authoritative).
        expect(src).toMatch(/Word-linked policy is SharePoint-authoritative/);
    });

    it('mammoth is a production dependency', () => {
        const pkg = JSON.parse(readRaw('package.json'));
        expect(pkg.dependencies?.mammoth).toBeDefined();
    });
});
