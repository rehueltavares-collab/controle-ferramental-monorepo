param(
  [string]$Base = "https://api-ferramental.local:8000",
  [int]$KitId = 8
)

# Estamos em: backend/scripts/http
# Subir para: backend/
$BackendRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $BackendRoot | Out-Null

$LoginRehuel   = "scripts/http/login_rehuel.json"
$LoginAdmin    = "scripts/http/login_admin.json"
$BodyDevKit    = "scripts/http/body_dev_kit.json"
$AdminRejeitar = "scripts/http/admin_rejeitar.json"
$AdminAprovar  = "scripts/http/admin_aprovar.json"

function Assert-File($p) {
  if (-not (Test-Path $p)) { throw "Arquivo não encontrado: $p (cwd=$((Get-Location).Path))" }
}

Assert-File $LoginRehuel
Assert-File $LoginAdmin
Assert-File $AdminRejeitar

# 1) Login funcionário
$login = curl.exe -k -s -X POST "$Base/auth/login" `
  -H "Content-Type: application/json" `
  --data-binary "@$LoginRehuel"

$token = ($login | ConvertFrom-Json).access_token
if (-not $token) { throw "Falha no login rehuel. Resposta: $login" }

# 2) Criar solicitação (devolução kit)
Set-Content -Encoding utf8 -Path $BodyDevKit -Value ("{`"tipo`":`"DEVOLUCAO_KIT`",`"kit_id`":" + $KitId + "}")
Assert-File $BodyDevKit

$createdJson = curl.exe -k -s -X POST "$Base/solicitacoes/operacao/" `
  -H "Content-Type: application/json" `
  -H "Authorization: Bearer $token" `
  --data-binary "@$BodyDevKit"

$created = $createdJson | ConvertFrom-Json
if (-not $created.id) { throw "Falha ao criar solicitação. Resposta: $createdJson" }
"CRIADA: id=$($created.id) status=$($created.status)"

# 3) Login admin
$loginA = curl.exe -k -s -X POST "$Base/auth/login" `
  -H "Content-Type: application/json" `
  --data-binary "@$LoginAdmin"

$tokenA = ($loginA | ConvertFrom-Json).access_token
if (-not $tokenA) { throw "Falha no login admin. Resposta: $loginA" }

# 4) Listar pendentes
$pendentesJson = curl.exe -k -s "$Base/admin/solicitacoes/operacao/?status=PENDENTE" `
  -H "Authorization: Bearer $tokenA"

$pendentes = $pendentesJson | ConvertFrom-Json
$pendentes | Select-Object id,tipo,kit_id,item_id,status,criado_em | Format-Table -AutoSize

# 5) Rejeitar a recém-criada (troque para aprovar se quiser)
$solId = $created.id
$rejeitadaJson = curl.exe -k -s -X POST "$Base/admin/solicitacoes/operacao/$solId/rejeitar" `
  -H "Authorization: Bearer $tokenA" `
  -H "Content-Type: application/json" `
  --data-binary "@$AdminRejeitar"

"REJEITADA: $rejeitadaJson"
