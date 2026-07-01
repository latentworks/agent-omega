#!/bin/sh
# Agent Omega vault backend for macOS — the darwin counterpart of secrets.ps1 (Windows DPAPI).
# Mirrors the exact CLI contract the sidecar depends on:  get NAME | set NAME VALUE | list | rm NAME
# Storage: ONE login-Keychain generic-password item (service "agent-omega", account "vault")
# whose secret value is a JSON { NAME: value, ... } map. The single-blob model dodges the
# "enumerate all items" weakness of the `security` CLI. Guarantees carried over from secrets.ps1:
#   - never prints a value except for `get`
#   - `set` refuses an empty value (an empty value would hang an interactive prompt)
#   - encrypted at rest + login-scoped (the login Keychain's job)
set -eu
SERVICE="agent-omega"
ACCOUNT="vault"
PY="/usr/bin/python3"

blob() { security find-generic-password -s "$SERVICE" -a "$ACCOUNT" -w 2>/dev/null || printf '{}'; }
save() { security add-generic-password -U -s "$SERVICE" -a "$ACCOUNT" -w "$1" >/dev/null 2>&1; }

case "${1:-}" in
  get)
    name="${2:-}"
    [ -n "$name" ] || { printf 'no secret named\n'; exit 0; }
    blob | "$PY" -c 'import sys,json
name=sys.argv[1]
try: d=json.load(sys.stdin)
except Exception: d={}
v=d.get(name) if isinstance(d,dict) else None
sys.stdout.write(v if isinstance(v,str) else "no secret named "+name)' "$name"
    ;;
  set)
    name="${2:-}"; val="${3:-}"
    [ -n "$name" ] || { echo "name required" >&2; exit 1; }
    [ -n "$val" ]  || { echo "value required" >&2; exit 1; }
    nb=$(blob | "$PY" -c 'import sys,json
name,val=sys.argv[1],sys.argv[2]
try: d=json.load(sys.stdin)
except Exception: d={}
if not isinstance(d,dict): d={}
d[name]=val
sys.stdout.write(json.dumps(d))' "$name" "$val")
    save "$nb"
    ;;
  list)
    blob | "$PY" -c 'import sys,json
try: d=json.load(sys.stdin)
except Exception: d={}
ks=list(d.keys()) if isinstance(d,dict) else []
sys.stdout.write("\n".join(ks) if ks else "(vault empty)")'
    ;;
  rm)
    name="${2:-}"
    [ -n "$name" ] || { echo "name required" >&2; exit 1; }
    nb=$(blob | "$PY" -c 'import sys,json
name=sys.argv[1]
try: d=json.load(sys.stdin)
except Exception: d={}
if isinstance(d,dict): d.pop(name,None)
sys.stdout.write(json.dumps(d if isinstance(d,dict) else {}))' "$name")
    save "$nb"
    ;;
  *)
    echo "usage: secrets.sh {get NAME|set NAME VALUE|list|rm NAME}" >&2
    exit 2
    ;;
esac
