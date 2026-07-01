#!/usr/bin/env python
"""Web access for the OpenCode local agents — STANDALONE, no server, with a visible call trace.

Local Agent / anon-web (the app) is retired. Its search engine (the `anonweb` package) lives on:
this bridge calls it directly via the anon-web venv Python. It now prints a readable, step-by-step
view of each web call (searching -> results -> reading each page -> done, then the numbered results)
so you can WATCH the web work happen in the OpenCode terminal — the way the local app showed it.

Usage:
  python web.py search "<query>" [n]     # web search (+ clean page text per hit)
  python web.py read "<url>"             # fetch ONE page as clean text
"""
import sys
import json
import os
import subprocess
import socket
import ipaddress
from urllib.parse import urlparse

VENV = os.environ.get("AGENT_OMEGA_ANONWEB_VENV", "")  # path to the anon-web venv python; web search needs the optional anon-web component (see SETUP.md)

# Runs inside the anon-web venv (has lxml/trafilatura + the anonweb package).
# Progress steps go to STDERR (the live call trace); the JSON result goes to STDOUT.
ENGINE = (
    "import sys, json\n"
    "sys.path.insert(0, r'" + os.environ.get("AGENT_OMEGA_ANONWEB", "") + "')\n"
    "from anonweb import web_search, fetch_and_extract\n"
    "def prog(ev):\n"
    "    k = ev[0]\n"
    "    if k == 'search': sys.stderr.write('  searching: %s\\n' % ev[1])\n"
    "    elif k == 'results': sys.stderr.write('  %s -> %s hits\\n' % (ev[1], ev[2]))\n"
    "    elif k == 'fetch': sys.stderr.write('  reading %s\\n' % ev[1])\n"
    "    elif k == 'done': sys.stderr.write('  done: %s pages read\\n' % ev[1])\n"
    "    sys.stderr.flush()\n"
    "mode = sys.argv[1]; arg = sys.argv[2]\n"
    "if mode == 'search':\n"
    "    n = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3].isdigit() else 5\n"
    "    print(json.dumps(web_search(arg, n=n, fetch=True, on_progress=prog)))\n"
    "elif mode == 'read':\n"
    "    print(json.dumps(fetch_and_extract(arg)))\n"
)


def _domain(u):
    try:
        return urlparse(u).netloc.replace("www.", "")
    except Exception:
        return u


def _fmt_search(trace, data):
    out = []
    if trace.strip():
        out.append(trace.rstrip())
    results = data.get("results", [])
    out.append('\nweb search: "%s"  —  %d results' % (data.get("query", ""), len(results)))
    for i, r in enumerate(results, 1):
        tier = r.get("tier", "")
        out.append('\n[%d] %s  (%s)%s' % (i, r.get("title", "(no title)"),
                                          _domain(r.get("url", "")), ("  · " + tier) if tier else ""))
        out.append("    " + r.get("url", ""))
        if r.get("snippet"):
            out.append("    " + r["snippet"])
        txt = (r.get("text") or "").strip().replace("\n", " ")
        if txt:
            out.append("    " + txt[:1500] + (" …" if len(txt) > 1500 else ""))
    return "\n".join(out)


def _fmt_read(data):
    if not data.get("ok"):
        return "could not read %s — %s" % (data.get("url", ""), data.get("error", "unknown"))
    txt = (data.get("text") or "").strip()
    return "read %s  (%s, %s chars)\n\n%s" % (data.get("url", ""), data.get("method", "?"),
                                              data.get("chars", 0), txt)


def _blocked_url(u):
    """SSRF guard: only http(s) to PUBLIC hosts. Block loopback / private / link-local
    (the local model ports, the control socket, cloud metadata at 169.254.169.254)."""
    try:
        p = urlparse(u)
    except Exception:
        return "unparseable URL"
    if p.scheme not in ("http", "https"):
        return "only http/https URLs are allowed"
    host = (p.hostname or "").lower()
    if not host:
        return "missing host"
    if host == "localhost" or host.endswith(".local") or host.endswith(".internal"):
        return "internal host blocked"
    # literal IP in ANY notation Python parses -> check directly, before DNS
    try:
        if not ipaddress.ip_address(host).is_global:
            return "non-global IP blocked (SSRF guard)"
    except ValueError:
        pass  # not a literal IP -> resolve below
    # hostname -> require EVERY resolved address to be global; FAIL CLOSED on error
    try:
        infos = socket.getaddrinfo(host, None)
    except Exception:
        return "could not resolve host — blocked (SSRF guard)"
    for info in infos:
        try:
            if not ipaddress.ip_address(info[4][0]).is_global:
                return "resolves to a non-global address — blocked (SSRF guard)"
        except ValueError:
            return "unparseable resolved address — blocked (SSRF guard)"
    return None


def main():
    a = sys.argv[1:]
    if len(a) < 2 or a[0] not in ("search", "read"):
        sys.stderr.write('usage: web.py search "<query>" [n]  |  web.py read "<url>"\n')
        sys.exit(2)
    if a[0] == "read":
        blocked = _blocked_url(a[1])
        if blocked:
            print("refused to read %s — %s" % (a[1], blocked))
            return
    try:
        r = subprocess.run([VENV, "-c", ENGINE] + a,
                           capture_output=True, text=True, timeout=120)
    except Exception as e:
        print("web engine failed to launch: %s" % e)
        return
    if r.returncode != 0 or not r.stdout.strip():
        print("web engine error: %s" % ((r.stderr or "").strip()[:500] or "no output"))
        return
    try:
        data = json.loads(r.stdout)
    except Exception:
        print(r.stdout)  # fall back to raw if it isn't JSON for some reason
        return
    print(_fmt_search(r.stderr, data) if a[0] == "search" else _fmt_read(data))


if __name__ == "__main__":
    main()
