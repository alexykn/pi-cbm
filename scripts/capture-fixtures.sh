#!/usr/bin/env bash
# Capture the raw codebase-memory-mcp CLI contract for one binary version.
#
#   scripts/capture-fixtures.sh <binary> <version>
#
# Writes, per case, to test/fixtures/cbm-<version>/:
#   <tool>.<case>.json        raw stdout, verbatim (JSON envelope, or tree text)
#   <tool>.<case>.meta.json   { invocation, args_json, exit_code, duration_ms, stderr }
#
# The cache is always an isolated temp dir, so the user's real cbm cache and
# ~/.cache are never touched.
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
FIXTURE_REPO=${CBM_FIXTURE_REPO:-/tmp/cbm-fixture-repo}
OUT="$ROOT/test/fixtures/cbm-$VER"

if [[ ! -d $FIXTURE_REPO/.git ]]; then
  cat >&2 <<EOF
fixture repo missing: $FIXTURE_REPO
create it with:
  rm -rf $FIXTURE_REPO && mkdir -p $FIXTURE_REPO
  cp -r $ROOT/src $FIXTURE_REPO/src
  git -C $FIXTURE_REPO init -q && git -C $FIXTURE_REPO add -A
  git -C $FIXTURE_REPO -c user.email=fixture@example.com -c user.name=fixture commit -qm fixture
EOF
  exit 2
fi

CACHE=$(mktemp -d "/tmp/cbm-capture-$VER-XXXXXX")
export CBM_CACHE_DIR=$CACHE
mkdir -p "$CACHE"
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

# capture_raw <name> <args...> -- exact invocation, no --json wrapper.
capture_raw() {
  local name=$1
  shift
  _record "$name" "$BIN $*" "" "$BIN" "$@"
}

echo "capturing cbm $VER from $BIN" >&2
echo "fixture repo $FIXTURE_REPO, cache $CACHE" >&2

git -C "$FIXTURE_REPO" checkout -- . 2>/dev/null || true

# --- version -----------------------------------------------------------------
capture_raw version.long-flag --version

# --- index (must run first) --------------------------------------------------
IDX="{\"format\":\"json\",\"repo_path\":\"$FIXTURE_REPO\",\"mode\":\"full\"}"
capture index_repository first "$IDX"
capture index_repository second "$IDX"

# cbm names a project from its absolute path (leading / dropped, / -> -).
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
  _record list_projects.format-flag "cli --json list_projects --format json" "" \
    "$BIN" cli --json list_projects --format json
fi

# --- search_graph ------------------------------------------------------------
capture search_graph name-pattern "{\"format\":\"json\",\"project\":\"$PROJECT\",\"name_pattern\":\"callTool\"}"
capture search_graph query "{\"format\":\"json\",\"project\":\"$PROJECT\",\"query\":\"index coordinator\",\"limit\":5}"
capture search_graph qn-pattern "{\"format\":\"json\",\"project\":\"$PROJECT\",\"qn_pattern\":\".*client.*CbmClient.*\",\"limit\":5}"
capture search_graph label "{\"format\":\"json\",\"project\":\"$PROJECT\",\"label\":\"Method\",\"limit\":3}"
if is_012; then
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

# detect_changes needs a dirty worktree, so it runs last.
printf '\n// capture-fixtures marker\n' >>"$FIXTURE_REPO/src/shared/strings.ts"
capture detect_changes dirty "{\"format\":\"json\",\"project\":\"$PROJECT\"}"

echo "done: $OUT" >&2
