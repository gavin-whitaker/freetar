#!/usr/bin/env bash
# Points the HTTPS proxy at this Mac's current network address, restarts it if needed,
# and prints the address to open on your phone. Run it after switching Wi-Fi networks.
set -euo pipefail

cd "$(dirname "$(realpath "$0")")/.."

iface=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}' || true)
ip=$(ipconfig getifaddr "${iface:-en0}" 2>/dev/null || ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
if [[ -z "$ip" ]]; then
    echo "This Mac isn't connected to a network. Join a Wi-Fi network and try again." >&2
    exit 1
fi
host="$(scutil --get LocalHostName | tr '[:upper:]' '[:lower:]').local"

touch .env
set_env() {
    if grep -q "^$1=" .env; then
        sed -i '' "s|^$1=.*|$1=$2|" .env
    else
        echo "$1=$2" >> .env
    fi
}
set_env FREETAR_LAN_IP "$ip"
set_env FREETAR_HOSTNAME "$host"
port=$(grep -E '^FREETAR_HTTPS_PORT=' .env | cut -d= -f2 || true)
port=${port:-8443}

if ! docker info >/dev/null 2>&1; then
    echo "Docker isn't running. Open Docker Desktop, wait for it to start, then run this again." >&2
    exit 1
fi
docker compose up -d >/dev/null 2>&1 || docker compose up -d
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true

for _ in {1..20}; do
    curl -sk -o /dev/null --max-time 2 "https://localhost:$port/" && break
    sleep 1
done

cat <<EOF

Freetar is ready. On your phone (same Wi-Fi as this Mac), open:

    https://$host:$port

If that name doesn't load on this network, use the IP address instead:

    https://$ip:$port

EOF
