# Lensa Belajar Watchdog
# Jalankan SEKALI sebelum belajar. Biarkan jendela ini terbuka.

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$npm = (Get-Command npm -ErrorAction SilentlyContinue).Source
if (-not $npm) { Write-Host "npm tidak ditemukan."; pause; exit 1 }

$quitFile  = "$env:APPDATA\Lensa Belajar\lensa.quit"
$pidFile   = "$env:APPDATA\Lensa Belajar\lensa.pid"
$starting  = $false
$startedAt = [DateTime]::MinValue

function IsLensaRunning {
    if (Test-Path $pidFile) {
        $lensaPid = [int](Get-Content $pidFile -ErrorAction SilentlyContinue)
        if ($lensaPid -gt 0 -and (Get-Process -Id $lensaPid -ErrorAction SilentlyContinue)) {
            return $true
        }
    }
    return [bool](Get-Process -Name "electron" -ErrorAction SilentlyContinue)
}

function StartLensa {
    Write-Host "$(Get-Date -Format 'HH:mm:ss') Membuka Lensa..."
    $script:starting  = $true
    $script:startedAt = Get-Date
    Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Start-Process $npm -ArgumentList "start" -WorkingDirectory $dir -WindowStyle Hidden
}

if (Test-Path $quitFile) { Remove-Item $quitFile -Force }

Write-Host "Lensa Watchdog aktif. Biarkan jendela ini terbuka selama belajar."
Write-Host "Tutup jendela ini atau tekan Ctrl+C untuk berhenti."

if (-not (IsLensaRunning)) { StartLensa }

while ($true) {
    Start-Sleep 3

    if (Test-Path $quitFile) {
        Write-Host "$(Get-Date -Format 'HH:mm:ss') Lensa ditutup normal. Watchdog berhenti."
        Remove-Item $quitFile -Force -ErrorAction SilentlyContinue
        break
    }

    if ($starting -and ((Get-Date) - $startedAt).TotalSeconds -lt 15) { continue }
    $script:starting = $false

    if (-not (IsLensaRunning)) { StartLensa }
}
