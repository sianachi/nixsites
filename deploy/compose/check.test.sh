#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
bash -n deploy/compose/*.sh deploy/docker/build-and-push.sh deploy/k8s/deploy.sh deploy/install.sh deploy/install.test.sh
bash deploy/install.test.sh
node --check deploy/compose/smoke.mjs
bash deploy/compose/release.test.sh
# Validate real Compose interpolation, without printing credentials.
docker compose --env-file deploy/compose.prod.env.example -f deploy/compose.prod.yml --profile maintenance config --format json > "$fixture/compose.json"
# The opt-in identity bootstrap reads its values from the env file (placeholders only).
{ cat deploy/compose.prod.env.example; printf '%s\n' 'NIX_BOOTSTRAP_TENANT_NAME=Example Tenant' NIX_BOOTSTRAP_OIDC_PROJECT_ID=project-id; } > "$fixture/bootstrap.env"
docker compose --env-file "$fixture/bootstrap.env" -f deploy/compose.prod.yml --profile maintenance --profile bootstrap config --format json > "$fixture/compose-bootstrap.json"
python3 - "$fixture/compose.json" "$fixture/compose-bootstrap.json" "$fixture/compose-bootstrap-missing.json" <<'PY'
import json,sys
assert 'nix-identity-bootstrap' not in json.load(open(sys.argv[1]))['services']
c=json.load(open(sys.argv[2])); b=c['services']['nix-identity-bootstrap']
assert b['profiles']==['bootstrap'] and b['environment']['PGUSER']=='nix_migrator'
assert b['environment']['NIX_BOOTSTRAP_TENANT_NAME']=='Example Tenant'
assert b['environment']['NIX_BOOTSTRAP_OIDC_PROJECT_ID']=='project-id'
assert b['environment']['NIX_BOOTSTRAP_TENANT_ID']==''
# Rendered config keeps Compose's $$ escape; the container shell expands the variables.
cmd=' '.join(b['command'])
for flag in ['tenant_name="$$NIX_BOOTSTRAP_TENANT_NAME"','oidc_issuer="$$NIX_OIDC_ISSUER"','oidc_client_id="$$NIX_OIDC_CLIENT_ID"','oidc_project_id="$$NIX_BOOTSTRAP_OIDC_PROJECT_ID"','-f /seed/bootstrap_identity.sql']:
 assert flag in cmd, flag
assert any(v['target']=='/seed/bootstrap_identity.sql' and v.get('read_only') for v in b['volumes'])
b['environment']['NIX_BOOTSTRAP_TENANT_NAME']=''
json.dump(c,open(sys.argv[3],'w'))
PY
python3 - "$fixture/compose.json" <<'PY'
import json,sys
c=json.load(open(sys.argv[1])); s=c['services']
assert s['nix-versitygw']['image'].startswith('versity/versitygw:v1.7.0@sha256:')
assert 'nix-indexer' not in s and 'nix-opensearch' not in s
assert 'nix-opensearch-data' not in c['volumes']
assert not any('OpenSearch' in key for key in s['nix-api']['environment'])
assert s['nix-api']['image']=='ghcr.io/sianachi/nix/api:replace-with-commit-sha'
assert s['nix-import-worker']['image']=='ghcr.io/sianachi/nix/worker:replace-with-commit-sha'
assert c['volumes']['nix-versity-data']['name']=='nix-versity-data'
assert c['volumes']['nix-caddy-data']['name']=='nix-caddy-data'
assert s['nix-web']['environment']['NIX_OBJECT_STORE_BUCKET']=='nix-worker-jobs'
assert 'NIX_COLLAB_MIGRATOR_CONNECTION_STRING' not in s['nix-collab']['environment']
assert s['nix-collab-migrate']['environment']['NIX_COLLAB_MIGRATOR_CONNECTION_STRING']
assert s['nix-api']['environment']['Nix__Pets__WorkerUrl'] == 'http://nix-import-worker:8301'
assert s['nix-api']['environment']['Nix__Push__VapidPublicKey'] == 'replace-me-public-key'
assert 'NIX_PUSH_VAPID_PRIVATE_KEY' not in s['nix-api']['environment']
assert s['nix-notify-worker']['environment']['NIX_PUSH_VAPID_PRIVATE_KEY'] == 'replace-me'
# The api image is chiseled: it holds only /usr/bin/dotnet (no shell, wget, curl or /dev/tcp).
api_check = s['nix-api'].get('healthcheck', {}).get('test', [])
assert not api_check or (api_check[0] == 'CMD' and api_check[1] not in ('wget', 'curl', 'sh', 'bash')), api_check
assert s['nix-import-worker']['environment']['NIX_COMPANION_DATA_DIR'] == '/var/lib/nix-worker/companion'
assert any(v.get('source') == 'nix-companion-data' for v in s['nix-import-worker']['volumes'])
assert not s['nix-import-worker'].get('ports')
assert not any('companion' in name or 'codex' in name for name in s)
assert not s['nix-versitygw'].get('ports')
retired_observability = {'grafana', 'alloy', 'loki', 'docker-socket-proxy'}
assert retired_observability.isdisjoint(s)
assert {'docker-logs', 'observability', 'grafana-access'}.isdisjoint(c['networks'])
assert {'nix-loki-data', 'nix-alloy-data', 'nix-grafana-data'}.isdisjoint(c['volumes'])
assert s['nix-api']['environment']['Logging__Console__FormatterName'] == 'json'
for service in ['nix-import-worker', 'nix-export-worker', 'nix-plugin-worker', 'nix-calendar-worker', 'nix-notify-worker']:
 assert s[service]['healthcheck']['test'] == ['CMD', '/nix-worker', '--healthcheck']
assert s['nix-web']['healthcheck']['test'][0] == 'CMD'
assert not any(service.get('logging', {}).get('driver') == 'none' for service in s.values())
from pathlib import Path
edge=Path('deploy/Caddyfile.prod').read_text()
exchange=edge.split('handle /public/v1/auth/token {',1)[1].split('\n\thandle ',1)[0]
assert 'reverse_proxy nix-api:8080' in exchange
assert 'header_up X-Forwarded-For {$NIX_CLIENT_IP}' in exchange
assert s['nix-web']['environment']['NIX_CLIENT_IP'] == '{http.request.header.CF-Connecting-IP}'
# Sites on a shared domain: the label suffix reaches Core, serve and the edge; no wildcard is two levels deep.
assert s['nix-api']['environment']['Nix__Sites__DefaultHostLabelSuffix'] == ''
assert s['nix-api']['environment']['Nix__Sites__Cloudflare__DefaultHostnameZoneId'] == ''
assert s['nix-api']['environment']['Nix__Sites__Cloudflare__TunnelService'] == 'http://nix-sites-serve:8400'
assert 'NIX_SITES_CLOUDFLARE_API_TOKEN' not in s['nix-web']['environment']
assert 'NIX_SITES_DEFAULT_LABEL_SUFFIX' in s['nix-web']['environment']
serve=Path('deploy/compose.prod.yml').read_text().split('\n  nix-sites-serve:\n',1)[1].split('\n  nix-web:\n',1)[0]
assert 'NIX_SITES_DEFAULT_LABEL_SUFFIX: ${NIX_SITES_DEFAULT_LABEL_SUFFIX:-}' in serve
sites_block=edge.split('http://*.{$NIX_SITES_DOMAIN}:8090 {',1)[1]
assert '@site header_regexp Host (?i)^[a-z0-9-]+{$NIX_SITES_DEFAULT_LABEL_SUFFIX}\\.' in sites_block
assert 'respond 421' in sites_block and '*.*.' not in edge
PY
mkdir "$fixture/bin"
cat > "$fixture/bin/pdftotext" <<'PY'
#!/usr/bin/env python3
print('Nix release smoke test')
PY
cat > "$fixture/bin/nixctl" <<'PY'
#!/usr/bin/env python3
import sys,json,os,zipfile
args=sys.argv[4:]
with open(os.environ['TEST_LOG'],'a') as f: f.write(' '.join(args)+'\n')
command=args[0]
if command=='auth' and os.environ.get('FAIL_AUTH'):
 sys.stderr.write(os.environ['FAIL_AUTH']+'\n'); sys.exit(4)
elif command=='auth': print(json.dumps(dict(apiUrl=os.environ.get('TEST_API_URL','https://production.example'))))
elif command=='import':
 print(json.dumps(dict(rootItemId='smoke-root',createdCount=2,atomic=True,omissions=[],loss=[])))
elif command=='item' and '--parent' in args:
 print(json.dumps(dict(items=[dict(id='original-file',type='file')])))
elif command=='file':
 path=args[args.index('--out')+1]
 open(path,'w').write('Nix release smoke test\n\nStorage transfer and document conversion verification.\n')
 print('{}')
elif command=='export':
 assert args[args.index('--scope')+1]=='item'
 fmt=args[args.index('--format')+1]
 if os.environ.get('FAIL_EXPORT')==fmt: sys.exit(1)
 path=args[args.index('--out')+1]
 if fmt=='pdf': open(path,'wb').write(b'%PDF-1.4')
 else:
  with zipfile.ZipFile(path,'w') as z:
   z.writestr('word/document.xml' if fmt=='docx' else 'manifest.json','<doc>Nix release smoke test</doc>' if fmt=='docx' else '{}')
 print(json.dumps(dict(omissions=[],omitted=0)))
else: print('{}')
PY
chmod +x "$fixture/bin/"*
# The app index answers with the framing headers the edge sends (TEST_FRAME overrides X-Frame-Options).
cat > "$fixture/fetch.mjs" <<'JS'
globalThis.fetch = async () => new Response('', { headers: { 'content-security-policy': "default-src 'self'; frame-ancestors 'none'", 'x-frame-options': process.env.TEST_FRAME ?? 'DENY' } });
JS
export PATH="$fixture/bin:$PATH" NIXCTL_BIN="$fixture/bin/nixctl" NIXCTL_PROFILE=test NIX_SMOKE_WORKSPACE=test NIX_SMOKE_ORIGIN=https://production.example TEST_LOG="$fixture/calls" NODE_OPTIONS="--import $fixture/fetch.mjs"
node deploy/compose/smoke.mjs > "$fixture/result"
if TEST_FRAME=SAMEORIGIN node deploy/compose/smoke.mjs > "$fixture/framing" 2>&1; then
  echo 'smoke accepted an app that may be framed' >&2; exit 1
fi
rg -q "X-Frame-Options DENY" "$fixture/framing"
rg -q 'item rm smoke-root --workspace test' "$TEST_LOG"
rg -q 'Public import and export smoke checks passed' "$fixture/result"
: > "$TEST_LOG"
if TEST_API_URL=https://staging.example node deploy/compose/smoke.mjs > "$fixture/mismatch" 2>&1; then
  echo 'Smoke runner accepted the wrong instance' >&2; exit 1
fi
if rg -q '^import ' "$TEST_LOG"; then echo 'Origin mismatch mutated data' >&2; exit 1; fi
: > "$TEST_LOG"
# A refused release credential fails preflight by reason, names the profile and never echoes CLI diagnostics.
for kind in revoked expired; do
  case "$kind" in
    revoked) refusal="Personal access token 'tok-private-id' was revoked at 2026-09-01T10:00:00.0000000+00:00." ;;
    expired) refusal="Personal access token 'tok-private-id' expired at 2026-09-01T10:00:00.0000000+00:00." ;;
  esac
  if FAIL_AUTH="$refusal" node deploy/compose/smoke.mjs --preflight > "$fixture/credential" 2>&1; then
    echo "Preflight accepted a $kind token" >&2; exit 1
  fi
  rg -q "nixctl profile 'test' has an? $kind access token \\($kind 2026-09-01T10:00:00" "$fixture/credential"
  rg -q 'Rotate the release-check token' "$fixture/credential"
  if rg -q 'tok-private-id' "$fixture/credential"; then echo 'Preflight echoed CLI diagnostics' >&2; exit 1; fi
done
if FAIL_AUTH='connect ECONNREFUSED' node deploy/compose/smoke.mjs --preflight > "$fixture/credential" 2>&1; then
  echo 'Preflight accepted an unreachable origin' >&2; exit 1
fi
rg -q "nixctl profile 'test' could not authenticate" "$fixture/credential"
if rg -q '^(item|import) ' "$TEST_LOG"; then echo 'Credential failure ran further commands' >&2; exit 1; fi
: > "$TEST_LOG"
if FAIL_EXPORT=pdf node deploy/compose/smoke.mjs > "$fixture/failure" 2>&1; then
  echo 'Smoke runner accepted a failed PDF export' >&2; exit 1
fi
rg -q 'item rm smoke-root --workspace test' "$TEST_LOG"
if bash deploy/k8s/deploy.sh > "$fixture/k8s" 2>&1; then
  echo 'Kubernetes ran without explicit target selection' >&2; exit 1
fi
rg -q 'Kubernetes deployment is inactive' "$fixture/k8s"
if bash deploy/docker/build-and-push.sh > "$fixture/registry" 2>&1; then
  echo 'Registry build ran without explicit target selection' >&2; exit 1
fi
rg -q 'Default deployment is Docker Compose' "$fixture/registry"
# Exercise rollout ordering and failure containment without touching Docker services.
cat > "$fixture/bin/docker" <<'PYCODE'
#!/usr/bin/env python3
import sys,os,json
args=sys.argv[1:]
with open(os.environ['DOCKER_TEST_LOG'],'a') as f: f.write(' '.join(args)+'\n')
if args[0]=='ps':
 for service in ['nix-speech-worker', 'nix-indexer', 'nix-opensearch', 'grafana', 'alloy', 'loki', 'docker-socket-proxy']:
  if 'label=com.docker.compose.service='+service in args and os.environ.get('RETIRED_CONTAINERS'):
   print('retired-'+service)
elif 'config' in args and '--format' in args:
 c=json.load(open(os.environ['COMPOSE_TEST_CONFIG']))
 c['services']['nix-api']['environment']['Nix__Bff__PublicOrigin']='https://production.example'
 c['services']['nix-api']['environment']['Nix__Sites__Domain']=os.environ.get('SITES_DOMAIN','')
 print(json.dumps(c))
elif args[-2:]==['config','--services']:
 print('nix-api\nnix-sites-worker\nnix-sites-serve' if os.environ.get('SITES_PROFILE') else 'nix-mcp\nnix-api' if os.environ.get('MCP_PROFILE') else 'nix-api')
elif 'config' in args and '--images' in args:
 print('localhost/nix/api:test\nghcr.io/sianachi/nix/worker:test')
elif 'run' in args and args[-1]=='nix-migrate' and os.environ.get('FAIL_MIGRATION'):
 sys.exit(1)
elif 'run' in args and '--entrypoint' in args and '/bin/sh' in args and 'rabbitmq' in args and os.environ.get('FAIL_RELEASE_BINDS'):
 sys.exit(1)
PYCODE
chmod +x "$fixture/bin/docker"
export DOCKER_TEST_LOG="$fixture/docker-calls" COMPOSE_TEST_CONFIG="$fixture/compose.json"
bash deploy/compose/backup.test.sh
bash deploy/compose/backup.test.sh --fixture "$fixture/backup"
export NIX_DEPLOY_ENV="$root/deploy/compose.prod.env.example" NIX_BACKUP_REFERENCE="$fixture/backup"
echo '{}' > "$fixture/nixctl-config.json"
export NIXCTL_CONFIG="$fixture/nixctl-config.json"
# An unverified or free-text backup reference stops the rollout before Docker is touched.
for reference in fixture-backup "$fixture/missing-backup"; do
 if NIX_BACKUP_REFERENCE="$reference" bash deploy/compose/deploy.sh > "$fixture/deploy-no-backup" 2>&1; then
  echo "Rollout accepted backup reference $reference" >&2; exit 1
 fi
done
if [ -s "$DOCKER_TEST_LOG" ]; then echo 'Rollout touched Docker without a verified backup' >&2; exit 1; fi
# The host has no Node: deploy.sh reaches nixctl and smoke only through the release-tools image.
if rg -q '\bnode\b' deploy/compose/deploy.sh; then echo 'deploy.sh still calls node' >&2; exit 1; fi
mkdir "$fixture/nodeless"
printf '#!/bin/sh\necho "node called on the host" >&2\nexit 97\n' > "$fixture/nodeless/node"
chmod +x "$fixture/nodeless/node"
RETIRED_CONTAINERS=1 PATH="$fixture/nodeless:$PATH" bash deploy/compose/deploy.sh > "$fixture/deploy-result"
python3 - "$DOCKER_TEST_LOG" <<'PYCODE'
import sys
calls=open(sys.argv[1]).read().splitlines()
stop=next(i for i,s in enumerate(calls) if ' stop nix-web ' in s)
migrate=next(i for i,s in enumerate(calls) if s.endswith('run --rm --no-deps nix-migrate'))
doc=next(i for i,s in enumerate(calls) if s.endswith('run --rm --no-deps nix-collab-migrate'))
start=next(i for i,s in enumerate(calls) if ' up ' in s and s.endswith('nix-api nix-collab'))
pull=next(i for i,s in enumerate(calls) if s=='pull --quiet ghcr.io/sianachi/nix/worker:test')
assert not any(s.startswith('pull ') and 'localhost/' in s for s in calls)
assert pull < stop < migrate < doc < start
assert not any('--remove-orphans' in s or ' down ' in s for s in calls)
tools='ghcr.io/sianachi/nix/release-tools:replace-with-commit-sha'
smokes=[i for i,s in enumerate(calls) if s.startswith('run --rm ') and tools+' smoke' in s]
assert len(smokes)==2 and calls[smokes[0]].endswith(' smoke --preflight') and calls[smokes[1]].endswith(tools+' smoke')
assert calls.index('pull --quiet '+tools) < smokes[0] < stop < start < smokes[1]
# Writers stop before the infrastructure `up`, so a RabbitMQ recreate never meets a publisher.
infra=next(i for i,s in enumerate(calls) if ' up ' in s and s.endswith('postgres rabbitmq nix-versitygw'))
assert stop < infra < migrate
# The BackupRuns migration needs the nix_backup role; it is created idempotently before the migrator runs.
role=next(i for i,s in enumerate(calls) if 'exec -T postgres psql' in s and 'CREATE ROLE nix_backup NOLOGIN' in s and 'IF NOT EXISTS' in s and 'ALTER ROLE nix_backup NOLOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE' in s)
assert infra < role < migrate
bind_check=next(i for i,s in enumerate(calls) if 'run --rm --no-deps --entrypoint /bin/sh rabbitmq -c ' in s)
for service in ['nix-speech-worker', 'nix-indexer', 'nix-opensearch', 'grafana', 'alloy', 'loki', 'docker-socket-proxy']:
 retired=calls.index('stop retired-'+service)
 assert bind_check < retired < stop
 assert any('label=com.docker.compose.project=nix' in call and 'label=com.docker.compose.service='+service in call for call in calls)
assert len([call for call in calls if call.startswith('stop retired-')]) == 7
assert not any(' stop ' in call and 'nix-indexer' in call for call in calls)
assert not any(' up ' in call and 'nix-opensearch' in call for call in calls)
assert all(':/config/nixctl/config.json:ro' in calls[i] for i in smokes)
# Sites are not enabled in the example env, so the rollout leaves them alone.
assert not any(s in call.split() for call in calls for s in ('nix-sites-worker', 'nix-sites-serve', 'nix-mcp'))
PYCODE
# Enabled by profile or by domain, sites are pre-pulled, stopped with the writers and rolled with --wait.
for enable in SITES_PROFILE=1 SITES_DOMAIN=sites.example.test; do
 : > "$DOCKER_TEST_LOG"
 env "$enable" PATH="$fixture/nodeless:$PATH" bash deploy/compose/deploy.sh > "$fixture/deploy-sites"
 python3 - "$DOCKER_TEST_LOG" <<'PYCODE'
import sys
calls=open(sys.argv[1]).read().splitlines()
pull=next(s for s in calls if '--images' in s)
stop=next(s for s in calls if ' stop nix-web ' in s)
roll=next(s for s in calls if ' up ' in s and s.endswith(' nix-web cloudflared'))
for service in ['nix-sites-worker', 'nix-sites-serve']:
 assert service in pull.split() and service in stop.split() and service in roll.split(), service
assert '--wait' in roll.split()
PYCODE
done
# With the mcp profile on, nix-mcp is pulled, stopped and rolled with the release, sites still left alone.
: > "$DOCKER_TEST_LOG"
MCP_PROFILE=1 PATH="$fixture/nodeless:$PATH" bash deploy/compose/deploy.sh > "$fixture/deploy-mcp"
python3 - "$DOCKER_TEST_LOG" <<'PYCODE'
import sys
calls=open(sys.argv[1]).read().splitlines()
pull=next(s for s in calls if '--images' in s)
stop=next(s for s in calls if ' stop nix-web ' in s)
roll=next(s for s in calls if ' up ' in s and s.endswith(' nix-web cloudflared'))
assert all('nix-mcp' in s.split() for s in (pull, stop, roll))
assert not any('nix-sites-worker' in call.split() for call in calls)
PYCODE
# The drift preview must run before the first `up` can recreate a service.
python3 - "$DOCKER_TEST_LOG" <<'PYCODE'
import sys
calls=open(sys.argv[1]).read().splitlines()
drift=next(i for i,s in enumerate(calls) if s.endswith("config --hash *"))
assert drift < next(i for i,s in enumerate(calls) if ' up ' in s)
PYCODE
: > "$DOCKER_TEST_LOG"
if FAIL_RELEASE_BINDS=1 PATH="$fixture/nodeless:$PATH" bash deploy/compose/deploy.sh > "$fixture/deploy-unreadable" 2>&1; then
 echo 'Rollout accepted unreadable RabbitMQ release bind mounts' >&2; exit 1
fi
if rg -q ' stop | up |run --rm --no-deps nix-migrate' "$DOCKER_TEST_LOG"; then
 echo 'Rollout stopped or changed services with unreadable release bind mounts' >&2; exit 1
fi
: > "$DOCKER_TEST_LOG"
if FAIL_MIGRATION=1 PATH="$fixture/nodeless:$PATH" bash deploy/compose/deploy.sh > "$fixture/deploy-failure" 2>&1; then
 echo 'Rollout accepted a failed migration' >&2; exit 1
fi
if rg -q 'up .*nix-api nix-collab' "$DOCKER_TEST_LOG"; then
 echo 'Rollout restarted writers after a failed migration' >&2; exit 1
fi
# Identity bootstrap is opt-in, runs after the migrator, and is validated before writers stop.
if rg -q 'nix-identity-bootstrap' "$DOCKER_TEST_LOG"; then echo 'Rollout bootstrapped identity without opt-in' >&2; exit 1; fi
: > "$DOCKER_TEST_LOG"
NIX_BOOTSTRAP_IDENTITY=true COMPOSE_TEST_CONFIG="$fixture/compose-bootstrap.json" PATH="$fixture/nodeless:$PATH" bash deploy/compose/deploy.sh > "$fixture/deploy-bootstrap"
python3 - "$DOCKER_TEST_LOG" <<'PYCODE'
import sys
calls=open(sys.argv[1]).read().splitlines()
check=next(i for i,s in enumerate(calls) if '--profile bootstrap config --format json' in s)
stop=next(i for i,s in enumerate(calls) if ' stop nix-web ' in s)
migrate=next(i for i,s in enumerate(calls) if s.endswith('run --rm --no-deps nix-migrate'))
boot=next(i for i,s in enumerate(calls) if s.endswith('--profile bootstrap run --rm --no-deps nix-identity-bootstrap'))
presets=next(i for i,s in enumerate(calls) if s.endswith('run --rm --no-deps nix-template-presets'))
assert check < stop < migrate < boot < presets
PYCODE
for refused in missing invalid; do
 : > "$DOCKER_TEST_LOG"
 case "$refused" in
  missing) flag=true config="$fixture/compose-bootstrap-missing.json" ;;
  invalid) flag=yes config="$fixture/compose-bootstrap.json" ;;
 esac
 if NIX_BOOTSTRAP_IDENTITY="$flag" COMPOSE_TEST_CONFIG="$config" PATH="$fixture/nodeless:$PATH" bash deploy/compose/deploy.sh > "$fixture/deploy-bootstrap-$refused" 2>&1; then
  echo "Rollout accepted a $refused identity bootstrap" >&2; exit 1
 fi
 if rg -q ' stop |nix-identity-bootstrap$' "$DOCKER_TEST_LOG"; then echo "Rollout changed services before refusing a $refused identity bootstrap" >&2; exit 1; fi
done
rg -q 'needs NIX_BOOTSTRAP_TENANT_NAME' "$fixture/deploy-bootstrap-missing"
rg -q 'must be true or false' "$fixture/deploy-bootstrap-invalid"
bash deploy/compose/drift.test.sh
bash deploy/compose/prune.test.sh
bash deploy/compose/offsite.test.sh
bash deploy/compose/nightly.test.sh
echo 'Compose configuration, smoke success/failure cleanup, and default target checks passed.'
