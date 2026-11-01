/**
 * What the executions route says about the connection itself (#4870): enough
 * for the connection's page to name it, and for its cards to know its provider
 * and stored owner without downloading every connection in the workspace.
 */
export interface ConnectionHeader {
    id: string;
    name: string;
    provider: string;
    isEnabled: boolean;
    ownerUserId: string | null;
}
