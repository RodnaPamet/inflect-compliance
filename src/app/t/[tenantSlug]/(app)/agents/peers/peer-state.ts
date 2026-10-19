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
export type PeerCardState = 'matches' | 'changed' | 'unobserved';

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
    return p.pinnedCardHash !== null && p.observedCardHash === p.pinnedCardHash ? 'matches' : 'changed';
}
