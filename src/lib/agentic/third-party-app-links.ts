/**
 * LINKS TO A THIRD-PARTY APPLICATION IN ITS VENDOR'S OWN CONSOLE.
 *
 * The Integrations tab on `/agents/reports` lists the applications a directory
 * granted access to. Per row it offers two links, never a write (owner
 * decision): "What is this?" (`aboutUrl`, the publisher's public page) and
 * "Manage / deactivate" (`manageUrl`, the place in the directory's own admin
 * console where an administrator removes or disables it). Inflect stays
 * read-only; the next scan shows the result.
 *
 * Every part of a URL built here is validated against an exact pattern first,
 * and anything that does not match yields `null` — no link, never a guess. The
 * only hosts this module ever produces are `github.com`,
 * `entra.microsoft.com`, and an Okta org's admin host (`<org>-admin.okta.com`
 * or `<org>-admin.oktapreview.com`), and `isAllowedThirdPartyLinkHost` states
 * that set once for the tests.
 *
 * CLIENT-SAFE and pure: no runtime import. The patterns below are COPIES of
 * the ones in `@rodnapamet/scanent-contract/integrations-contract-rules`
 * (`ENTRA_OBJECT_ID`, `OKTA_ORG_HOST`, `OKTA_OBJECT_ID`, `GITHUB_ORGANIZATION`,
 * `GITHUB_APP_SLUG`, the installation id's digits), narrowed where a link needs
 * more than the contract does. They are copied rather than imported because
 * the package's integrations modules require `crypto` transitively, and this
 * module may be bundled for a browser. The contract already refused a report
 * whose ids break them; re-checking here is what keeps a stored row that did
 * not come through that verifier from becoming a URL.
 */

/** A lower-case GUID, as Entra writes object and application ids. */
const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const GUID_RE = new RegExp(`^${GUID}$`);
/** `entra:<directory GUID>:sp:<service principal object GUID>`. */
const ENTRA_APPLICATION_RE = new RegExp(`^entra:(${GUID}):sp:(${GUID})$`);

/** A GitHub organisation login, lower-cased. */
const GITHUB_ORG = '[a-z0-9][a-z0-9-]{0,38}';
/** A GitHub installation id: digits, no leading zero. */
const GITHUB_INSTALLATION = '[1-9][0-9]{0,19}';
/** `github:<organisation>:installation:<installation id>`. */
const GITHUB_INSTALLATION_RE = new RegExp(`^github:(${GITHUB_ORG}):installation:(${GITHUB_INSTALLATION})$`);
/** A GitHub App's slug. */
const GITHUB_APP_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** An Okta org host on Okta's own domains, lower-case. */
// One anchored literal, never an unanchored string composed into a RegExp
// elsewhere: a host pattern must not be usable without its anchors (CodeQL
// js/regex/missing-regexp-anchor).
const OKTA_ORG_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,62})(?:\.[a-z0-9](?:[a-z0-9-]{0,62}))*\.(?:okta|oktapreview)\.com$/;
/** An Okta app id: letters and digits. */
const OKTA_OBJECT_ID = '[A-Za-z0-9]{1,64}';
/** `okta:<org host>:app:<app id>`. */
const OKTA_APPLICATION_RE = new RegExp(`^okta:([a-z0-9.-]{1,253}):app:(${OKTA_OBJECT_ID})$`);
/** A DNS label is at most 63 characters; an admin host whose first label would exceed it is not built. */
const MAX_DNS_LABEL = 63;
const OKTA_ADMIN_SUFFIX = '-admin';

export interface ThirdPartyAppLinkInput {
    /** The report's id for the application (`entra:…:sp:…`, `okta:…:app:…`, `github:…:installation:…`). */
    readonly applicationId: string;
    /** `DiscoveredThirdPartyApp.publisherAppId`. */
    readonly publisherAppId: string | null;
    /** `DiscoveredThirdPartyApp.publisherAppSlug`. */
    readonly publisherAppSlug: string | null;
}

export interface ThirdPartyAppLinks {
    /** Where an administrator manages or deactivates it, in the directory's console; null when none can be built. */
    readonly manageUrl: string | null;
    /** The publisher's public page about the application; null when none can be built. */
    readonly aboutUrl: string | null;
}

const NO_LINKS: ThirdPartyAppLinks = Object.freeze({ manageUrl: null, aboutUrl: null });

/** The vendor-console links for one application, or nulls where any part does not validate. */
export function thirdPartyAppLinks(input: ThirdPartyAppLinkInput): ThirdPartyAppLinks {
    const { applicationId, publisherAppId, publisherAppSlug } = input;
    if (typeof applicationId !== 'string') return NO_LINKS;

    const github = GITHUB_INSTALLATION_RE.exec(applicationId);
    if (github) {
        const [, org, installationId] = github;
        return {
            manageUrl: `https://github.com/organizations/${org}/settings/installations/${installationId}`,
            aboutUrl:
                typeof publisherAppSlug === 'string' && GITHUB_APP_SLUG_RE.test(publisherAppSlug)
                    ? `https://github.com/apps/${publisherAppSlug}`
                    : null,
        };
    }

    const entra = ENTRA_APPLICATION_RE.exec(applicationId);
    if (entra) {
        const [, , objectId] = entra;
        // Entra's application blade needs both ids; without a valid application
        // (client) id there is no link rather than a blade that will not open.
        if (typeof publisherAppId !== 'string' || !GUID_RE.test(publisherAppId)) return NO_LINKS;
        return {
            manageUrl:
                'https://entra.microsoft.com/#view/Microsoft_AAD_IAM/ManagedAppMenuBlade/~/Properties'
                + `/objectId/${objectId}/appId/${publisherAppId}`,
            aboutUrl: null,
        };
    }

    const okta = OKTA_APPLICATION_RE.exec(applicationId);
    if (okta) {
        const [, host] = okta;
        if (!OKTA_ORG_HOST_RE.test(host)) return NO_LINKS;
        const dot = host.indexOf('.');
        const firstLabel = host.slice(0, dot);
        if (firstLabel.length + OKTA_ADMIN_SUFFIX.length > MAX_DNS_LABEL) return NO_LINKS;
        const adminHost = `${firstLabel}${OKTA_ADMIN_SUFFIX}${host.slice(dot)}`;
        return { manageUrl: `https://${adminHost}/admin/apps/active`, aboutUrl: null };
    }

    return NO_LINKS;
}

const OKTA_ADMIN_HOST_RE = /^[a-z0-9][a-z0-9-]*-admin(?:\.[a-z0-9][a-z0-9-]*)*\.(?:okta|oktapreview)\.com$/;

/** The hosts `thirdPartyAppLinks` may produce, stated once: for tests and any reader that re-checks. */
export function isAllowedThirdPartyLinkHost(host: string): boolean {
    return host === 'github.com' || host === 'entra.microsoft.com' || OKTA_ADMIN_HOST_RE.test(host);
}
