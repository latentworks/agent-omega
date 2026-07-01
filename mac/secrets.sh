#!/bin/sh
# Agent Omega vault backend for macOS — the darwin counterpart of secrets.ps1 (Windows DPAPI).
# CLI contract the sidecar depends on:  get NAME | set NAME VALUE | list | rm NAME
#
# Storage: ONE login-Keychain generic-password item (service "agent-omega", account "vault")
# whose secret value is newline-delimited "NAME<TAB>VALUE" records. Uses ONLY base-macOS tools
# (/usr/bin/security + /usr/bin/awk) — deliberately NO python3/plutil, which on a pristine Mac
# would pop the "install Command Line Developer Tools" dialog. Encrypted at rest + login-scoped
# (the Keychain's job). Guarantees carried over from secrets.ps1: never prints a value except
# for `get`; `set` refuses an empty value (which would otherwise hang an interactive prompt).
set -eu
SERVICE="agent-omega"
ACCOUNT="vault"
TAB="$(printf '\t')"

# The blob holds tab/newline records, which are control chars — and `security -w` returns any
# value with control chars as HEX. So base64-wrap on write and unwrap on read; the stored
# Keychain value is then always printable and round-trips verbatim. (base64 is base-macOS.)
blob() { security find-generic-password -s "$SERVICE" -a "$ACCOUNT" -w 2>/dev/null | base64 -D 2>/dev/null || printf ''; }
save() { security add-generic-password -U -s "$SERVICE" -a "$ACCOUNT" -w "$(printf '%s' "$1" | base64 | tr -d '\n')" >/dev/null 2>&1; }

case "${1:-}" in
  get)
    name="${2:-}"
    [ -n "$name" ] || { printf 'no secret named\n'; exit 0; }
    blob | awk -F"$TAB" -v k="$name" '$1==k{print $2; found=1} END{if(!found) print "no secret named " k}'
    ;;
  set)
    name="${2:-}"; val="${3:-}"
    [ -n "$name" ] || { echo "name required" >&2; exit 1; }
    [ -n "$val" ]  || { echo "value required" >&2; exit 1; }
    case "$name$val" in *"$TAB"*) echo "name/value may not contain a tab character" >&2; exit 1;; esac
    new="$(blob | awk -F"$TAB" -v k="$name" -v v="$val" '$1!=k && NF{print} END{print k FS v}')"
    save "$new"
    ;;
  list)
    out="$(blob | awk -F"$TAB" 'NF{print $1}')"
    [ -n "$out" ] && printf '%s\n' "$out" || printf '(vault empty)\n'
    ;;
  rm)
    name="${2:-}"
    [ -n "$name" ] || { echo "name required" >&2; exit 1; }
    new="$(blob | awk -F"$TAB" -v k="$name" '$1!=k && NF{print}')"
    save "$new"
    ;;
  *)
    echo "usage: secrets.sh {get NAME|set NAME VALUE|list|rm NAME}" >&2
    exit 2
    ;;
esac
