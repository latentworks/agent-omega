# Agent Omega — Windows build entrypoint (the "Makefile.Windows" role).
#
# ONE codebase, TWO OS "hosts". The shared core (sidecar.mjs, ui/, config-template/, the
# opencode engine) is identical on every platform; only the desktop shell + vault differ:
#     Windows -> Program.cs         + scripts/secrets.ps1  (built here / by dotnet)
#     macOS   -> mac/AgentOmega.swift + mac/secrets.sh      (built by mac/build-app.sh / make)
#
# Usage:   .\build.ps1 deps  ;  .\build.ps1 build  ;  .\build.ps1 run
param([Parameter(Position=0)][string]$Target = "help")

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

switch ($Target) {
  "help" {
    Write-Host "Agent Omega build (Windows)"
    Write-Host "  .\build.ps1 deps     install sidecar + plugin npm deps (shared, both OSes)"
    Write-Host "  .\build.ps1 engine   check the opencode engine binary (engine\opencode.exe)"
    Write-Host "  .\build.ps1 build    dotnet build -c Release"
    Write-Host "  .\build.ps1 run      build (if needed) + launch"
    Write-Host "  .\build.ps1 clean    dotnet clean"
    Write-Host ""
    Write-Host "  macOS/Linux: use  make  (this script is the Windows entrypoint)."
  }
  "deps" {
    npm install
    npm install --prefix config-template/opencode
  }
  "engine" {
    if (Test-Path "engine\opencode.exe") { Write-Host "engine present -> engine\opencode.exe" }
    else { Write-Error "MISSING engine\opencode.exe — download it from the release into .\engine\ (see SETUP.md step 5)" }
  }
  "build" {
    dotnet build -c Release
    Write-Host "built -> .\bin\Release\net8.0-windows\agent-omega.exe"
  }
  "run" {
    dotnet build -c Release
    & ".\bin\Release\net8.0-windows\agent-omega.exe"
  }
  "clean" {
    dotnet clean
    if (Test-Path "bin") { Remove-Item -Recurse -Force "bin" }
    if (Test-Path "obj") { Remove-Item -Recurse -Force "obj" }
  }
  default { Write-Error "Unknown target '$Target' — run .\build.ps1 help" }
}
