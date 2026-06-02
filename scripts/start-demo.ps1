$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

function Import-DotEnv {
  param([string]$Path)
  if (!(Test-Path $Path)) {
    return
  }
  Get-Content $Path | ForEach-Object {
    $Line = $_.Trim()
    if ($Line -and !$Line.StartsWith("#") -and $Line.Contains("=")) {
      $Parts = $Line.Split("=", 2)
      $Name = $Parts[0].Trim()
      $Value = $Parts[1].Trim().Trim('"').Trim("'")
      if ($Name -match '^(CIVILIZATION_TOWN_|OPENAI_)') {
        [Environment]::SetEnvironmentVariable($Name, $Value, "Process")
      }
    }
  }
}

function Resolve-Core {
  if ($env:CIVILIZATION_TOWN_CORE) {
    return $env:CIVILIZATION_TOWN_CORE
  }
  $Candidates = @(
    (Join-Path $Root "bin\civilization-town-core.exe"),
    (Join-Path $Root "bin\civilization-town-core-windows-x64.exe")
  )
  foreach ($Candidate in $Candidates) {
    if (Test-Path $Candidate) {
      return $Candidate
    }
  }
  return (Join-Path $Root "bin\civilization-town-core.exe")
}

Import-DotEnv (Join-Path $Root ".env")

$Core = Resolve-Core
$HostName = if ($env:CIVILIZATION_TOWN_HOST) { $env:CIVILIZATION_TOWN_HOST } else { "127.0.0.1" }
$Port = if ($env:CIVILIZATION_TOWN_PORT) { $env:CIVILIZATION_TOWN_PORT } else { "4183" }

if (!(Test-Path $Core)) {
  Write-Error "Core runtime not found: $Core. Download civilization-town-core-windows-x64.exe from GitHub Releases and place it in .\bin\."
}

& $Core serve `
  --world (Join-Path $Root "examples\town") `
  --frontend (Join-Path $Root "frontend") `
  --listen "$HostName`:$Port" `
  --enable-remote-agents
