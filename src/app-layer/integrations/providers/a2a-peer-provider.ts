/**
 * THE OUTBOUND ROUTE TO ONE A2A PEER (#3679, step 4b): the connection an agent's
 * task to a peer is sent through.
 *
 * ## Why a connection, and not a column on the peer
 *
 * An outbound A2A task is an EXTERNAL WRITE (`docs/a2a-mapping.md`), and an
 * external write is governed per CONNECTION: its rung on the external write
 * ladder (`IntegrationConnection.externalWriteMode`), the dwell and evidence
 * before a rung widens, the per-connection window at `AUTOMATIC`, and the
 * journal rows keyed on it. `PeerAgent` must never carry a rung — that would be
 * the second authority model the design rules out — so the route to a peer is a
 * connection of this provider, and every one of those mechanisms applies to it
 * unchanged. The peer record says who the peer is; the connection says how far
 * agents may act through it.
 *
 * ## What it holds
 *
 *   peerId        WHICH registered peer. Classified `peerReference` in
 *                 `CONFIG_FIELD_RULES`, an origin kind: changing it while keeping
 *                 the stored credential is refused by `redirectsStoredCredential`,
 *                 because the credential is the one THAT peer issued.
 *   authorization The credential the peer issued Inflect, sent verbatim as the
 *                 Authorization header (O4 I: a credential per peer). Optional:
 *                 a peer may rely on Inflect's per-message signature alone.
 *
 * It holds NO endpoint. Where a task goes is the `url` of the peer's card as
 * pinned by a person — inside the pin's endpoint hash — and is read from the
 * ≤15-minute copy at every send. An endpoint typed here would be a second,
 * unpinned answer to the same question.
 *
 * ## A successful validation confers nothing
 *
 * `supportedChecks` is empty: this runs no compliance check. Validation is
 * shape-only (`liveValidation: false`) because it has no tenant context to read
 * the peer with; the real test is admission, which every send runs — the peer
 * ACTIVE, scored, pinned and its live card matching the pin. A connection that
 * validates is reachable by no agent until a grant, a rung above `DISABLED` and
 * a current card pin all hold.
 */
import type {
    ConnectionConfigSchema,
    ConnectionValidationResult,
    IntegrationProvider,
} from '../types';

export const A2A_PEER_PROVIDER_ID = 'a2a-peer';

/** A peer id as the register mints them. Anything else names no peer. */
export const PEER_ID_SHAPE = /^[a-z0-9]{8,64}$/;

export class A2aPeerProvider implements IntegrationProvider {
    readonly id = A2A_PEER_PROVIDER_ID;
    readonly displayName = 'A2A peer agent (outbound)';
    readonly description =
        'The route an agent\'s task to a registered A2A peer agent is sent through. Connecting '
        + 'one grants nothing: the send is offered to an agent only once it is granted the '
        + 'tool, this connection is above DISABLED on the external write ladder, and the '
        + 'peer\'s agent card is pinned by a person and still matches its pin.';

    /** Empty, deliberately: this provider runs no scheduled compliance check. */
    readonly supportedChecks: string[] = [];

    readonly liveValidation = false;
    /** No live peer has been exchanged with yet: the step's exit is open (#3679). */
    readonly mappingVerifiedBy = null;

    readonly setupGuide =
        'Register and pin the peer first, under Agents → Peers. Then name it here by its '
        + 'peer id. If the peer issued Inflect a credential, paste it as the Authorization '
        + 'header value (for example "Bearer …"); it is encrypted at rest and sent only to the '
        + 'endpoint in that peer\'s pinned card. The connection starts at DISABLED on the '
        + 'external write ladder and is widened one rung at a time by an owner.';

    readonly configSchema: ConnectionConfigSchema = {
        configFields: [
            {
                key: 'peerId',
                label: 'Peer id',
                type: 'string',
                required: true,
                description: 'The id of the registered A2A peer this connection sends to.',
            },
        ],
        secretFields: [
            {
                key: 'authorization',
                label: 'Authorization header',
                type: 'string',
                required: false,
                description:
                    'The credential the peer issued this workspace, sent verbatim as the '
                    + 'Authorization header. Leave blank for a peer that relies on signatures alone.',
            },
        ],
    };

    async validateConnection(
        config: Record<string, unknown>,
        secrets: Record<string, unknown>,
    ): Promise<ConnectionValidationResult> {
        const peerId = typeof config.peerId === 'string' ? config.peerId.trim() : '';
        if (!peerId) return { valid: false, error: 'A peer id is required.' };
        if (!PEER_ID_SHAPE.test(peerId)) {
            return { valid: false, error: 'That is not a peer id. Copy it from the peer register.' };
        }
        const authorization = secrets.authorization;
        if (authorization !== undefined && authorization !== null && authorization !== '') {
            if (typeof authorization !== 'string' || authorization.length > 4096 || /[\r\n]/.test(authorization)) {
                return { valid: false, error: 'The Authorization value must be a single line of at most 4096 characters.' };
            }
        }
        return { valid: true };
    }
}
