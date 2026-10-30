#!/usr/bin/env bash
#
# Regenerate the gateway VM's PKI — 5.6 follow-up (#4565).
#
# ═══════════════════════════════════════════════════════════════════════════
# WHY THIS EXISTS INSTEAD OF A BACKUP
# ═══════════════════════════════════════════════════════════════════════════
#
# The CA and the JWT signing key are generated ON the gateway VM and exist
# nowhere else. That is deliberate — no private key should cross machines — but
# it means a disk failure loses them. The owner decided on 2026-10-30 that they
# are REGENERABLE rather than backed up, for two reasons:
#
#   - they cost one run of this script to remake, so a backup buys little;
#   - a snapshot of a disk holding private keys is itself a secret-bearing
#     artifact with its own access-control problem. It would trade one exposure
#     for two.
#
# Deletion protection is on, which covers accidental loss. This covers the rest.
#
# ═══════════════════════════════════════════════════════════════════════════
# WHAT REGENERATING COSTS — READ THIS BEFORE RUNNING IT
# ═══════════════════════════════════════════════════════════════════════════
#
# A NEW CA INVALIDATES EVERY CLIENT CERTIFICATE IT EVER SIGNED.
#
# The gateway authorises an inbound caller on `CN=openshell-client/
# OU=openshell-user`, signed by this CA. Any copy of that certificate
# distributed to another host — the app VM, an operator's machine — stops being
# accepted the moment this runs. There is no revocation and no grace period: the
# old CA is simply gone.
#
# So regenerating is a TWO-HOST operation whenever a client certificate has been
# distributed. Re-issue and redeploy it in the same maintenance window, or the
# app's transport fails closed against a gateway that no longer knows it.
#
# Today nothing holds a copy (#4561 is the issue that would change that), so
# this is a single-host operation and cheap. That changes the first time a
# transport ships.
#
# ═══════════════════════════════════════════════════════════════════════════
# USAGE
# ═══════════════════════════════════════════════════════════════════════════
#
#   sudo ./regenerate-pki.sh            # refuses if a PKI is already present
#   sudo ./regenerate-pki.sh --force    # overwrites it, having read the above
#
# Run ON the gateway VM. Reproduces exactly the layout the VM carries today,
# read off the live host rather than reconstructed from memory.
#
set -euo pipefail

PKI=/etc/openshell/pki
FORCE="${1:-}"

if [[ $EUID -ne 0 ]]; then
    echo "regenerate-pki: must run as root — the keys are mode 0400 root:root." >&2
    exit 1
fi

# REFUSES BY DEFAULT. A script that silently regenerates over a working PKI is a
# footgun: the failure is invisible until an inbound call is rejected, and by
# then the old CA is unrecoverable.
if [[ -f "$PKI/ca.key" && "$FORCE" != "--force" ]]; then
    echo "regenerate-pki: a PKI is already present at $PKI." >&2
    echo "" >&2
    echo "Overwriting it invalidates every client certificate this CA signed." >&2
    echo "Read the header of this script, then re-run with --force." >&2
    exit 2
fi

# The server certificate's SAN carries the VM's own internal address, so it is
# DERIVED. A hardcoded address would produce a certificate that fails
# verification on any other host, which is the sort of thing nobody notices
# until mTLS refuses a connection.
IP="$(hostname -I | awk '{print $1}')"
[[ -n "$IP" ]] || { echo "regenerate-pki: could not determine the internal IP." >&2; exit 1; }
echo "regenerate-pki: internal address $IP"

install -d -m 0755 -o root -g root "$PKI" "$PKI/jwt" "$PKI/server" "$PKI/client"
cd "$PKI"

# ── CA: EC P-256, 10 years ────────────────────────────────────────────────
openssl ecparam -name prime256v1 -genkey -noout -out ca.key
openssl req -x509 -new -key ca.key -sha256 -days 3650 -out ca.crt \
    -subj "/CN=openshell-ca/O=openshell" 2>/dev/null

mkcert() { # dir, subject, extfile
    openssl ecparam -name prime256v1 -genkey -noout -out "$1/tls.key"
    openssl req -new -key "$1/tls.key" -out "$1/tls.csr" -subj "$2" 2>/dev/null
    openssl x509 -req -in "$1/tls.csr" -CA ca.crt -CAkey ca.key -CAcreateserial \
        -out "$1/tls.crt" -days 825 -sha256 -extfile "$3" 2>/dev/null
    rm -f "$1/tls.csr"
}

printf 'subjectAltName = DNS:openshell-gateway, DNS:localhost, IP:127.0.0.1, IP:%s\nextendedKeyUsage = serverAuth\n' "$IP" > server.ext
mkcert server "/CN=openshell-server" server.ext

# CN and OU exactly as the gateway authorises on. Changing either silently
# stops inbound mTLS being recognised.
printf 'extendedKeyUsage = clientAuth\n' > client.ext
mkcert client "/CN=openshell-client/OU=openshell-user" client.ext
rm -f server.ext client.ext

# ── JWT: Ed25519 PKCS8, plus a 32-hex kid with NO trailing newline ────────
openssl genpkey -algorithm ED25519 -out jwt/signing.pem
openssl pkey -in jwt/signing.pem -pubout -out jwt/public.pem
openssl rand -hex 16 > jwt/kid
truncate -s -1 jwt/kid

chown -R root:root "$PKI"
chmod 0400 ca.key server/tls.key client/tls.key jwt/signing.pem
chmod 0644 ca.crt server/tls.crt client/tls.crt jwt/public.pem jwt/kid

# ── VERIFY, because a PKI that looks right and is not is the worst outcome ─
echo "regenerate-pki: verifying"
openssl verify -CAfile ca.crt server/tls.crt client/tls.crt
printf '  client subject: %s\n' "$(openssl x509 -in client/tls.crt -noout -subject | sed 's/subject=//')"
printf '  server SAN:     %s\n' "$(openssl x509 -in server/tls.crt -noout -ext subjectAltName | tail -1 | xargs)"
printf '  jwt algorithm:  %s\n' "$(openssl pkey -in jwt/signing.pem -noout -text 2>/dev/null | head -1)"
printf '  kid bytes:      %s (expected 32)\n' "$(wc -c < jwt/kid)"
printf '  signing.pem:    %s (expected 400 root:root)\n' "$(stat -c '%a %U:%G' jwt/signing.pem)"

echo ""
echo "regenerate-pki: done. Restart the gateway so it loads the new material:"
echo "  systemctl restart openshell-gateway && systemctl is-active openshell-gateway"
echo ""
echo "If a client certificate was ever distributed, RE-ISSUE IT NOW — the old"
echo "one is no longer accepted and the caller will fail closed."
