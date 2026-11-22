/**
 * `scanent-integrations/1` report bodies for Inflect's third-party application
 * ingest tests: one application of each product, and a body around them.
 *
 * The shapes are the contract package's own test fixtures
 * (scanent `packages/contract/tests/helpers/integrations-bodies.ts`), typed
 * against the installed package so a contract change fails `tsc` here first.
 * Reports are signed with the harness fake scanner (`createFakeScanner`): both
 * contracts sign the same canonical JSON with the same Ed25519 key, which is
 * why one registered scanner key verifies both of a scanner's reports.
 */
import {
    INTEGRATIONS_CONTRACT_V1,
    type EntraIntegrationsApplication,
    type GitHubInstallation,
    type IntegrationsReportBody,
    type OktaIntegrationsApplication,
} from '@rodnapamet/scanent-contract/integrations-contract';

export const DIR = '0d1e2c3b-0000-4000-8000-000000003686';
export const GRAPH = '00000003-0000-0000-c000-000000000000';
export const OKTA_HOST = 'acme.okta.com';

/** A lower-case GUID ending in `n`, so several applications each get their own. */
export function guid(n: number): string {
    return `a0000006-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** An Entra application holding a high grant (Mail.ReadWrite), another directory's, publisher not verified, no owner. */
export function entraApp(n = 1, over: Partial<EntraIntegrationsApplication> = {}): EntraIntegrationsApplication {
    const sp = guid(n);
    return {
        id: `entra:${DIR}:sp:${sp}`,
        sourceKind: 'entra-integrations',
        appId: `e0000006-0000-4000-8000-${String(n).padStart(12, '0')}`,
        displayName: `Acme Mail Sync ${n}`,
        origin: 'OTHER_DIRECTORY',
        publisherVerified: false,
        owners: [],
        delegatedGrants: {
            read: true,
            grants: [{ resourceAppId: GRAPH, consentType: 'Principal', principalCount: 2, scopes: ['Mail.Read'], unreadableScopes: 0 }],
        },
        applicationPermissions: {
            read: true,
            permissions: [{ resourceAppId: GRAPH, roleId: 'e2a3a72e-5f79-4c64-b1b1-878b674786c9', name: 'Mail.ReadWrite' }],
        },
        signIn: { read: true, lastSeen: '2026-03-02' },
        credentials: [],
        ...over,
    };
}

/** An Entra application with nothing to say about: its own directory's, one owner, no grant, signed in the day before. */
export function quietEntraApp(n: number, over: Partial<EntraIntegrationsApplication> = {}): EntraIntegrationsApplication {
    return entraApp(n, {
        origin: 'THIS_DIRECTORY',
        publisherVerified: true,
        owners: [{ kind: 'user', id: guid(900 + n) }],
        delegatedGrants: { read: true, grants: [] },
        applicationPermissions: { read: true, permissions: [] },
        signIn: { read: true, lastSeen: '2026-10-18' },
        ...over,
    });
}

export function oktaApp(over: Partial<OktaIntegrationsApplication> = {}): OktaIntegrationsApplication {
    return {
        id: `okta:${OKTA_HOST}:app:0oa1abcdEFGH23ijk456`,
        sourceKind: 'okta-integrations',
        appId: '0oa1abcdEFGH23ijk456',
        displayName: 'Acme Provisioning',
        status: 'ACTIVE',
        signOnMode: 'OPENID_CONNECT',
        scopeGrants: { read: true, scopes: ['okta.users.read', 'okta.logs.read'], unreadableScopes: 0 },
        ...over,
    };
}

export function githubInstallation(over: Partial<GitHubInstallation> = {}): GitHubInstallation {
    return {
        id: 'github:acme:installation:41',
        sourceKind: 'github-integrations',
        appId: 9001,
        appSlug: 'acme-deploy-bot',
        repositorySelection: 'selected',
        suspended: false,
        events: ['push', 'pull_request'],
        permissions: { read: true, grants: [{ name: 'metadata', level: 'read' }, { name: 'contents', level: 'write' }], unreadable: 0 },
        ...over,
    };
}

type Source = IntegrationsReportBody['sources'][number];

export const ENTRA_COMPLETE: Source = {
    kind: 'entra-integrations',
    status: 'COMPLETE',
    rows: 12,
    signInActivity: { status: 'COMPLETE', rows: 3 },
};

/** A body of one Entra source read in full, with the given applications. */
export function integrationsBody(
    scannerAgentId: string,
    scanId: string,
    over: Partial<IntegrationsReportBody> = {},
): IntegrationsReportBody {
    return {
        contract: INTEGRATIONS_CONTRACT_V1,
        scan: {
            id: scanId,
            asOf: '2026-10-19T03:00:00.000Z',
            scanner: { agentId: scannerAgentId, version: '0.15.0', manifestHash: `sha256:${'a'.repeat(64)}` },
        },
        sources: [ENTRA_COMPLETE],
        applications: [entraApp(1)],
        ...over,
    };
}

/** All three products, each source read in full, with the GitHub organisation's webhooks. */
export function threeProductBody(scannerAgentId: string, scanId: string): IntegrationsReportBody {
    return integrationsBody(scannerAgentId, scanId, {
        sources: [
            ENTRA_COMPLETE,
            { kind: 'okta-integrations', status: 'COMPLETE', rows: 4, signInActivity: { status: 'NOT_READ' } },
            { kind: 'github-integrations', status: 'COMPLETE', rows: 3, signInActivity: { status: 'NOT_READ' } },
        ],
        applications: [entraApp(1), githubInstallation(), oktaApp()],
        // A GitHub source carries the organisation's webhooks member: hosts only.
        webhooks: {
            read: true,
            hooks: [{ id: 'github:acme:hook:7', sourceKind: 'github-integrations', host: 'hooks.chat.example', events: ['push'], active: true, created: '2026-01-04' }],
        },
    });
}
