param([switch]$RunNow)

$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'sync_perseo_cashboxes.py'
$pythonPath = (Get-Command python -ErrorAction Stop).Source
$taskName = 'CIERRES CAJA - Perseo cajas consulta'
$account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
    throw "No se encontró el sincronizador: $scriptPath"
}

$action = New-ScheduledTaskAction -Execute $pythonPath -Argument ('"{0}"' -f $scriptPath) -WorkingDirectory (Split-Path -Parent $scriptPath)
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Consulta Perseo con etiquetas_ro y sincroniza cuatro cajas con Cierres Caja. Requiere sesión Windows abierta y PegasusDB encendido.' -Force | Out-Null
Write-Output "Tarea programada instalada: $taskName (cada 15 minutos, con sesión Windows abierta)."
if ($RunNow) {
    Start-ScheduledTask -TaskName $taskName
    Write-Output 'Primera ejecución solicitada.'
}
