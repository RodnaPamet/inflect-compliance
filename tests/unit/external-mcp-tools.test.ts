/**
 * THE EXTERNAL TOOL CATALOGUE.
 *
 * Two rules here are easy to get subtly wrong and impossible to notice
 * afterwards, so they are asserted directly rather than through the happy path:
 *
 *   - the hash attests what the SERVER said. It covers the definition under the
 *     name the server advertised, not under our qualified name. Hashing the
 *     qualified name would still produce a stable, plausible-looking pin — one
 *     that attests our naming scheme instead of the far end's instruction text.
 *   - pins are scoped by connection. Two servers advertise `list_alerts` and
 *     they are not the same tool; reading one's pin as the other's would show
 *     an operator APPROVED for text they never saw.
 */
const mockTx = {
    integrationConnection: { findFirst: jest.fn() },
    mcpToolManifestPin: { findMany: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockTx)),
}));

const listToolsMock = jest.fn();
jest.mock('@/app-layer/integrations/mcp/client', () => ({
    listTools: (...a: unknown[]) => listToolsMock(...a),
}));

jest.mock('@/lib/security/encryption', () => ({
    ...jest.requireActual('@/lib/security/encryption'),
    decryptField: (s: string) => s,
}));

// The shared credential resolver. Mocked rather than stubbed at the network,
// because what these tests assert is that the catalogue GOES THROUGH it — the
// thing that was missing — not how it mints.
const authorizationForMock = jest.fn();
jest.mock('@/app-layer/integrations/mcp/token', () => ({
    ...jest.requireActual('@/app-layer/integrations/mcp/token'),
    authorizationFor: (...a: unknown[]) => authorizationForMock(...a),
}));

jest.mock('@/app-layer/policies/common', () => ({
    ...jest.requireActual('@/app-layer/policies/common'),
    assertCanAdmin: jest.fn(),
}));

// PARTIAL: `manifestStateOf` stays real — it computes the verdict these tests
// are about. Only the WRITE is stubbed, so an approval's contract (which name,
// which hashes) is asserted at the seam rather than through the database.
const writePinMock = jest.fn();
jest.mock('@/app-layer/usecases/mcp-tool-manifest', () => ({
    ...jest.requireActual('@/app-layer/usecases/mcp-tool-manifest'),
    writeToolManifestPin: (...a: unknown[]) => writePinMock(...a),
}));

import {
    approveExternalToolManifest,
    listExternalMcpTools,
    MAX_EXTERNAL_TOOLS,
} from '@/app-layer/usecases/external-mcp-tools';
import { externalToolName } from '@/lib/mcp/external-tool-name';
import { hashToolManifest } from '@/lib/mcp/tool-manifest';

const CONN = 'cmconnaaa';
const ctx = { tenantId: 'tnt_1' } as never;

const connectionRow = {
    id: CONN,
    configJson: { url: 'https://mcp.example.com' },
    secretEncrypted: JSON.stringify({ authorization: 'Bearer abc' }),
};

const ALERTS = {
    name: 'list_alerts',
    description: 'List firing alerts.',
    inputSchema: { type: 'object', properties: { severity: { type: 'string' } } },
};

beforeEach(() => {
    jest.clearAllMocks();
    mockTx.integrationConnection.findFirst.mockResolvedValue(connectionRow);
    mockTx.mcpToolManifestPin.findMany.mockResolvedValue([]);
    listToolsMock.mockResolvedValue([ALERTS]);
});

describe('qualification and attestation', () => {
    it('qualifies the tool by connection while keeping the advertised name', async () => {
        const { tools } = await listExternalMcpTools(ctx, CONN);
        expect(tools).toHaveLength(1);
        expect(tools[0]).toMatchObject({
            toolName: externalToolName(CONN, 'list_alerts'),
            advertisedName: 'list_alerts',
            connectionId: CONN,
            status: 'UNPINNED',
        });
    });

    it('hashes the definition under the name the SERVER used', async () => {
        const { tools } = await listExternalMcpTools(ctx, CONN);
        const attestedByServerName = hashToolManifest(ALERTS).manifestHash;
        const attestedByOurName = hashToolManifest({
            ...ALERTS,
            name: externalToolName(CONN, 'list_alerts'),
        }).manifestHash;

        expect(tools[0].liveManifestHash).toBe(attestedByServerName);
        // The discriminator: the two hashes genuinely differ, so the assertion
        // above could have failed.
        expect(attestedByServerName).not.toBe(attestedByOurName);
    });

    it('matches a pin stored under the qualified name', async () => {
        const qualified = externalToolName(CONN, 'list_alerts');
        const live = hashToolManifest(ALERTS);
        mockTx.mcpToolManifestPin.findMany.mockResolvedValue([
            {
                toolName: qualified,
                descriptionHash: live.descriptionHash,
                schemaHash: live.schemaHash,
                manifestHash: live.manifestHash,
                revision: 1,
                approvedByUserId: null,
                approvalSource: 'BASELINE',
                approvedAt: new Date('2026-09-01'),
            },
        ]);
        const { tools } = await listExternalMcpTools(ctx, CONN);
        expect(tools[0]).toMatchObject({ status: 'APPROVED', blocked: false, revision: 1 });
    });

    it('scopes the pin query to this connection only', async () => {
        await listExternalMcpTools(ctx, CONN);
        const where = mockTx.mcpToolManifestPin.findMany.mock.calls[0][0].where;
        expect(where.toolName).toEqual({ startsWith: `mcp__${CONN}__` });
        expect(where.tenantId).toBe('tnt_1');
    });
});

describe('bounds and refusals', () => {
    it('truncates a catalogue too long to approve, and says so', async () => {
        listToolsMock.mockResolvedValue(
            Array.from({ length: MAX_EXTERNAL_TOOLS + 7 }, (_, i) => ({
                ...ALERTS,
                name: `tool_${i}`,
            })),
        );
        const res = await listExternalMcpTools(ctx, CONN);
        expect({
            returned: res.tools.length,
            advertised: res.advertised,
            truncated: res.truncated,
        }).toEqual({
            returned: MAX_EXTERNAL_TOOLS,
            advertised: MAX_EXTERNAL_TOOLS + 7,
            truncated: true,
        });
    });

    it('does not reach the network when the connection is not this tenant\'s', async () => {
        mockTx.integrationConnection.findFirst.mockResolvedValue(null);
        await expect(listExternalMcpTools(ctx, CONN)).rejects.toThrow();
        expect({ calls: listToolsMock.mock.calls.length }).toEqual({ calls: 0 });
    });

    it('passes the RESOLVED credential to the transport', async () => {
        // Resolution itself moved to `authorizationFor`, which is where the
        // static-header / OAuth / partial-refusal branches are now tested
        // (`mcp-connection-token.test.ts`). What this file still owns is that
        // whatever the resolver returns is what reaches the wire.
        authorizationForMock.mockResolvedValue('Bearer abc');
        await listExternalMcpTools(ctx, CONN);
        expect(listToolsMock).toHaveBeenCalledWith({
            url: 'https://mcp.example.com',
            authorization: 'Bearer abc',
        });
    });
});

describe('approving an external definition', () => {
    const adminCtx = { tenantId: 'tnt_1', userId: 'usr_9' } as never;
    const liveHashes = () => hashToolManifest(ALERTS);

    beforeEach(() => writePinMock.mockResolvedValue({ changed: true, revision: 1 }));

    it('pins under the QUALIFIED name, with the hashes it observed itself', async () => {
        await approveExternalToolManifest(adminCtx, {
            connectionId: CONN,
            toolName: 'list_alerts',
            expectedManifestHash: liveHashes().manifestHash,
        });

        expect(writePinMock).toHaveBeenCalledTimes(1);
        const [, , pinnedName, hashes, approver] = writePinMock.mock.calls[0];
        expect(pinnedName).toBe(externalToolName(CONN, 'list_alerts'));
        expect(hashes).toEqual({
            descriptionHash: liveHashes().descriptionHash,
            schemaHash: liveHashes().schemaHash,
            manifestHash: liveHashes().manifestHash,
        });
        expect(approver).toBe('usr_9');
    });

    /**
     * The window this argument is about is not a deploy. An external server can
     * change its text between the call that rendered the review and the call
     * this approval itself makes.
     */
    it('refuses a hash that no longer matches what the server says', async () => {
        await expect(
            approveExternalToolManifest(adminCtx, {
                connectionId: CONN,
                toolName: 'list_alerts',
                expectedManifestHash: 'sha256-of-something-the-operator-read-earlier',
            }),
        ).rejects.toThrow(/changed since it was reviewed/);
        expect({ writes: writePinMock.mock.calls.length }).toEqual({ writes: 0 });
    });

    it('refuses a tool the server no longer advertises', async () => {
        listToolsMock.mockResolvedValue([]);
        await expect(
            approveExternalToolManifest(adminCtx, {
                connectionId: CONN,
                toolName: 'list_alerts',
                expectedManifestHash: liveHashes().manifestHash,
            }),
        ).rejects.toThrow(/no longer advertises/);
        expect({ writes: writePinMock.mock.calls.length }).toEqual({ writes: 0 });
    });

    it('says "past the cap" rather than "gone" when the catalogue was truncated', async () => {
        listToolsMock.mockResolvedValue(
            Array.from({ length: MAX_EXTERNAL_TOOLS + 1 }, (_, i) => ({
                ...ALERTS,
                name: i === MAX_EXTERNAL_TOOLS ? 'list_alerts' : `tool_${i}`,
            })),
        );
        await expect(
            approveExternalToolManifest(adminCtx, {
                connectionId: CONN,
                toolName: 'list_alerts',
                expectedManifestHash: liveHashes().manifestHash,
            }),
        ).rejects.toThrow(new RegExp(`not among the first ${MAX_EXTERNAL_TOOLS}`));
    });

    it('will not approve without an approving user', async () => {
        await expect(
            approveExternalToolManifest({ tenantId: 'tnt_1' } as never, {
                connectionId: CONN,
                toolName: 'list_alerts',
                expectedManifestHash: liveHashes().manifestHash,
            }),
        ).rejects.toThrow(/approving user/);
        expect({ writes: writePinMock.mock.calls.length }).toEqual({ writes: 0 });
    });
});

/**
 * THE CATALOGUE MUST AUTHORISE THROUGH THE SHARED RESOLVER.
 *
 * `listExternalMcpTools` read `secrets.authorization` directly — the STATIC
 * header credential — and so sent no Authorization header at all for a
 * connection using the Entra refresh-token flow. Microsoft answered 401, and
 * because `approveExternalToolManifest` reads the catalogue first, an operator
 * could not approve anything either.
 *
 * It is the split `token.ts` names in its own comment: "Two would be the shape
 * where 'Test connection' succeeds and the agent fails — a green button over a
 * broken path." The Test button minted a token through a second copy of the
 * resolution logic and stayed green throughout.
 *
 * Measured against the live server: Test ok 11:51:25, catalogue 401 11:55:12,
 * Test ok 11:59:46 — same connection, same refresh token, path the only
 * variable.
 */
describe('external tool catalogue — credential resolution', () => {
    const OAUTH_ROW = {
        id: CONN,
        configJson: {
            url: 'https://mcp.example.com',
            tenantId: '00000000-0000-0000-0000-000000000001',
            clientId: '00000000-0000-0000-0000-000000000002',
        },
        // No `authorization` key: an Entra-backed connection has no static
        // header, which is exactly the case the old code turned into undefined.
        secretEncrypted: JSON.stringify({ clientSecret: 's3cret', refreshToken: 'rt-1' }),
    };

    beforeEach(() => {
        jest.clearAllMocks();
        authorizationForMock.mockReset();
        listToolsMock.mockReset();
        mockTx.integrationConnection.findFirst.mockResolvedValue(OAUTH_ROW);
        mockTx.mcpToolManifestPin.findMany.mockResolvedValue([]);
        listToolsMock.mockResolvedValue([]);
    });

    it('passes the resolver the connection id, config and secrets', async () => {
        authorizationForMock.mockResolvedValue('Bearer minted-abc');
        await listExternalMcpTools(ctx, CONN);

        expect(authorizationForMock).toHaveBeenCalledTimes(1);
        const [connectionId, config, secrets] = authorizationForMock.mock.calls[0];
        expect(connectionId).toBe(CONN);
        expect(config).toMatchObject({ tenantId: expect.any(String), clientId: expect.any(String) });
        expect(secrets).toMatchObject({ refreshToken: 'rt-1' });
    });

    it('sends the MINTED header to the server, not the absent static one', async () => {
        authorizationForMock.mockResolvedValue('Bearer minted-abc');
        await listExternalMcpTools(ctx, CONN);

        expect(listToolsMock).toHaveBeenCalledTimes(1);
        expect(listToolsMock.mock.calls[0][0]).toEqual(
            expect.objectContaining({ authorization: 'Bearer minted-abc' }),
        );
    });

    it('never calls tools/list with no credential when the connection has OAuth config', async () => {
        // The defect, stated as the thing that must not happen. An undefined
        // authorization here is a request that goes out bare and comes back 401.
        authorizationForMock.mockResolvedValue('Bearer minted-abc');
        await listExternalMcpTools(ctx, CONN);

        const sent = listToolsMock.mock.calls[0][0] as { authorization?: string };
        expect(sent.authorization).toBeDefined();
        expect(sent.authorization).not.toBe('');
    });

    it('hands the resolver a rotation callback, so a rotated token is not dropped', async () => {
        authorizationForMock.mockResolvedValue('Bearer minted-abc');
        await listExternalMcpTools(ctx, CONN);

        expect(typeof authorizationForMock.mock.calls[0][3]).toBe('function');
    });
});
