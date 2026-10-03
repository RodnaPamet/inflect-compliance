/**
 * Compiles `src/app/globals.css` through the REAL postcss plugin chain
 * (the one `postcss.config.js` declares) and writes the result to
 * stdout.
 *
 * WHY A SEPARATE SCRIPT, run as a CHILD PROCESS, instead of a `require`
 * inside the test: `@tailwindcss/postcss` calls `module.registerHooks()`
 * at import time, and Jest refuses that outright —
 *
 *   "module.registerHooks() is not supported in Jest: the hooks would
 *    attach to the module loader running Jest itself, not to the
 *    sandboxed require/import used by test code"
 *
 * so the plugin cannot be loaded inside a Jest module registry at all.
 * Approximating the pipeline with a hand-rolled postcss setup would
 * defeat the purpose — the subject under test is exactly which `@layer`
 * Tailwind emits each rule into, which only the real plugin decides.
 *
 * Not a `*.test.*` file, so Jest's `testMatch` never picks it up.
 *
 * Usage: `node tests/helpers/compile-globals-css.mjs > out.css`
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import autoprefixer from 'autoprefixer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GLOBALS = path.join(ROOT, 'src/app/globals.css');

const out = await postcss([tailwind(), autoprefixer()]).process(
    fs.readFileSync(GLOBALS, 'utf8'),
    { from: GLOBALS },
);
process.stdout.write(out.css);
