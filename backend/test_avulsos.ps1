$ErrorActionPreference = "Stop"

$Base = "https://127.0.0.1:8000"
$OutDir = Join-Path (Get-Location) "out"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# Se usar autenticação, preencha aqui (sem "Bearer", o script adiciona)
$TOKEN = ""

function CurlJson($method, $url, $body, $outfile) {
  $tmpResp = Join-Path $env:TEMP ("resp_" + [guid]::NewGuid().ToString("N") + ".json")
  $tmpBody = $null

  $args = @(
    "-k",
    "-sS",
    "-X", $method,
    $url,
    "-o", $tmpResp,
    "-w", "%{http_code}"
  )

  if ($TOKEN -and $TOKEN.Trim().Length -gt 0) {
    $args += @("-H", "Authorization: Bearer $TOKEN")
  }

  if ($body) {
    # JSON 100% seguro: grava UTF-8 sem BOM e manda via --data-binary @arquivo
    $tmpBody = Join-Path $env:TEMP ("body_" + [guid]::NewGuid().ToString("N") + ".json")
    [System.IO.File]::WriteAllText($tmpBody, $body, (New-Object System.Text.UTF8Encoding($false)))

    $args += @(
      "-H", "Content-Type: application/json",
      "--data-binary", "@$tmpBody"
    )
  }

  $status = & curl.exe @args
  $resp = Get-Content $tmpResp -Raw
  $resp | Out-File -Encoding utf8 $outfile

  # cleanup
  if (Test-Path $tmpResp) { Remove-Item $tmpResp -Force -ErrorAction SilentlyContinue }
  if ($tmpBody -and (Test-Path $tmpBody)) { Remove-Item $tmpBody -Force -ErrorAction SilentlyContinue }

  if ([int]$status -ge 400) {
    throw "HTTP $status :: $url :: $resp"
  }

  return $resp
}

$results = @()

try {
  $f = Join-Path $OutDir "01_avulsos.json"
  CurlJson "GET" "$Base/avulsos" $null $f | Out-Null
  $results += "01 /avulsos -> OK"
} catch { $results += "01 /avulsos -> FAIL: $($_.Exception.Message)" }

try {
  $f = Join-Path $OutDir "02_minha.json"
  CurlJson "GET" "$Base/avulsos/minha?encarregado_id=105" $null $f | Out-Null
  $results += "02 /avulsos/minha -> OK"
} catch { $results += "02 /avulsos/minha -> FAIL: $($_.Exception.Message)" }

try {
  $f = Join-Path $OutDir "03_distribuir.json"
  $body = @{
    kit_id = $null
    encarregado_id = 105
    subresponsavel_id = 1326
    pin = "940244"
    patrimonio = "AVU-TESTE-0001"
  } | ConvertTo-Json -Depth 10 -Compress

  CurlJson "POST" "$Base/movimentos/distribuir" $body $f | Out-Null
  $results += "03 POST /movimentos/distribuir (avulso) -> OK"
} catch { $results += "03 POST /movimentos/distribuir (avulso) -> FAIL: $($_.Exception.Message)" }

try {
  $f = Join-Path $OutDir "04_recolher.json"
  $body2 = @{
    kit_id = $null
    encarregado_id = 105
    patrimonio = "AVU-TESTE-0001"
  } | ConvertTo-Json -Depth 10 -Compress

  CurlJson "POST" "$Base/movimentos/recolher" $body2 $f | Out-Null
  $results += "04 POST /movimentos/recolher (avulso) -> OK"
} catch { $results += "04 POST /movimentos/recolher (avulso) -> FAIL: $($_.Exception.Message)" }

"`n===== RESUMO ====="
$results | ForEach-Object { $_ }
"`nArquivos gerados em: $OutDir"
