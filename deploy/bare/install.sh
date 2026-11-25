#!/usr/bin/env bash
# Installs or upgrades Nix on one Linux machine without Docker: Postgres, the object store, Caddy
# and Nix itself run as systemd services. For Ubuntu 24.04 or a Debian-family system with systemd
# and a Postgres that has a pgvector package. Run as root; read it first.
#
#   curl -fsSL https://raw.githubusercontent.com/sianachi/nixsites/main/deploy/bare/install.sh \
#     | sudo bash -s -- https://nix.example.org
#
# The argument is the public origin. DNS for it must point at the machine and its port (80 and 443
# by default) must be free: Caddy fetches the certificate. An origin that is an IP address or has no
# public DNS gets a certificate from Caddy's own authority, which browsers warn about. With no
# argument it is a try-out at http://nix.localhost on this machine.
#
# It installs packages (postgresql, pgvector, caddy), replaces /etc/caddy/Caddyfile (the old one is
# kept beside it), and puts everything else under three folders:
#   /opt/nix       the release files, Node and the object store binary
#   /etc/nix       settings and every generated secret: back this up
#   /var/lib/nix   uploaded files, sign-in keys and companion data: back this up with the database
#
# Re-running upgrades: state is kept, migrations run, services restart on the new release.
#   --version <tag>   release to install (default: the latest GitHub release)
# NIX_SOURCE_DIR=<checkout> uses that checkout's deploy/ files; NIX_ARTIFACT_DIR=<dir> uses release
# files already on disk (scripts/release-artifacts.sh) instead of downloading them.
#
# Not included: the remote MCP server and sites. Both need the Docker or Kubernetes install.
set -euo pipefail

repo=${NIX_REPO:-sianachi/nixsites}
versitygw_version=1.7.0
version= origin=
die() { printf 'install: %s\n' "$*" >&2; exit 2; }
say() { printf '\ninstall: %s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version) version=${2:?}; shift 2 ;;
    -h|--help) echo 'usage: install.sh [--version <tag>] [origin]'; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) [ -z "$origin" ] || die 'one origin only'; origin=$1; shift ;;
  esac
done
[ "$(id -u)" = 0 ] || die 'run as root (sudo)'
[ -d /run/systemd/system ] || die 'this machine does not run systemd'
command -v apt-get >/dev/null 2>&1 || die 'this script needs apt (Ubuntu or Debian)'
case "$(uname -m)" in
  x86_64) rid=linux-x64 node_arch=x64 gw_arch=x86_64 ;;
  aarch64|arm64) rid=linux-arm64 node_arch=arm64 gw_arch=arm64 ;;
  *) die "no release for $(uname -m)" ;;
esac

origin=${origin:-http://nix.localhost}
[[ "$origin" =~ ^(https?)://([a-z0-9.-]+)(:([0-9]+))?/?$ ]] || die "origin must be http(s)://host[:port], got $origin"
scheme=${BASH_REMATCH[1]} host=${BASH_REMATCH[2]} port=${BASH_REMATCH[4]:-}
origin="$scheme://$host${port:+:$port}"
# Core refuses a plain-http origin anywhere else: the session cookie would travel in the clear.
if [ "$scheme" = http ] && [[ "$host" != *.localhost ]]; then
  die "a plain-http origin is only allowed for a .localhost try-out; use https:// for $host"
fi

# ── Packages ───────────────────────────────────────────────────────────────────
say 'installing packages'
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl openssl jq tar xz-utils postgresql caddy >/dev/null
pg_major=$(pg_lsclusters -h | awk 'NR==1 { print $1 }')
[ -n "$pg_major" ] || die 'no Postgres cluster found after installing postgresql'
# Core is built with globalization on, so it needs ICU; the package name carries the version.
icu=$(apt-cache pkgnames libicu | grep -E '^libicu[0-9]+$' | sort -V | tail -1)
apt-get install -y -qq --no-install-recommends "postgresql-$pg_major-pgvector" "$icu" >/dev/null \
  || die "could not install postgresql-$pg_major-pgvector and $icu; Nix needs the pgvector extension and ICU"
systemctl enable --now postgresql >/dev/null 2>&1

# ── Release files ──────────────────────────────────────────────────────────────
if [ -z "$version" ]; then
  version=$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" | jq -r '.tag_name // empty')
  [ -n "$version" ] || die "no release found for $repo; pass --version"
fi
umask 077
release=/opt/nix/releases/$version
mkdir -p /opt/nix/bin /opt/nix/releases /etc/nix
chmod 755 /opt/nix /opt/nix/bin /opt/nix/releases
# $1: release file name. Prints the path of a local copy.
artifact() {
  if [ -n "${NIX_ARTIFACT_DIR:-}" ]; then
    [ -f "$NIX_ARTIFACT_DIR/$1" ] || die "NIX_ARTIFACT_DIR has no $1"
    echo "$NIX_ARTIFACT_DIR/$1"
  else
    curl -fsSL -o "/tmp/$1" "https://github.com/$repo/releases/download/$version/$1" \
      || die "release $version has no $1 (releases before the first one with plain files cannot be installed this way)"
    echo "/tmp/$1"
  fi
}
if [ ! -x "$release/core/Nix.Api" ]; then
  say "fetching release $version"
  rm -rf "$release"
  mkdir -p "$release/core" "$release/node" "$release/web" "$release/deploy"
  tar -xzf "$(artifact "nix-core-$version-$rid.tar.gz")" -C "$release/core"
  tar -xzf "$(artifact "nix-node-$version.tar.gz")" -C "$release/node"
  tar -xzf "$(artifact "nix-web-$version.tar.gz")" -C "$release/web"
  if [ -n "${NIX_SOURCE_DIR:-}" ]; then
    cp -R "$NIX_SOURCE_DIR/deploy/seed" "$NIX_SOURCE_DIR/deploy/Caddyfile.prod" "$release/deploy/"
  else
    curl -fsSL "https://github.com/$repo/archive/$version.tar.gz" \
      | tar -xz -C "$release/deploy" --strip-components=2 --wildcards '*/deploy/seed' '*/deploy/Caddyfile.prod'
  fi
  chmod -R a+rX "$release"
fi
if [ ! -x /opt/nix/node/bin/node ]; then
  say 'fetching Node 22'
  sums=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt)
  node_file=$(awk -v suffix="-linux-$node_arch.tar.xz" 'index($2, suffix) { print $2 }' <<<"$sums")
  curl -fsSL -o "/tmp/$node_file" "https://nodejs.org/dist/latest-v22.x/$node_file"
  (cd /tmp && grep " $node_file\$" <<<"$sums" | sha256sum -c --quiet -) || die "checksum mismatch for $node_file"
  mkdir -p /opt/nix/node
  tar -xJf "/tmp/$node_file" -C /opt/nix/node --strip-components=1
  chmod -R a+rX /opt/nix/node
fi
if [ ! -x /opt/nix/bin/versitygw ]; then
  say 'fetching the object store'
  gw_file=versitygw_v${versitygw_version}_Linux_$gw_arch.tar.gz
  gw_url=https://github.com/versity/versitygw/releases/download/v$versitygw_version
  curl -fsSL -o "/tmp/$gw_file" "$gw_url/$gw_file"
  (cd /tmp && curl -fsSL "$gw_url/checksums.txt" | grep " $gw_file\$" | sha256sum -c --quiet -) || die "checksum mismatch for $gw_file"
  tar -xzf "/tmp/$gw_file" -C /opt/nix/bin --strip-components=1 --wildcards '*/versitygw'
  chmod 755 /opt/nix/bin/versitygw
fi

# ── State ──────────────────────────────────────────────────────────────────────
id nix >/dev/null 2>&1 || useradd --system --home-dir /var/lib/nix --shell /usr/sbin/nologin nix
bucket=nix-worker-jobs
# The posix object store keeps each bucket as a folder.
install -d -o nix -g nix -m 700 /var/lib/nix /var/lib/nix/data-protection /var/lib/nix/companion \
  /var/lib/nix/objects "/var/lib/nix/objects/$bucket"
chgrp nix /etc/nix && chmod 750 /etc/nix
secrets=/etc/nix/secrets.env
secret() { openssl rand -hex "$1"; }
new_install=false
if [ ! -f "$secrets" ]; then
  new_install=true
  say "writing $secrets"
  # SEC1 DER for P-256: the private scalar is at offset 7, the public point the last 65 bytes.
  vapid_der=$(mktemp)
  openssl ecparam -name prime256v1 -genkey -noout | openssl ec -outform DER -out "$vapid_der" 2>/dev/null
  [ "$(wc -c < "$vapid_der" | tr -d ' ')" = 121 ] || die 'unexpected EC key encoding for the VAPID pair'
  cat > "$secrets" <<EOF
# Written by deploy/bare/install.sh. Every value is a secret for this install; back this file up.
origin=$origin
setup_code=$(secret 8)
pg_app=$(secret 24)
pg_migrator=$(secret 24)
pg_collab=$(secret 24)
internal_secret=$(secret 32)
forms_key=$(secret 32)
vapid_private=$(dd if="$vapid_der" bs=1 skip=7 count=32 2>/dev/null | openssl base64 -A | tr '+/' '-_' | tr -d '=')
vapid_public=$(tail -c 65 "$vapid_der" | openssl base64 -A | tr '+/' '-_' | tr -d '=')
object_access_key=nix-root-$(secret 8)
object_secret_key=$(secret 32)
token_key_id=nix-core-$(date +%Y-%m)
EOF
  rm -f "$vapid_der"
fi
# Only this script writes the file, and every value is hex, base64url or the checked origin.
installed_origin=$origin
# shellcheck disable=SC1090
. "$secrets"
[ "$origin" = "$installed_origin" ] || die "$secrets was written for $origin; pass that origin"
key_file=/etc/nix/core-access-token.pem
[ -f "$key_file" ] || openssl ecparam -name prime256v1 -genkey -noout -out "$key_file"
chgrp nix "$key_file" && chmod 640 "$key_file"

core=http://127.0.0.1:8080 collab=http://127.0.0.1:8100
cat > /etc/nix/core.env <<EOF
NIX_RELEASE_VERSION=$version
ASPNETCORE_ENVIRONMENT=Production
ASPNETCORE_URLS=$core
DOTNET_gcServer=0
ConnectionStrings__Nix=Host=127.0.0.1;Port=5432;Database=nix;Username=nix_app;Password=$pg_app
Nix__InternalSecret=$internal_secret
Nix__Pets__WorkerUrl=http://127.0.0.1:8302
Nix__Collaboration__BaseUrl=$collab
Nix__ObjectStorage__Endpoint=http://127.0.0.1:7070
Nix__ObjectStorage__PublicOrigin=$origin
Nix__ObjectStorage__Region=us-east-1
Nix__ObjectStorage__Bucket=$bucket
Nix__ObjectStorage__AccessKey=$object_access_key
Nix__ObjectStorage__SecretKey=$object_secret_key
Nix__PublicForms__SigningKey=$forms_key
Nix__ForwardedHeaders__KnownNetworks=127.0.0.0/8
Nix__ForwardedHeaders__ForwardLimit=1
Nix__RateLimits__WritesPerMinute=120
Nix__RateLimits__PublicFormSubmissionsPerMinute=20
Nix__RateLimits__SuggestionsPerMinute=60
Nix__Push__VapidPublicKey=$vapid_public
Nix__Push__VapidPrivateKey=$vapid_private
Nix__Push__VapidSubject=mailto:admin@$host
Nix__Workers__InstanceId=nix-api
Nix__GoWorkers__ExportEnabled=true
Nix__GoWorkers__ImportEnabled=true
Nix__Auth__Mode=local
Nix__Auth__SetupCode=$setup_code
Nix__Bff__PublicOrigin=$origin
Nix__Bff__DataProtectionKeysPath=/var/lib/nix/data-protection
Nix__AccessTokens__Issuer=$origin
Nix__AccessTokens__Audience=nix
Nix__AccessTokens__KeyId=$token_key_id
Nix__AccessTokens__SigningKeyPemFile=$key_file
Nix__AccessTokens__LifetimeMinutes=10
EOF
cat > /etc/nix/node.env <<EOF
NIX_RELEASE_VERSION=$version
NODE_ENV=production
NIX_NODE_ROLES=collab,companion
NIX_COLLAB_HOST=127.0.0.1
NIX_COLLAB_PORT=8100
NIX_COLLAB_DATABASE_URL=postgresql://nix_collab:$pg_collab@127.0.0.1:5432/nix
NIX_COLLAB_CORE_BASE_URL=$core
NIX_COLLAB_INTERNAL_SECRET=$internal_secret
NIX_COLLAB_OIDC_ISSUERS=$origin|$core/public/v1/auth/jwks
NIX_COLLAB_OIDC_AUDIENCE=nix
NIX_COLLAB_REAUTH_SECONDS=60
NIX_COLLAB_MAX_RESIDENT_MB=256
NIX_COLLAB_MAX_DOCS=200
NIX_COMPANION_DATA_DIR=/var/lib/nix/companion
NIX_COMPANION_INTERNAL_SECRET=$internal_secret
NIX_COMPANION_API_URL=$core
NIX_COMPANION_ADDRESS=127.0.0.1:8302
NIX_COMPANION_SERVER_TOOLS=off
NIX_COMPANION_COLLAB_URL=$collab
EOF
cat > /etc/nix/objects.env <<EOF
ROOT_ACCESS_KEY=$object_access_key
ROOT_SECRET_KEY=$object_secret_key
EOF
cat > /etc/nix/web.env <<EOF
NIX_PUBLIC_ORIGIN=$origin
NIX_OBJECT_STORE_PUBLIC_ORIGIN=$origin
NIX_OBJECT_STORE_BUCKET=$bucket
NIX_CLIENT_IP={http.request.remote.host}
NIX_MCP_UPSTREAM=mcp.invalid:8500
NIX_RELEASE_VERSION=$version
NIX_RELEASE_COMMIT=$version
EOF
chmod 600 /etc/nix/*.env

# ── Database ───────────────────────────────────────────────────────────────────
say 'preparing the database'
seed=$release/deploy/seed
# The seed files narrate every step as a NOTICE; errors still show.
as_postgres() { runuser -u postgres -- env PGOPTIONS=--client-min-messages=warning psql -X -q -v ON_ERROR_STOP=1 "$@"; }
as_postgres -d postgres -v app_password="$pg_app" -v migrator_password="$pg_migrator" \
  -v collab_password="$pg_collab" -v db_name=nix -f "$seed/seed.sql" >/dev/null
[ "$(as_postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'nix'")" = 1 ] \
  || as_postgres -d postgres -c 'CREATE DATABASE nix OWNER nix_migrator' >/dev/null
as_postgres -d nix -v db_name=nix -f "$seed/seed_database.sql" >/dev/null

say 'running migrations'
migrator_url=postgresql://nix_migrator:$pg_migrator@127.0.0.1:5432/nix
runuser -u nix -- env "NIX_MIGRATOR_CONNECTION_STRING=Host=127.0.0.1;Port=5432;Database=nix;Username=nix_migrator;Password=$pg_migrator" \
  "$release/core/Nix.Migrator"
runuser -u nix -- psql -X -v ON_ERROR_STOP=1 -f "$seed/seed_template_presets.sql" "$migrator_url" >/dev/null
(cd "$release/node/apps/collab" && runuser -u nix -- env "NIX_COLLAB_MIGRATOR_CONNECTION_STRING=$migrator_url" \
  /opt/nix/node/bin/node --experimental-strip-types src/migrate-documents.ts)

# ── Services ───────────────────────────────────────────────────────────────────
ln -sfn "$release" /opt/nix/current
# $1: unit name, $2: description, $3: env file, $4: working directory, $5: command.
unit() {
  cat > "/etc/systemd/system/$1.service" <<EOF
[Unit]
Description=$2
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
User=nix
Group=nix
EnvironmentFile=/etc/nix/$3
WorkingDirectory=$4
ExecStart=$5
Restart=always
RestartSec=3
TimeoutStopSec=60
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/nix

[Install]
WantedBy=multi-user.target
EOF
}
unit nix-objects 'Nix object store' objects.env /var/lib/nix '/opt/nix/bin/versitygw --port 127.0.0.1:7070 posix /var/lib/nix/objects'
unit nix-api 'Nix Core' core.env /opt/nix/current/core /opt/nix/current/core/Nix.Api
unit nix-node 'Nix collaboration and companion' node.env /opt/nix/current/node \
  '/opt/nix/node/bin/node --experimental-strip-types apps/node-host/src/index.ts'

# The app routes are the production snippet, pointed at this machine's own ports. Its private
# listener and the sites block after it are for the container installs.
grep -q '^(nix_app) {' "$release/deploy/Caddyfile.prod" && grep -q '^:8090 {' "$release/deploy/Caddyfile.prod" \
  || die 'this release lays out deploy/Caddyfile.prod differently; use the installer that shipped with it'
sed -e '/^:8090 {/,$d' -e 's|root \* /srv/nix/web|root * /opt/nix/current/web|' \
  -e 's|nix-api:8080|127.0.0.1:8080|g' -e 's|nix-node:8100|127.0.0.1:8100|g' \
  -e 's|nix-versitygw:7070|127.0.0.1:7070|g' "$release/deploy/Caddyfile.prod" > /etc/nix/Caddyfile.app
chmod 644 /etc/nix/Caddyfile.app
caddyfile=/etc/caddy/Caddyfile
if [ -f "$caddyfile" ] && ! grep -q 'deploy/bare/install.sh' "$caddyfile"; then
  cp -p "$caddyfile" "$caddyfile.before-nix"
fi
cat > "$caddyfile" <<EOF
# Written by deploy/bare/install.sh; the earlier file, if any, is Caddyfile.before-nix.
{
	# A browser that connects by IP address sends no server name.
	default_sni $host
}
import /etc/nix/Caddyfile.app

{\$NIX_PUBLIC_ORIGIN} {
	import nix_app
}
EOF
mkdir -p /etc/systemd/system/caddy.service.d
chmod 755 /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironmentFile=/etc/nix/web.env\n' > /etc/systemd/system/caddy.service.d/nix.conf
chmod 644 /etc/systemd/system/nix-*.service /etc/systemd/system/caddy.service.d/nix.conf
# Caddy runs as its own user and only reads these two.
chgrp caddy /etc/nix/web.env && chmod 640 /etc/nix/web.env
chmod o+x /etc/nix

say "starting Nix $version"
# Nothing but systemd-resolved answers for .localhost names, and Core fetches files by the origin.
if [[ "$host" == *.localhost ]] && ! getent hosts "$host" >/dev/null; then
  echo "127.0.0.1 $host" >> /etc/hosts
fi
systemctl daemon-reload
systemctl enable --quiet nix-objects nix-api nix-node caddy
systemctl restart nix-objects caddy
# $1: name, $2: URL, $3: extra curl option. Waits two minutes for it to answer.
wait_for() {
  local deadline=$((SECONDS + 120))
  until curl -fsS ${3:-} -o /dev/null "$2" 2>/dev/null; do
    [ "$SECONDS" -lt "$deadline" ] || die "$1 did not start; see: journalctl -u $1 -n 50"
    sleep 2
  done
}
wait_for caddy "$origin/web-config.json" -k
# Core fetches uploaded files through the origin and checks its certificate. One from Caddy's own
# authority (an IP address, a name without public DNS) is unknown to the machine until its root is added.
caddy_root=/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt
if [ "$scheme" = https ] && [ -f "$caddy_root" ] && ! curl -fsS -o /dev/null "$origin/web-config.json" 2>/dev/null; then
  install -m 644 "$caddy_root" /usr/local/share/ca-certificates/nix-caddy-local.crt
  update-ca-certificates >/dev/null 2>&1
  echo "install: $origin uses a certificate from Caddy's own authority. Browsers will warn about it;"
  echo "install: to stop that, add $caddy_root to each device's trusted roots."
fi
systemctl restart nix-api nix-node
wait_for nix-api "$core/healthz"
wait_for nix-node "$collab/healthz"
wait_for nix-node http://127.0.0.1:8302/healthz

printf '\nNix is running at %s\n\n' "$origin"
if [ "$new_install" = true ]; then
  printf '  Open this link to create the first account (it becomes the administrator):\n\n    %s/setup#code=%s\n\n' "$origin" "$setup_code"
else
  echo "  Sign in with your email and password. The setup code is setup_code in $secrets."
fi
echo '  Add people from People in the settings; they get a one-time link to set a password.'
printf '\nSettings: /etc/nix   Data: /var/lib/nix and the Postgres database "nix"\n'
echo 'Upgrade:  run this installer again with --version <newer release>'
echo 'Logs:     journalctl -u nix-api -u nix-node -u nix-objects -u caddy -f'
