#!/usr/bin/env pwsh
# Architrave — design<->code reconciliation gate (PowerShell / Windows).
# Mirror of gates/reconcile.sh. Exit 0 = reconciled/N-A, 1 = DRIFT, 2 = error.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Find-Root { $d=(Get-Location).Path; while ($d) { if (Test-Path (Join-Path $d 'architrave.config.json')) { return $d }; $p=Split-Path $d -Parent; if ($p -eq $d -or [string]::IsNullOrEmpty($p)) { break }; $d=$p }; return $null }
$root = Find-Root
if (-not $root) { [Console]::Error.WriteLine('reconcile: architrave.config.json not found'); exit 2 }
Set-Location $root
$cfg = Get-Content 'architrave.config.json' -Raw | ConvertFrom-Json
function Get-Field($n) { if ($cfg.PSObject.Properties.Name -contains $n) { return [string]$cfg.$n }; return '' }

if ((Get-Field 'kind') -eq 'knowledge') {
  Write-Host 'reconcile: UI design reconciliation not applicable for knowledge profile; skipping (PASS)'; exit 0
}
$tokens = Get-Field 'tokens'; $tokenBuild = Get-Field 'tokenBuild'
if ([string]::IsNullOrWhiteSpace($tokens) -or [string]::IsNullOrWhiteSpace($tokenBuild)) {
  Write-Host 'reconcile: tokens/tokenBuild not configured — design<->code SSOT not wired yet; skipping (PASS)'; exit 0
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Write-Host "reconcile: git not found — run '$tokenBuild' and review manually; skipping"; exit 0 }
git rev-parse --is-inside-work-tree 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host 'reconcile: not a git work tree — skipping'; exit 0 }

$before = @(git status --porcelain=v1 --untracked-files=all)
Write-Host "== regenerate from tokens: $tokenBuild =="
$global:LASTEXITCODE = 0
try { Invoke-Expression $tokenBuild } catch { Write-Host "reconcile: token build FAILED ($($_.Exception.Message))"; exit 2 }
if ($LASTEXITCODE -ne 0) { Write-Host 'reconcile: token build FAILED'; exit 2 }
$after = @(git status --porcelain=v1 --untracked-files=all)

$difference = Compare-Object -ReferenceObject $before -DifferenceObject $after
if (-not $difference) {
  Write-Host 'reconcile: PASS — token generation produced no additional changes'; exit 0
} else {
  Write-Host 'reconcile: DRIFT — token generation changed the worktree:'
  $difference | Format-Table -AutoSize
  Write-Host 'Fix: commit the generated output; or if the design legitimately changed, update tokens first, then regenerate.'
  exit 1
}
