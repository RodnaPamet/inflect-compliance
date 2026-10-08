/**
 * `legacy-mcp` — a connection to an MCP server an operator runs in front of one of
 * their own legacy applications.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHOSE SYSTEM THIS IS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The server at the far end is the CUSTOMER'S. They run it, in front of an
 * application they own, exposing a read-only view of its access tables. It is not
 * a vendor and it is not a sub-processor — `docs/sub-processors.md` says so
 * explicitly, because a register that listed it would be claiming we share data
 * with a third party when the data never leaves the customer's estate except to
 * come to us.
 *
 * That ownership is what shapes every decision below:
 *
 * - **No host allowlist is possible.** Every customer's endpoint is different, so
 *   the `vendorOrigin` rule kind cannot apply. `endpointUrl` is classified
 *   `publicOrigin`: https required, `checkWebhookUrl` run at save time, and
 *   `safeFetch` re-resolving every address at use time.
 * - **The credential cannot be inherited by a new host.** `publicOrigin` is in
 *   `ORIGIN_KINDS`, so `redirectsStoredCredential` refuses a configuration update
 *   that changes the endpoint without re-entering the token. Without that, an
 *   `admin.manage` holder could point the connection at a host they control and
 *   keep the customer's bearer token.
 * - **Nothing is pulled here.** `validateConnection` reads the manifest and stops.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A GREEN TEST DOES AND DOES NOT PROMISE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `liveValidation = true` is honest: a real handshake and a real manifest read
 * happen. A passing test means the server speaks a protocol version we support, it
 * advertises resources, its manifest satisfies the contract schema, and the
 * contract string is `inflect-legacy-access/1`.
 *
 * It does NOT mean the pages are readable. `probeManifest` deliberately stops
 * before them, and only a real pull's `complete` flag says the rows came back
 * whole. Conflating the two would make a green button a promise the product cannot
 * keep — and the failure it would hide is the torn-snapshot one, which by
 * definition only appears while paging.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TEST BUTTON IS NOT A BACKGROUND PULL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This method never calls `markAuthFailure`. An operator pressing Test with a
 * half-typed token would otherwise flag the connection's credential as broken —
 * and that flag is read by the freshness surface and the leaver pass, which would
 * then treat a typo as evidence the integration is down. Only a background pull,
 * which nobody is watching, is entitled to record that conclusion.
 *
 * @module app-layer/integrations/providers/legacy-mcp
 */

import {
    probeManifest,
    LegacyMcpClientError,
} from '@/lib/mcp/client';
import type {
    ConnectionConfigSchema,
    ConnectionValidationResult,
    IntegrationProvider,
} from '../../types';

export const LEGACY_MCP_PROVIDER_ID = 'legacy-mcp';

export class LegacyMcpProvider implements IntegrationProvider {
    readonly id = LEGACY_MCP_PROVIDER_ID;
    readonly displayName = 'Legacy application (MCP)';
    readonly description =
        'A read-only view of a legacy application\'s access tables, exposed through an MCP '
        + 'server the customer runs in front of it. Connecting one does not recertify '
        + 'anything: the accounts it exposes are reconciled against HR and a person confirms '
        + 'every link.';

    /**
     * EMPTY, and deliberately. This provider runs no scheduled compliance check —
     * it is a data source for recertification, and the pull that reads it is the
     * recertification pass's own job rather than a check with a pass/fail verdict.
     */
    readonly supportedChecks: string[] = [];

    /** A real handshake and manifest read happen below, so this is true honestly. */
    readonly liveValidation = true;

    readonly setupGuide =
        'Enter the HTTPS endpoint of the MCP server you run in front of the legacy '
        + 'application, and the bearer token it expects. Testing the connection performs a '
        + 'real handshake and reads the manifest, which tells you whether the server speaks '
        + 'the inflect-legacy-access/1 contract. The endpoint must be reachable on a public '
        + 'address over HTTPS: private, loopback and link-local addresses are refused, '
        + 'redirects are not followed, and changing the endpoint later requires re-entering '
        + 'the token.';

    readonly configSchema: ConnectionConfigSchema = {
        configFields: [
            {
                key: 'endpointUrl',
                label: 'MCP server URL',
                type: 'string',
                required: true,
                description:
                    'HTTPS endpoint of your MCP server, e.g. https://legacy-mcp.example.com/rpc',
                placeholder: 'https://legacy-mcp.example.com/rpc',
            },
            {
                key: 'applicationName',
                label: 'Application name',
                type: 'string',
                required: false,
                description:
                    'What to call this application in reviews and findings. Defaults to the '
                    + 'name the server reports in its manifest.',
            },
        ],
        secretFields: [
            {
                key: 'bearerToken',
                label: 'Bearer token',
                type: 'string',
                required: true,
                description:
                    'Sent as an Authorization: Bearer header. It is encrypted at rest and is '
                    + 'never returned by the API, shown in a validation message, written to a '
                    + 'log line or recorded in an audit row.',
            },
        ],
    };

    async validateConnection(
        config: Record<string, unknown>,
        secrets: Record<string, unknown>
    ): Promise<ConnectionValidationResult> {
        const url = typeof config.endpointUrl === 'string' ? config.endpointUrl.trim() : '';
        const token = typeof secrets.bearerToken === 'string' ? secrets.bearerToken.trim() : '';

        // Shape first, and separately, so an operator who left a field blank is told
        // which one rather than being sent to look at their server.
        if (!url) return { valid: false, error: 'MCP server URL is required.' };
        if (!token) return { valid: false, error: 'Bearer token is required.' };

        try {
            const manifest = await probeManifest({ url, token });

            // `ConnectionValidationResult` is `{ valid, error? }` — it carries no
            // success channel, so the COLUMN LIST the step brief asks for cannot be
            // returned through it. Same gap `McpServerProvider` records for its tool
            // count, and the same reason for leaving it: widening the contract
            // touches every provider, and the surface that needs the columns is the
            // Step 2b mapping UI, which reads the manifest itself.
            //
            // The probe is still what makes the test meaningful rather than a shape
            // check: a non-conforming server fails HERE, at setup, instead of at
            // 03:00 in a pass nobody is watching.
            void manifest.columns;
            return { valid: true };
        } catch (err) {
            // A typed client failure describes OUR verdict about the exchange, and
            // each maps to a different thing for the operator to do. Passed through
            // because we authored the text — unlike a remote server's own message,
            // which must never be rendered into an admin screen as though this
            // deployment vouched for it.
            if (err instanceof LegacyMcpClientError) {
                return { valid: false, error: operatorMessageFor(err) };
            }
            return {
                valid: false,
                error:
                    'Could not reach the server. It must be an HTTPS endpoint on a public '
                    + 'address; private addresses and redirects are refused.',
            };
        }
    }
}

/**
 * One actionable sentence per failure kind.
 *
 * Not the error's own `message`: those carry internals an operator cannot act on
 * ("contract violation at initialize: unsupported protocolVersion"), and the point
 * of six error kinds was that each maps to a different remedy. This is where that
 * mapping is spent.
 *
 * None of these interpolates anything from the response. The token is not here
 * because no branch has it, and the server's body is not here because no branch
 * receives it — the client's errors are built from counts, identifiers and fixed
 * phrases for exactly this reason.
 */
function operatorMessageFor(err: LegacyMcpClientError): string {
    switch (err.kind) {
        case 'authentication-failed':
            return 'The server rejected the bearer token. Check the token and re-enter it.';
        case 'ssrf-blocked':
            return 'The endpoint is not an allowed destination. It must be an HTTPS URL on a '
                + 'public address, and redirects are not followed.';
        case 'timeout':
            return 'The server did not respond in time. Check that the endpoint is reachable '
                + 'and that the server is running.';
        case 'contract-violation':
            return 'The server answered, but not in the inflect-legacy-access/1 contract. '
                + 'Check that it implements the manifest resource as published in '
                + 'docs/legacy-mcp-access-contract.md.';
        case 'cap-exceeded':
            return 'The server\'s manifest is larger than this integration accepts. Reduce the '
                + 'number of columns it advertises.';
        case 'torn-snapshot':
            // Unreachable from a manifest-only probe — it needs two pages to
            // disagree. Handled rather than defaulted so the switch stays
            // exhaustive: a new error kind should fail to compile here, not fall
            // through to a message about the wrong thing.
            return 'The server\'s snapshot changed while it was being read. Try again.';
    }
}
