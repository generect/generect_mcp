#!/usr/bin/env bash
# Deploys generect_mcp on chronos. Runs as `mcp_user`, invoked ONLY as the
# forced command of the CI deploy key (see deploy/bootstrap-chronos.sh), so this
# script is the whole of what that key can do:
#
#   deploy [<40-hex sha>] bring the host to the CURRENT tip of origin/main. The
#                         sha, if given, is only checked: it must be on main
#                         (CI passes the commit that triggered it). A later push
#                         wins — the host always lands on the tip.
#   status                print what is running, change nothing
#
# The key can never move the host to an older commit. Allowing "any commit on
# main" would let a leaked key roll prod back onto a release with a known,
# already-fixed hole (0.5.5 → the consent-page XSS fixed in 0.5.6). Rolling
# back is done by this script itself, to whatever was running before, when a
# deploy fails — or by a human with a shell.
#
# Anything else is refused. The key cannot open a shell, forward ports or run a
# command of its own choosing (`restrict,command=` in authorized_keys).
#
# Single instance only: OAuth clients, auth codes and MCP sessions live in
# memory (ecosystem.config.cjs). A second process behind nginx would split
# them, so this script refuses to create one.

set -Eeuo pipefail

# This file lives inside the checkout it deploys, and `git checkout` below
# rewrites it. bash reads a script incrementally, so a file replaced under a
# running interpreter executes a mix of old and new lines. Run from a private
# copy instead.
if [ -z "${MCP_DEPLOY_COPY:-}" ]; then
  copy="$(mktemp "${TMPDIR:-/tmp}/mcp-deploy.XXXXXX")"
  cp "$0" "$copy"
  MCP_DEPLOY_COPY="$copy" exec bash "$copy" "$@"
fi
trap 'rm -f "$MCP_DEPLOY_COPY"' EXIT

APP=generect-mcp
DIR="${MCP_DIR:-$HOME/generect_mcp}"
PORT="${MCP_PORT:-3000}"
LOG="$HOME/mcp-deploy.log"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG" >&2; }
die() { log "FAIL: $*"; exit 1; }

# Non-interactive SSH does not read the login profile, so node/pm2 from nvm are
# not on PATH unless we load them.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null
command -v node >/dev/null || die "node not found (nvm not loaded?)"
command -v pm2 >/dev/null || die "pm2 not found"

read -r -a REQ <<<"${SSH_ORIGINAL_COMMAND:-deploy}"
ACTION="${REQ[0]:-deploy}"
TARGET="${REQ[1]:-}"

running_version() {
  # Must never fail: "nothing is listening" is a normal answer (cold start,
  # crashed process), and under `set -e -o pipefail` a failing curl here would
  # abort the whole deploy before it starts.
  { curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/" 2>/dev/null || true; } |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).version)}catch{console.log("")}})'
}

pm2_procs_for_dir() {
  # name<TAB>status for every pm2 process whose working dir is this checkout.
  pm2 jlist 2>/dev/null | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const dir=process.argv[1];
      for (const p of JSON.parse(s||"[]")) {
        const e=p.pm2_env||{};
        if ((e.pm_cwd||"").replace(/\/$/,"")===dir.replace(/\/$/,"")) console.log(p.name+"\t"+e.status+"\t"+(e.pm_uptime||0));
      }
    })' "$DIR"
}

case "$ACTION" in
  status)
    cd "$DIR"
    echo "commit:  $(git rev-parse --short HEAD) ($(git log -1 --format=%s | cut -c1-72))"
    echo "package: $(node -p "require('./package.json').version")"
    echo "serving: $(running_version)"
    pm2_procs_for_dir
    exit 0
    ;;
  deploy) ;;
  *) die "refused: only 'deploy [sha]' or 'status' are accepted" ;;
esac

if [ -n "$TARGET" ] && ! [[ "$TARGET" =~ ^[0-9a-f]{40}$ ]]; then
  die "refused: target must be a full 40-char commit sha"
fi

exec 9>"$HOME/.mcp-deploy.lock"
flock -n 9 || die "another deploy is running"

cd "$DIR"

# Never deploy over hand edits: a dirty tree on a prod host is somebody's fix
# that nobody committed, and `reset --hard` would erase it without a trace.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  git status --short >&2
  die "working tree has uncommitted changes — commit or stash them on the host first"
fi

# Exactly one pm2 process may run this checkout, and it must be ours by name.
mapfile -t PROCS < <(pm2_procs_for_dir)
for p in ${PROCS[@]+"${PROCS[@]}"}; do
  name="${p%%$'\t'*}"
  [ "$name" = "$APP" ] || die "pm2 process '$name' already runs $DIR — refusing to start a second instance"
done

git fetch --quiet --prune origin main
TIP="$(git rev-parse origin/main)"
if [ -n "$TARGET" ]; then
  git cat-file -e "${TARGET}^{commit}" 2>/dev/null || die "unknown commit $TARGET"
  git merge-base --is-ancestor "$TARGET" "$TIP" || die "refused: $TARGET is not on origin/main"
  [ "$TARGET" = "$TIP" ] || log "requested $TARGET, main has moved on — deploying the tip $TIP"
fi
TARGET="$TIP"

PREV="$(git rev-parse HEAD)"
PREV_VERSION="$(running_version)"
log "deploy $PREV -> $TARGET (was serving ${PREV_VERSION:-nothing})"

pm2_started_at() {
  pm2 jlist 2>/dev/null | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const p=JSON.parse(s||"[]").find(x=>x.name===process.argv[1]);
      console.log(p ? (p.pm2_env||{}).pm_uptime||0 : 0)
    })' "$APP"
}

build_and_start() {
  git checkout --quiet -B main "$1"
  npm ci --no-audit --no-fund --loglevel=error
  npm run build --silent
  # `reload` WITHOUT --update-env on purpose: it restarts the process with
  # exactly the environment pm2 stored when it was first started. --update-env
  # merges this SSH session's variables over that (measured: HOME and PATH get
  # replaced, variables the session does not have are kept), so the running
  # server's environment would drift with whatever the deploy session carries.
  if pm2 describe "$APP" >/dev/null 2>&1; then
    pm2 reload "$APP" >/dev/null
  else
    pm2 start ecosystem.config.cjs >/dev/null
  fi
  pm2 save >/dev/null
}

healthy_at() {
  local want="$1" got=""
  for _ in $(seq 1 30); do
    got="$(running_version)"
    [ "$got" = "$want" ] && return 0
    sleep 2
  done
  log "health: expected version $want, got '${got:-no answer}'"
  return 1
}

rollback() {
  log "rolling back to $PREV"
  build_and_start "$PREV" || true
  if [ -z "$PREV_VERSION" ]; then
    log "rollback done; nothing was serving before this deploy, so there is no version to confirm"
  elif healthy_at "$PREV_VERSION"; then
    log "rollback healthy at $PREV_VERSION"
  else
    log "ROLLBACK ALSO UNHEALTHY — manual attention needed"
  fi
}

STARTED_BEFORE="$(pm2_started_at)"

if ! build_and_start "$TARGET"; then
  rollback
  die "build or start failed for $TARGET"
fi

WANT="$(node -p "require('./package.json').version")"
if ! healthy_at "$WANT"; then
  rollback
  die "new build did not come up as $WANT"
fi

# A version match alone proves nothing when the commit did not bump the
# version: the OLD process would answer with the same number. Require an
# actual restart.
if [ "$(pm2_started_at)" = "$STARTED_BEFORE" ] && [ "$STARTED_BEFORE" != "0" ]; then
  rollback
  die "pm2 reported success but the process was not restarted"
fi

log "deployed $TARGET, serving $WANT"
echo "OK $TARGET $WANT"
