// The public docs site. Content comes from `node scripts/stage-docs.js`,
// which copies the allowlisted docs into src/content/docs/ — that directory is
// generated and gitignored. See docs/docs-site.md.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const require = createRequire(import.meta.url);
const { sidebarFrom, SITE_BASE } = require('./scripts/stage-docs.js');
const manifest = JSON.parse(readFileSync(new URL('./published-docs.json', import.meta.url), 'utf8'));

export default defineConfig({
    site: 'https://rodnapamet.github.io',
    base: SITE_BASE,
    trailingSlash: 'always',
    // An INLINE PostCSS config stops Vite searching upward for one. Without it
    // Vite finds the application's postcss.config.js at the repo root and
    // fails on its Tailwind plugin, which site/ does not install.
    vite: { css: { postcss: {} } },
    integrations: [
        starlight({
            title: 'Inflect Compliance',
            description:
                'Architecture, security and contributor documentation for Inflect Compliance, a multi-tenant GRC platform.',
            social: [
                { icon: 'github', label: 'GitHub', href: 'https://github.com/RodnaPamet/inflect-compliance' },
            ],
            sidebar: [{ label: 'Overview', link: '/' }, ...sidebarFrom(manifest)],
            // Each page sets its own editUrl to the doc in docs/, because the
            // staged copy is not what anybody should edit.
            credits: false,
        }),
    ],
});
