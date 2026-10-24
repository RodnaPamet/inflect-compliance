// One Astro + Starlight config per site, built from the same parts. Each
// site's own astro.config.mjs (site/users/, site/developers/) calls this with
// its name; content comes from `node scripts/stage-docs.js`, which writes the
// allowlisted docs into that site's src/content/docs/ — generated and
// gitignored. See docs/docs-site.md.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const require = createRequire(import.meta.url);
const { repoIo, sidebarFrom, sidebarLabel, SITES } = require('./stage-docs.js');

const ORIGIN = 'https://rodnapamet.github.io';

/**
 * @param {'users' | 'developers'} name
 * @param {{ description: string, social?: object[], sidebarEnd?: object[] }} options
 */
export function siteConfig(name, { description, social = [], sidebarEnd = [] }) {
    const site = SITES[name];
    const manifest = JSON.parse(readFileSync(new URL(`../${name}/manifest.json`, import.meta.url), 'utf8'));
    // The same reads the stager makes, so a folder entry expands to the same
    // pages here and a section label prints the same app label.
    const io = repoIo();
    return defineConfig({
        site: ORIGIN,
        base: site.base,
        trailingSlash: 'always',
        // An INLINE PostCSS config stops Vite searching upward for one. Without
        // it Vite finds the application's postcss.config.js at the repo root
        // and fails on its Tailwind plugin, which site/ does not install.
        vite: { css: { postcss: {} } },
        integrations: [
            starlight({
                title: site.title,
                description,
                social,
                sidebar: [
                    { label: 'Overview', link: '/' },
                    ...sidebarFrom(manifest, io.listFolder, sidebarLabel(io), site),
                    ...sidebarEnd,
                ],
                credits: false,
            }),
        ],
    });
}

export const OTHER_SITE = {
    users: { label: 'Help for users', link: `${ORIGIN}${SITES.users.base}/` },
    developers: { label: 'Documentation for developers', link: `${ORIGIN}${SITES.developers.base}/` },
};
