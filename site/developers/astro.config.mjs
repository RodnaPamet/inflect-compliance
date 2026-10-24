// The developer documentation site, at /inflect-compliance/developers/.
import { OTHER_SITE, siteConfig } from '../scripts/astro-site.mjs';

export default siteConfig('developers', {
    description: 'Architecture, security, integration and contributor documentation for Inflect Compliance.',
    social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/RodnaPamet/inflect-compliance' }],
    sidebarEnd: [OTHER_SITE.users],
});
