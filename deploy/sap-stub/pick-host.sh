#!/usr/bin/env bash
# Print the LAN address to bind the stub to, or explain why there is none.
#
# DISCOVERED, NOT HARDCODED. The first draft of this runbook named
# 192.168.56.20 because an earlier note said this VM carries the AD lab's
# host-only network. It does not — the interfaces here are one real LAN address
# and six docker bridges. A hardcoded address in a runbook is wrong on every
# machine but the author's, and the symptom is a bind failure that says nothing
# about why.
#
# Docker bridges are EXCLUDED even though they are RFC1918 and would satisfy the
# egress allowlist. Binding one would work and then confuse everyone: the address
# changes when the bridge is recreated, and a stub reachable only from inside a
# container network is not the thing the VERIFY is trying to demonstrate.
set -euo pipefail

candidates=$(
    ip -4 -o addr show scope global 2>/dev/null \
        | awk '{print $2" "$4}' \
        | grep -vE '^(docker|br-|veth|virbr)' \
        | awk '{split($2, a, "/"); print $1" "a[1]}'
)

if [ -z "$candidates" ]; then
    echo "no global IPv4 interface found — the stub needs a routable LAN address" >&2
    exit 1
fi

# RFC1918 only. A public address would be refused by nothing, which is worse:
# the stub serves fixtures and must not be reachable from outside the network.
private=$(echo "$candidates" | awk '
    $2 ~ /^10\./ ||
    $2 ~ /^192\.168\./ ||
    $2 ~ /^172\.(1[6-9]|2[0-9]|3[01])\./ { print }
')

if [ -z "$private" ]; then
    echo "interfaces found, but none is RFC1918:" >&2
    echo "$candidates" | sed 's/^/  /' >&2
    echo "the stub must not be bound to a public address — it serves fixtures" >&2
    exit 1
fi

# PREFER A HOST-ONLY INTERFACE. Both a host-only address and the real LAN
# address satisfy the egress allowlist identically — neither is loopback, both are
# RFC1918 — so the guard cannot distinguish them and the choice is ours. A
# host-only network is the better one: the stub serves fixture data over a
# certificate nobody else trusts, and on `enp0s31f6` it would be reachable by
# everything else on the office network for no benefit. Least exposure that still
# satisfies the check.
hostonly=$(echo "$private" | grep -E '^(vboxnet|vmnet|hostonly)' || true)
if [ -n "$hostonly" ] && [ "$(echo "$hostonly" | wc -l)" -eq 1 ]; then
    echo "$hostonly" | awk '{print $2}'
    exit 0
fi

count=$(echo "$private" | wc -l)
if [ "$count" -gt 1 ]; then
    # Ambiguity is reported, never resolved by picking the first. Binding the
    # wrong interface produces a stub that is reachable but from the wrong
    # places, which is harder to notice than one that does not start.
    echo "more than one candidate and none is host-only; pass --host explicitly:" >&2
    echo "$private" | sed 's/^/  /' >&2
    exit 1
fi

echo "$private" | awk '{print $2}'
