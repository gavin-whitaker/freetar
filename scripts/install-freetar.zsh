#!/usr/bin/env zsh
# Installs (or updates) Freetar from GitHub, starts it in Docker, and prints the addresses to open.
# Safe to run again: it pulls the latest code and restarts the containers.
#
# Usage:  zsh install-freetar.zsh [install-dir] [repo-url]
#   install-dir  defaults to ~/freetar
#   repo-url     defaults to https://github.com/gavin-whitaker/freetar.git
# Optional environment variables: FREETAR_PORT (default 8080), FREETAR_HTTPS_PORT (default 8443)

# Everything lives in main() so the whole script is read before it runs; when piped in
# with `curl ... | zsh`, commands that read stdin would otherwise eat the rest of the script.
main() {
emulate -L zsh
setopt err_exit pipe_fail no_unset

INSTALL_DIR=${1:-$HOME/freetar}
REPO_URL=${2:-https://github.com/gavin-whitaker/freetar.git}
OS=$(uname -s)

info() { print -P "%F{cyan}==>%f $*" }
fail() { print -P "%F{red}Error:%f $*" >&2; exit 1 }

# --- Prerequisites ---------------------------------------------------------

if ! command -v git >/dev/null; then
    if [[ $OS == Darwin ]]; then
        fail "git is missing. Run 'xcode-select --install', then run this script again."
    fi
    fail "git is missing. Install it (for example 'sudo apt install git'), then run this script again."
fi

if ! command -v docker >/dev/null; then
    if [[ $OS == Darwin ]]; then
        fail "Docker is missing. Install Docker Desktop from https://www.docker.com/products/docker-desktop/ and open it once."
    fi
    fail "Docker is missing. Install it with 'curl -fsSL https://get.docker.com | sh', then run this script again."
fi

if ! docker info >/dev/null 2>&1; then
    if [[ $OS == Darwin && -d /Applications/Docker.app ]]; then
        info "Starting Docker Desktop..."
        open -a Docker
        for _ in {1..90}; do
            docker info >/dev/null 2>&1 && break
            sleep 2
        done
        docker info >/dev/null 2>&1 || fail "Docker Desktop didn't start. Open it manually, wait until it says it's running, then try again."
    elif [[ $OS == Linux ]] && docker info 2>&1 | grep -qi "permission denied"; then
        fail "Your user can't use Docker yet. Run 'sudo usermod -aG docker $USER', log out and back in, then try again."
    elif [[ $OS == Linux ]]; then
        fail "Docker isn't running. Start it with 'sudo systemctl enable --now docker', then try again."
    else
        fail "Docker isn't running. Start it, then try again."
    fi
fi

if docker compose version >/dev/null 2>&1; then
    compose=(docker compose)
elif command -v docker-compose >/dev/null; then
    compose=(docker-compose)
else
    fail "Docker Compose is missing. Install the Docker Compose plugin, then try again."
fi

# --- Get the code ----------------------------------------------------------

if [[ -d $INSTALL_DIR/.git ]]; then
    info "Updating Freetar in $INSTALL_DIR"
    git -C "$INSTALL_DIR" pull --ff-only
elif [[ -e $INSTALL_DIR && -n $(ls -A "$INSTALL_DIR" 2>/dev/null) ]]; then
    fail "$INSTALL_DIR already exists and isn't a Freetar checkout. Pass a different folder: zsh $0 ~/some-other-folder"
else
    info "Downloading Freetar into $INSTALL_DIR"
    git clone "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# --- Work out this machine's address ---------------------------------------

lan_ip=""
host_name=""
if [[ $OS == Darwin ]]; then
    iface=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}' || true)
    lan_ip=$(ipconfig getifaddr "${iface:-en0}" 2>/dev/null || ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
    host_name=$(scutil --get LocalHostName 2>/dev/null || hostname -s)
else
    lan_ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}' || true)
    [[ -z $lan_ip ]] && lan_ip=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
    host_name=$(hostname -s)
fi
[[ -z $lan_ip ]] && fail "Couldn't find this machine's network address. Connect to your home network and try again."
host_name="${(L)host_name}.local"

# --- Write settings (.env) -------------------------------------------------

touch .env
get_env() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- || true }
set_env() {
    local -a lines
    lines=("${(@f)$(<.env)}")
    lines=(${lines:#$1=*})
    lines=(${lines:#})
    lines+=("$1=$2")
    print -rl -- $lines > .env
}

http_port=${FREETAR_PORT:-$(get_env FREETAR_PORT)}
https_port=${FREETAR_HTTPS_PORT:-$(get_env FREETAR_HTTPS_PORT)}
http_port=${http_port:-8080}
https_port=${https_port:-8443}

set_env FREETAR_PORT "$http_port"
set_env FREETAR_HTTPS_PORT "$https_port"
set_env FREETAR_LAN_IP "$lan_ip"
set_env FREETAR_HOSTNAME "$host_name"

# --- Start -----------------------------------------------------------------

info "Building and starting Freetar (the first run takes a few minutes)..."
$compose up -d --build </dev/null
$compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile </dev/null >/dev/null 2>&1 || true

info "Waiting for Freetar to answer..."
ready=false
for _ in {1..60}; do
    if curl -sk -o /dev/null --max-time 2 "https://localhost:$https_port/"; then
        ready=true
        break
    fi
    sleep 1
done
$ready || fail "Freetar didn't respond. Check the logs with: cd $INSTALL_DIR && ${compose[*]} logs"

cat <<EOF

Freetar is running and will start again automatically whenever Docker starts.

  On this computer:   http://localhost:$http_port

  On your phone (same network), open:
      https://$lan_ip:$https_port
  or  https://$host_name:$https_port

  First time on the phone: open the address in Safari, go to About, and follow
  "Install on iPhone" (trust the certificate, then Add to Home Screen).
  Certificate download: https://$lan_ip:$https_port/freetar-ca.crt

To update later, run this script again.
EOF

if [[ $OS == Darwin ]]; then
    print "\nTip: in Docker Desktop, turn on Settings > General > 'Start Docker Desktop when you sign in'"
    print "so Freetar comes back after a restart."
fi
}

main "$@"
