# Imposta i "secret" su Fly.io leggendoli dal file .env (non li mostra a schermo).
# Uso:  .\set-fly-secrets.ps1 -App zubra-fun
param([string]$App = "zubra-fun")

$envPath = Join-Path $PSScriptRoot ".env"
if (-not (Test-Path $envPath)) { Write-Error "File .env non trovato in $PSScriptRoot"; exit 1 }

$pairs = @()
Get-Content $envPath | ForEach-Object {
  $line = $_.Trim()
  if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
    $pairs += $line
  }
}
if ($pairs.Count -eq 0) { Write-Error "Nessuna variabile trovata in .env"; exit 1 }

$names = ($pairs | ForEach-Object { ($_ -split "=",2)[0] }) -join ", "
Write-Host "Imposto su Fly ($App) queste variabili: $names" -ForegroundColor Cyan
& fly secrets set @pairs --app $App
Write-Host "Fatto." -ForegroundColor Green
