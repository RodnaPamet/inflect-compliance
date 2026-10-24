'use strict';
/**
 * Put the two built sites into one Pages artifact: the user site at the root
 * of site/dist/ and the developer site under site/dist/developers/, matching
 * each site's `base` (SITES in stage-docs.js). Each is built on its own by
 * `astro build --root <site>`, so neither build can empty the other's output.
 */
const fs = require('node:fs');
const path = require('node:path');
const { SITES } = require('./stage-docs.js');

const SITE_DIR = path.resolve(__dirname, '..');
const OUT = path.join(SITE_DIR, 'dist');

fs.rmSync(OUT, { recursive: true, force: true });
for (const site of Object.values(SITES)) {
    const built = path.join(SITE_DIR, site.name, 'dist');
    const rel = site.base.slice(SITES.users.base.length).replace(/^\//, '');
    const dest = path.join(OUT, rel);
    if (!fs.existsSync(built)) {
        process.stderr.write(`docs site: ${path.relative(SITE_DIR, built)} is missing — build the ${site.name} site first\n`);
        process.exit(1);
    }
    fs.cpSync(built, dest, { recursive: true });
    process.stdout.write(`docs site: ${site.name} site → dist/${rel}\n`);
}
