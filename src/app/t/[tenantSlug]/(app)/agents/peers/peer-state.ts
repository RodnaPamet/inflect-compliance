/**
 * How a peer's pin and card read, as the peers pages show them (#3679). Pure,
 * so the list and the detail page cannot disagree about what "changed" means.
 *
 * The card state is read from the stored `observedCardHash` — what the last
 * successful card read saw — and is INFORMATIONAL: admission never trusts it,
 * it reads the live card (`admitPeerMessage`). A "matches" here is therefore a
 * statement about the last read, and the page says so.
 */
export type PeerPinState = { kind: 'none' } | { kind: 'pinned'; revision: number };
/**
 * `unapproved`: the card was read but nobody has approved any version of it
 * (#4901). It used to fall to `changed`, so a peer registered a minute ago
 * read "Changed since the pin" beside "Not pinned".
 */
export type PeerCardState = 'matches' | 'changed' | 'unapproved' | 'unobserved';

export interface PeerPinFacts {
    readonly pinnedCardHash: string | null;
    readonly pinRevision: number;
    readonly observedCardHash: string | null;
}

export function peerPinState(p: PeerPinFacts): PeerPinState {
    return p.pinnedCardHash && p.pinRevision > 0 ? { kind: 'pinned', revision: p.pinRevision } : { kind: 'none' };
}

export function peerCardState(p: PeerPinFacts): PeerCardState {
    if (!p.observedCardHash) return 'unobserved';
    if (p.pinnedCardHash === null) return 'unapproved';
    return p.observedCardHash === p.pinnedCardHash ? 'matches' : 'changed';
}

/** One label and one tone per card state, for the list and the peer's page alike. */
export const PEER_CARD_LABEL_KEY: Readonly<Record<PeerCardState, string>> = {
    matches: 'peers.cardMatches',
    changed: 'peers.cardChanged',
    unapproved: 'peers.cardUnapproved',
    unobserved: 'peers.cardUnobserved',
};

export const PEER_CARD_VARIANT: Readonly<Record<PeerCardState, 'success' | 'error' | 'warning' | 'neutral'>> = {
    matches: 'success',
    changed: 'error',
    unapproved: 'warning',
    unobserved: 'neutral',
};
