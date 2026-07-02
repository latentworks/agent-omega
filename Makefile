# Agent Omega — cross-platform build entrypoint (macOS / Linux side).
#
# ONE codebase, TWO OS "hosts". The shared core (sidecar.mjs, ui/, config-template/,
# the opencode engine) is identical on every platform; only the desktop shell + vault
# differ per OS:
#     macOS   -> mac/AgentOmega.swift  + mac/secrets.sh   (built by mac/build-app.sh)
#     Windows -> Program.cs            + scripts/secrets.ps1 (built by dotnet / build.ps1)
#
# This Makefile is the Unix build entrypoint (the "Makefile.Darwin" role). On Windows,
# `make` isn't standard — use  build.ps1  (or `dotnet build -c Release`) instead.
#
# Usage:  make deps  →  make engine  →  make build   (then `make run`)

UNAME := $(shell uname -s)

.DEFAULT_GOAL := help

.PHONY: help deps engine build run install clean

help:
	@echo "Agent Omega build ($(UNAME))"
	@echo "  make deps     install sidecar + plugin npm deps (shared, both OSes)"
	@echo "  make engine   check the opencode engine binary is present (build it per docs/MAC_BRANCH.md if missing)"
	@echo "  make build    build the app for THIS OS (Linux: validate browser mode — no native shell)"
	@echo "  make run      build (if needed) + launch (Linux: browser mode)"
	@echo "  make install  build + install to /Applications (macOS)"
	@echo "  make clean    remove local build output"
	@echo ""
	@echo "  Windows: use  ./build.ps1  (this Makefile is the Unix entrypoint)."

# Shared, platform-agnostic: the sidecar deps and the plugin deps.
deps:
	npm install
	npm install --prefix config-template/opencode

# The engine is a per-arch binary built once from the fork (see docs/MAC_BRANCH.md Phase 0).
engine:
ifeq ($(UNAME),Darwin)
	@test -f engine/opencode && echo "engine present -> engine/opencode" || \
		{ echo "MISSING engine/opencode — build it: bun run packages/opencode/script/build.ts --single --skip-embed-web-ui (in the fork), then copy to engine/opencode"; exit 1; }
else
	@test -f engine/opencode && echo "engine present -> engine/opencode" || { command -v opencode >/dev/null && echo "engine on PATH -> opencode"; } || \
		{ echo "MISSING engine — cross-compile from the fork (OPENCODE_BUILD_OS=linux OPENCODE_BUILD_ARCH=x64 bun run packages/opencode/script/build.ts --single --skip-embed-web-ui), copy to engine/opencode, or install opencode on PATH (see SETUP-LINUX.md)"; exit 1; }
endif

build:
ifeq ($(UNAME),Darwin)
	sh mac/build-app.sh
else ifeq ($(UNAME),Linux)
	node scripts/linux-portability-check.mjs
	node scripts/smoke-linux.mjs
	@echo "Linux is browser-mode (no native shell to compile) — validated. Launch: make run  (see SETUP-LINUX.md)"
else
	@echo "On Windows use ./build.ps1 (or: dotnet build -c Release)"; exit 1
endif

run:
ifeq ($(UNAME),Darwin)
	sh mac/run.sh
else ifeq ($(UNAME),Linux)
	node scripts/run-linux.mjs
else
	@echo "on Windows launch .\\bin\\Release\\net8.0-windows\\agent-omega.exe"; exit 1
endif

install:
ifeq ($(UNAME),Darwin)
	sh mac/install.sh
else
	@echo "install target is macOS-only"; exit 1
endif

clean:
	rm -rf mac/build mac/AgentOmega mac/sidecar-bin _smoke
	@echo "cleaned macOS build output (bin/ obj/ are Windows-side, cleaned by dotnet)"
