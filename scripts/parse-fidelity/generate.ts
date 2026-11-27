/**
 * Render the parse-fidelity set into `tests/fixtures/parse/`.
 *
 *   npx tsx scripts/parse-fidelity/generate.ts
 *
 * Run BY HAND, never in CI. The committed files are the fixture set; this script
 * is how they were made, kept so the set can be regenerated or extended. Its
 * outputs are not byte-reproducible (Chromium and LibreOffice stamp creation
 * times), so CI never regenerates. Instead `manifest.json` records each file's
 * sha256, and `tests/unit/parse-fidelity-fixtures.test.ts` checks the committed
 * bytes against it and re-derives every expected file from `fixtures.ts`.
 *
 * Needs, on the machine that runs it: Playwright's Chromium (PDFs and the
 * scans' first render), LibreOffice (`soffice`, DOCX and XLSX) and ImageMagick
 * (`convert`, which makes a clean render look scanned). Fonts: DejaVu Sans,
 * which carries Cyrillic for the Bulgarian policy.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { chromium } from 'playwright';

import { FIXTURES, expectedFor, fixtureFileName, htmlFor, type FixtureSpec } from './fixtures';

const OUT = resolve(__dirname, '../../tests/fixtures/parse');
const EXPECTED = join(OUT, 'expected');

/** A4 at 96 dpi CSS pixels, the page Chromium prints. */
const PAGE = { width: 794, height: 1123 };

async function main(): Promise<void> {
    mkdirSync(EXPECTED, { recursive: true });
    const work = mkdtempSync(join(tmpdir(), 'parse-fixtures-'));
    // CHROMIUM_PATH: a browser outside Playwright's own cache, when its
    // version differs from the one this checkout's Playwright expects.
    const browser = await chromium.launch(
        process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
    );
    try {
        for (const spec of FIXTURES) {
            const html = join(work, `${spec.id}.html`);
            writeFileSync(html, htmlFor(spec));
            const target = join(OUT, fixtureFileName(spec));
            await render(spec, html, target, work, browser);
            writeFileSync(join(EXPECTED, `${spec.id}.json`), JSON.stringify(expectedFor(spec), null, 2) + '\n');
            console.log(`${fixtureFileName(spec)}  ${readFileSync(target).byteLength} bytes`);
        }
    } finally {
        await browser.close();
        rmSync(work, { recursive: true, force: true });
    }
    writeManifest();
}

async function render(
    spec: FixtureSpec,
    html: string,
    target: string,
    work: string,
    browser: Awaited<ReturnType<typeof chromium.launch>>,
): Promise<void> {
    switch (spec.render) {
        case 'pdf': {
            const page = await browser.newPage();
            await page.goto(`file://${html}`);
            await page.pdf({ path: target, format: 'A4', margin: { top: '20mm', bottom: '20mm', left: '18mm', right: '18mm' } });
            await page.close();
            return;
        }
        case 'scan-png':
        case 'scan-pdf': {
            // A clean render at 1.5x, then what a flatbed scanner and a phone do
            // to it: greyscale, a slight skew, a little blur and noise, a JPEG
            // round trip. Enough that the text must be read, not extracted.
            const page = await browser.newPage({ viewport: PAGE, deviceScaleFactor: 1.5 });
            await page.goto(`file://${html}`);
            const clean = join(work, `${spec.id}.clean.png`);
            await page.screenshot({ path: clean, fullPage: true });
            await page.close();
            const scanned = join(work, `${spec.id}.scan.png`);
            execFileSync('convert', [
                clean,
                '-colorspace', 'Gray',
                '-background', 'white',
                '-rotate', '0.8',
                '-blur', '0x0.6',
                '-attenuate', '0.25',
                '+noise', 'Gaussian',
                '-quality', '82',
                `jpg:${join(work, `${spec.id}.jpg`)}`,
            ]);
            execFileSync('convert', [join(work, `${spec.id}.jpg`), '-strip', scanned]);
            if (spec.render === 'scan-png') {
                copyFileSync(scanned, target);
                return;
            }
            // An image-only PDF: one page, the scan as its only content.
            const b64 = readFileSync(scanned).toString('base64');
            const wrap = await browser.newPage();
            await wrap.setContent(
                `<html><body style="margin:0"><img src="data:image/png;base64,${b64}" style="width:210mm;display:block"></body></html>`,
            );
            await wrap.pdf({ path: target, format: 'A4', margin: { top: '0', bottom: '0', left: '0', right: '0' } });
            await wrap.close();
            return;
        }
        case 'docx':
        case 'xlsx': {
            // HTML opens in Writer by default; a spreadsheet needs Calc's HTML
            // import filter named, or the conversion has no Calc document to save.
            const args =
                spec.render === 'docx'
                    ? ['--headless', '--convert-to', 'docx:MS Word 2007 XML', '--outdir', work, html]
                    : ['--headless', '--infilter=HTML (StarCalc)', '--convert-to', 'xlsx:Calc Office Open XML', '--outdir', work, html];
            execFileSync('soffice', args, { stdio: 'ignore' });
            copyFileSync(join(work, `${spec.id}.${spec.render}`), target);
            return;
        }
    }
}

function writeManifest(): void {
    const files = FIXTURES.map((spec) => {
        const file = fixtureFileName(spec);
        const sha256 = createHash('sha256').update(readFileSync(join(OUT, file))).digest('hex');
        return { id: spec.id, file, sha256 };
    });
    writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ files }, null, 2) + '\n');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
