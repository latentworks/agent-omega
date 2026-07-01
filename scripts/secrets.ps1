# Agent Omega - minimal DPAPI secrets vault.
# API keys are encrypted at rest with Windows DPAPI (CurrentUser scope): readable only as the
# logged-in Windows user, never stored in plaintext, never written to code/logs. Values are only
# ever emitted by 'get'. The sidecar reads this via:  powershell -File secrets.ps1 get <NAME>
#
# Usage:  secrets.ps1 <get|set|list|remove> [name] [value]
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security | Out-Null

$Action = $args[0]; $Name = $args[1]; $Value = $args[2]
$Vault  = Join-Path $HOME '.agent-omega\vault.dat'

function Load {
  if (Test-Path $Vault) {
    try {
      $o = Get-Content $Vault -Raw | ConvertFrom-Json
      $h = @{}; $o.PSObject.Properties | ForEach-Object { $h[$_.Name] = $_.Value }
      return $h
    } catch { return @{} }
  }
  return @{}
}
function Save($h) {
  $dir = Split-Path $Vault
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  ($h | ConvertTo-Json -Compress) | Set-Content -Path $Vault -Encoding UTF8
}
function Protect([string]$s) {
  $b = [Text.Encoding]::UTF8.GetBytes($s)
  [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b, $null, 'CurrentUser'))
}
function Unprotect([string]$s) {
  $b = [Convert]::FromBase64String($s)
  [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser'))
}

$h = Load
switch ($Action) {
  'get'    { if ($h.ContainsKey($Name)) { Write-Output (Unprotect $h[$Name]) } }
  'set'    {
    if ([string]::IsNullOrEmpty($Value)) { Write-Error 'value required (usage: set <name> <value>)'; exit 1 }
    $h[$Name] = (Protect $Value); Save $h; Write-Output "stored $Name"
  }
  'list'   { if ($h.Count -eq 0) { Write-Output '(vault empty)' } else { $h.Keys | Sort-Object | ForEach-Object { Write-Output $_ } } }
  'remove' { if ($h.ContainsKey($Name)) { $h.Remove($Name) | Out-Null; Save $h }; Write-Output "removed $Name" }
  default  { Write-Error "unknown action '$Action' (use get|set|list|remove)"; exit 1 }
}
