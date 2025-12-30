$root    = "C:\Users\rehuel.tavares\Projetos\controle-ferramental-limpo"
$backend = Join-Path $root "backend"
$pwa     = Join-Path $root "pwa"
$venvAct = Join-Path $root ".venv\Scripts\Activate.ps1"

if (!(Test-Path $venvAct)) { throw "Nao achei a venv em: $venvAct" }
if (!(Test-Path $backend)) { throw "Nao achei a pasta backend em: $backend" }
if (!(Test-Path $pwa))     { throw "Nao achei a pasta pwa em: $pwa" }

# Cada aba: Powershell executa uma linha de comando completa
$cmdBackend = "& `"$venvAct`"; Set-Location `"$backend`"; python -m uvicorn app.main:app --host 0.0.0.0 --port 8000"
$cmdPwa     = "& `"$venvAct`"; Set-Location `"$pwa`"; npm run dev -- --host 0.0.0.0 --port 5173"
$cmdTestes  = "& `"$venvAct`"; Set-Location `"$backend`";"
$cmdLivre   = "& `"$venvAct`"; Set-Location `"$root`";"

# IMPORTANTE: tudo em UMA string, com ';' separando os new-tab.
$wtCmd = @"
new-tab --title Backend powershell -NoExit -ExecutionPolicy Bypass -Command "$cmdBackend" ;
new-tab --title PWA     powershell -NoExit -ExecutionPolicy Bypass -Command "$cmdPwa" ;
new-tab --title Testes  powershell -NoExit -ExecutionPolicy Bypass -Command "$cmdTestes" ;
new-tab --title Livre   powershell -NoExit -ExecutionPolicy Bypass -Command "$cmdLivre"
"@

# Abre tudo no MESMO Windows Terminal (janela 0)
wt -w 0 $wtCmd
