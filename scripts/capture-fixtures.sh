#!/usr/bin/env bash
# Capture the raw codebase-memory-mcp CLI contract for one binary version.
#
#   scripts/capture-fixtures.sh <binary> <version>
#
# Writes, per case, to test/fixtures/cbm-<version>/:
#   <tool>.<case>.json        raw stdout, verbatim (JSON envelope, or tree text)
#   <tool>.<case>.meta.json   { invocation, args_json, exit_code, duration_ms, stderr }
#
# Everything else lives in one fresh `mktemp -d` work dir that is removed on
# exit: the cbm cache (so the user's real cache and ~/.cache are never touched)
# and the fixture repos, which are built from a copy of this repo's src/. No
# existing checkout is ever read, reset, or modified.
set -euo pipefail

BIN=${1:-}
VER=${2:-}
if [[ -z $BIN || -z $VER ]]; then
  echo "usage: $0 <codebase-memory-mcp binary> <version>" >&2
  exit 2
fi
BIN=$(readlink -f "$BIN")
[[ -x $BIN ]] || { echo "not an executable: $BIN" >&2; exit 2; }

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/test/fixtures/cbm-$VER"

# Under /tmp rather than $TMPDIR so captured root paths stay short and neutral.
WORK=$(mktemp -d "/tmp/cbm-capture-$VER-XXXXXX")
# cbm 0.12 can still write cache/activity.db just after a call returns, so remove twice.
cleanup() {
  rm -rf "$WORK"
  sleep 1
  rm -rf "$WORK"
}
trap cleanup EXIT
CACHE="$WORK/cache"
FIXTURE_REPO="$WORK/cbm-fixture-repo"
export CBM_CACHE_DIR=$CACHE
mkdir -p "$CACHE"

# make_repo <dir> <source dir>: a one-commit git repo holding a copy of <source dir> as src/.
make_repo() {
  mkdir -p "$1"
  cp -R "$2" "$1/src"
  git -C "$1" init -q
  git -C "$1" add -A
  git -C "$1" -c user.email=fixture@example.com -c user.name=fixture commit -qm fixture
}
make_repo "$FIXTURE_REPO" "$ROOT/src"

rm -rf "$OUT"
mkdir -p "$OUT"

# 0.12-only cases: richer flags that 0.9.0 does not have.
is_012() { [[ $VER == 0.12* ]]; }

# _record <name> <invocation> <args_json> <cmd...>
# stdout -> <name>.json, plus <name>.meta.json with exit code, wall time, stderr.
_record() {
  local name=$1 inv=$2 args=$3
  shift 3
  local t0 t1 code ms
  t0=$(date +%s%N)
  set +e
  "$@" >"$OUT/$name.raw" 2>"$OUT/$name.err"
  code=$?
  set -e
  t1=$(date +%s%N)
  ms=$(( (t1 - t0) / 1000000 ))
  mv "$OUT/$name.raw" "$OUT/$name.json"

  META_OUT="$OUT/$name.meta.json" META_INV="$inv" META_ARGS="$args" \
  META_CODE="$code" META_MS="$ms" META_ERR="$OUT/$name.err" \
  node -e '
    const fs = require("fs");
    fs.writeFileSync(process.env.META_OUT, JSON.stringify({
      invocation: process.env.META_INV,
      args_json: process.env.META_ARGS,
      exit_code: Number(process.env.META_CODE),
      duration_ms: Number(process.env.META_MS),
      stderr: fs.readFileSync(process.env.META_ERR, "utf8"),
    }, null, 2) + "\n");
  '
  rm -f "$OUT/$name.err"
  printf '  %-38s exit=%s %sms\n' "$name" "$code" "$ms" >&2
}

# capture <tool> <case> <args_json>  -- args JSON on stdin, invoked as the client does.
capture() {
  local tool=$1 case=$2 args=$3
  _record "$tool.$case" "cli --json $tool  # stdin: $args" "$args" \
    bash -c "printf '%s' \"\$1\" | \"\$2\" cli --json \"\$3\"" _ "$args" "$BIN" "$tool"
}

# capture_argv <tool> <case> <args_json> -- raw JSON passed as a positional arg.
capture_argv() {
  local tool=$1 case=$2 args=$3
  _record "$tool.$case" "cli --json $tool '$args'" "$args" \
    "$BIN" cli --json "$tool" "$args"
}

# capture_flags <name> <args...> -- `cli --json <args...>`, as the client calls list_projects.
capture_flags() {
  local name=$1
  shift
  _record "$name" "cli --json $*" "" "$BIN" cli --json "$@"
}

# capture_raw <name> <args...> -- exact invocation, no --json wrapper.
capture_raw() {
  local name=$1
  shift
  _record "$name" "codebase-memory-mcp $*" "" "$BIN" "$@"
}

# index <repo> [name] -- index silently (setup for a later case, not a case itself).
index() {
  local args="{\"format\":\"json\",\"repo_path\":\"$1\",\"mode\":\"full\"${2:+,\"name\":\"$2\"}}"
  printf '%s' "$args" | "$BIN" cli --json index_repository >/dev/null
}

echo "capturing cbm $VER from $BIN" >&2
echo "work dir $WORK" >&2

# --- version -----------------------------------------------------------------
capture_raw version.long-flag --version

# --- index (must run first) --------------------------------------------------
# 0.12 takes an explicit name, so the project (and every qn prefix) stays
# tmp-cbm-fixture-repo although the repo now lives in a random temp dir.
# 0.9.0 has no `name` and derives the project from the path instead.
if is_012; then
  IDX="{\"format\":\"json\",\"repo_path\":\"$FIXTURE_REPO\",\"mode\":\"full\",\"name\":\"tmp-cbm-fixture-repo\"}"
else
  IDX="{\"format\":\"json\",\"repo_path\":\"$FIXTURE_REPO\",\"mode\":\"full\"}"
fi
capture index_repository first "$IDX"
capture index_repository second "$IDX"

PROJECT=$(node -e '
  const fs = require("fs");
  const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write((j.structuredContent ?? JSON.parse(j.content[0].text)).project ?? "");
' "$OUT/index_repository.first.json")
if [[ -z $PROJECT ]]; then
  echo "could not read the project name from index_repository.first.json" >&2
  exit 1
fi
echo "project $PROJECT" >&2

if is_012; then
  capture_raw index_repository.help cli index_repository --help
fi
capture index_status default "{\"format\":\"json\",\"project\":\"$PROJECT\"}"

# --- projects ----------------------------------------------------------------
# 0.12 ignores `format` when args arrive on stdin, so stdin-format stays tree
# text; only the flag/argv forms return JSON. See test/fixtures/README.md.
capture list_projects tree "{}"
capture list_projects stdin-format-ignored "{\"format\":\"json\"}"
capture_argv list_projects inline-args "{\"format\":\"json\"}"
if is_012; then
  capture_flags list_projects.format-flag list_projects --format json
  capture_raw list_projects.help cli list_projects --help
fi

# --- search_graph ------------------------------------------------------------
capture search_graph name-pattern "{\"format\":\"json\",\"project\":\"$PROJECT\",\"name_pattern\":\"callTool\"}"
capture search_graph query "{\"format\":\"json\",\"project\":\"$PROJECT\",\"query\":\"index coordinator\",\"limit\":5}"
capture search_graph qn-pattern "{\"format\":\"json\",\"project\":\"$PROJECT\",\"qn_pattern\":\".*client.*CbmClient.*\",\"limit\":5}"
capture search_graph label "{\"format\":\"json\",\"project\":\"$PROJECT\",\"label\":\"Method\",\"limit\":3}"
if is_012; then
  # Page 2 of the `label` case: proves `offset` is honoured and `next_offset` advances.
  capture search_graph label-page2 "{\"format\":\"json\",\"project\":\"$PROJECT\",\"label\":\"Method\",\"limit\":3,\"offset\":3}"
  capture search_graph fields "{\"format\":\"json\",\"project\":\"$PROJECT\",\"name_pattern\":\"callTool\",\"fields\":[\"signature\",\"parent_class\",\"start_line\",\"end_line\"]}"
fi
capture search_graph unknown-project "{\"format\":\"json\",\"project\":\"no-such-project\",\"name_pattern\":\"callTool\"}"

# --- snippets ----------------------------------------------------------------
QN="$PROJECT.src.cbm.client.CbmClient.callTool"
capture get_code_snippet known "{\"format\":\"json\",\"project\":\"$PROJECT\",\"qualified_name\":\"$QN\"}"
capture get_code_snippet unknown "{\"format\":\"json\",\"project\":\"$PROJECT\",\"qualified_name\":\"$PROJECT.nope.missing\"}"
capture get_code_snippet neighbors "{\"format\":\"json\",\"project\":\"$PROJECT\",\"qualified_name\":\"$QN\",\"include_neighbors\":true}"

# --- trace_path --------------------------------------------------------------
capture trace_path depth1 "{\"format\":\"json\",\"project\":\"$PROJECT\",\"function_name\":\"callTool\",\"mode\":\"calls\",\"depth\":1,\"direction\":\"both\"}"
capture trace_path depth3 "{\"format\":\"json\",\"project\":\"$PROJECT\",\"function_name\":\"callTool\",\"mode\":\"calls\",\"depth\":3,\"direction\":\"both\"}"
capture trace_path unknown "{\"format\":\"json\",\"project\":\"$PROJECT\",\"function_name\":\"noSuchFunction\",\"mode\":\"calls\",\"depth\":2}"

# --- other tools -------------------------------------------------------------
capture search_code compact "{\"format\":\"json\",\"project\":\"$PROJECT\",\"pattern\":\"resolveCbmBinary\",\"context\":2,\"limit\":10}"
capture get_architecture default "{\"format\":\"json\",\"project\":\"$PROJECT\"}"
capture get_graph_schema default "{\"format\":\"json\",\"project\":\"$PROJECT\"}"
capture query_graph labels-aggregate "{\"format\":\"json\",\"project\":\"$PROJECT\",\"query\":\"MATCH (n) RETURN labels(n), count(n)\"}"
capture query_graph projection "{\"format\":\"json\",\"project\":\"$PROJECT\",\"query\":\"MATCH (f:Function) RETURN f.name, f.file_path LIMIT 3\"}"

# detect_changes needs a dirty worktree, so it runs after the read-only cases.
printf '\n// capture-fixtures marker\n' >>"$FIXTURE_REPO/src/shared/strings.ts"
capture detect_changes dirty "{\"format\":\"json\",\"project\":\"$PROJECT\"}"

# --- several projects (last: earlier cases list one project) -----------------
if is_012; then
  # One root under two names: indexed by default (derived name) and again with
  # `name`. The default index must come first; once a root has a custom name,
  # re-indexing it without `name` updates that project instead.
  SHARED_REPO="$WORK/shared-root"
  make_repo "$SHARED_REPO" "$ROOT/src/shared"
  index "$SHARED_REPO"
  index "$SHARED_REPO" custom-shared-root
  capture_flags list_projects.shared-root list_projects --format json
  capture_flags list_projects.paged list_projects --format json --limit 1 --offset 1
fi

echo "done: $OUT" >&2
