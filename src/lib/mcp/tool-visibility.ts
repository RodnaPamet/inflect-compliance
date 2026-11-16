/**
 * Advertising-time permission probe, shared by the read registry and the
 * mount-gated list. Deliberately NOT the enforcement — it writes no audit row
 * and throws nothing, because a tool being absent from a catalogue is not a
 * denied access attempt. `authorizeToolCall` is the decision.
 */
import type { McpInvocation } from './authorize';

export function canSee(inv: McpInvocation, keys: readonly string[] | undefined): boolean {
    if (!keys || keys.length === 0) return true;
    const perms = inv.ctx.appPermissions as unknown as Record<
        string,
        Record<string, boolean> | undefined
    >;
    return keys.every((k) => {
        const [domain, action] = k.split('.');
        return perms[domain]?.[action] === true;
    });
}
