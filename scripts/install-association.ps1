param(
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch {
  # Console encoding is cosmetic.
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$progId = "Typero.Markdown"
$extensions = @(".md", ".markdown", ".mdown", ".mkd")
$vbsPath = Join-Path $projectRoot "scripts\open-with-typero.vbs"
$iconPath = Join-Path $projectRoot "assets\typero.ico"
$runtimeDir = Join-Path $projectRoot ".typero"
$backupPath = Join-Path $runtimeDir "association-backup.json"
$nodePathFile = Join-Path $runtimeDir "node-path.txt"
$classesRoot = "HKCU:\Software\Classes"
$progKey = Join-Path $classesRoot $progId

function Get-DefaultValue([string]$keyPath) {
  $fullPath = "Software\Classes\" + ($keyPath -replace "^HKCU:\\Software\\Classes\\", "")
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($fullPath)
  if (-not $key) { return $null }
  try {
    return $key.GetValue("")
  } finally {
    $key.Close()
  }
}

function Set-DefaultValue([string]$keyPath, [string]$value) {
  New-Item -Path $keyPath -Force | Out-Null
  Set-Item -Path $keyPath -Value $value
}

function Clear-DefaultValue([string]$keyPath) {
  $fullPath = "Software\Classes\" + ($keyPath -replace "^HKCU:\\Software\\Classes\\", "")
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($fullPath, $true)
  if ($key) {
    try {
      $key.DeleteValue("", $false)
    } finally {
      $key.Close()
    }
  }
}

function Test-RegistryPath([string]$path) {
  return Test-Path -LiteralPath $path
}

function Notify-Shell {
  try {
    Add-Type -Namespace Typero -Name ShellNotify -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("shell32.dll")]
public static extern void SHChangeNotify(int eventId, int flags, System.IntPtr item1, System.IntPtr item2);
"@ -ErrorAction SilentlyContinue
    [Typero.ShellNotify]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
  } catch {
    # Explorer will eventually notice the registry change.
  }

  $ie4uinit = Join-Path $env:WINDIR "System32\ie4uinit.exe"
  if (Test-Path -LiteralPath $ie4uinit) {
    try {
      Start-Process -FilePath $ie4uinit -ArgumentList "-show" -WindowStyle Hidden | Out-Null
    } catch {
      # Icon refresh is optional.
    }
  }
}

if ($Uninstall) {
  Write-Host ""
  Write-Host "  移除 Typero 的 Markdown 文件关联" -ForegroundColor Cyan
  Write-Host ""

  $backup = $null
  if (Test-Path -LiteralPath $backupPath) {
    try {
      $backup = Get-Content -LiteralPath $backupPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
      $backup = $null
    }
  }

  foreach ($ext in $extensions) {
    $extKey = Join-Path $classesRoot $ext
    $current = Get-DefaultValue $extKey
    if ($current -eq $progId) {
      $previous = $null
      if ($backup -and $backup.extensions -and $backup.extensions.PSObject.Properties[$ext]) {
        $previous = $backup.extensions.PSObject.Properties[$ext].Value.default
      }
      if ($previous -and $previous -ne $progId) {
        Set-DefaultValue $extKey $previous
        Write-Host "  已恢复 $ext -> $previous"
      } else {
        Clear-DefaultValue $extKey
        Write-Host "  已移除 $ext 的 Typero 默认关联"
      }
    }

    $openWithKey = Join-Path $extKey "OpenWithProgids"
    if (Test-Path -LiteralPath $openWithKey) {
      Remove-ItemProperty -LiteralPath $openWithKey -Name $progId -ErrorAction SilentlyContinue
    }
  }

  if (Test-Path -LiteralPath $progKey) {
    Remove-Item -LiteralPath $progKey -Recurse -Force
  }

  if (Test-Path -LiteralPath $backupPath) {
    Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
  }

  Notify-Shell
  Write-Host ""
  Write-Host "  Typero 文件关联已移除。后台服务仍然保留，可用 stop-typero.cmd 停止。" -ForegroundColor Green
  Write-Host ""
  exit 0
}

Write-Host ""
Write-Host "  安装 Typero 的 Markdown 文件关联" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path -LiteralPath $vbsPath)) {
  throw "找不到启动脚本：$vbsPath"
}
if (-not (Test-Path -LiteralPath $iconPath)) {
  throw "找不到程序图标：$iconPath"
}

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  Write-Warning "未在 PATH 中找到 node.exe。双击标记文件时可能无法启动 Typero。"
}

$wscriptPath = Join-Path $env:WINDIR "System32\wscript.exe"
$command = '"' + $wscriptPath + '" //Nologo "' + $vbsPath + '" "%1"'

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
if ($nodeCommand) {
  [System.IO.File]::WriteAllText($nodePathFile, $nodeCommand.Source, [System.Text.Encoding]::Unicode)
}
if (-not (Test-Path -LiteralPath $backupPath)) {
  $snapshot = @{
    createdAt = (Get-Date).ToString("o")
    extensions = @{}
  }
  foreach ($ext in $extensions) {
    $extKey = Join-Path $classesRoot $ext
    $userChoice = $null
    $userChoiceKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$ext\UserChoice"
    if (Test-Path -LiteralPath $userChoiceKey) {
      $userChoice = (Get-ItemProperty -LiteralPath $userChoiceKey -ErrorAction SilentlyContinue).ProgId
    }
    $snapshot.extensions[$ext] = @{
      default = Get-DefaultValue $extKey
      userChoice = $userChoice
    }
  }
  $snapshot | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $backupPath -Encoding UTF8
}

New-Item -Path $progKey -Force | Out-Null
Set-Item -Path $progKey -Value "Typero Markdown Document"
New-Item -Path (Join-Path $progKey "DefaultIcon") -Force | Out-Null
Set-Item -Path (Join-Path $progKey "DefaultIcon") -Value ('"' + $iconPath + '",0')
New-Item -Path (Join-Path $progKey "shell\open\command") -Force | Out-Null
Set-Item -Path (Join-Path $progKey "shell\open\command") -Value $command
Set-Item -Path (Join-Path $progKey "shell") -Value "open"

$warnings = @()
foreach ($ext in $extensions) {
  $extKey = Join-Path $classesRoot $ext
  Set-DefaultValue $extKey $progId

  $openWithKey = Join-Path $extKey "OpenWithProgids"
  New-Item -Path $openWithKey -Force | Out-Null
  New-ItemProperty -LiteralPath $openWithKey -Name $progId -PropertyType None -Value ([byte[]]@()) -Force | Out-Null

  $userChoiceKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$ext\UserChoice"
  if (Test-Path -LiteralPath $userChoiceKey) {
    $chosen = (Get-ItemProperty -LiteralPath $userChoiceKey -ErrorAction SilentlyContinue).ProgId
    if ($chosen -and $chosen -ne $progId) {
      $warnings += "$ext 当前仍由 Windows 默认应用控制（$chosen）"
    }
  }
}

Notify-Shell

Write-Host "  已将以下扩展名关联到 Typero：" -ForegroundColor Green
Write-Host "    .md  .markdown  .mdown  .mkd" -ForegroundColor Gray
Write-Host ""
Write-Host "  现在双击 Markdown 文件即可用 Typero 打开。" -ForegroundColor Green
if ($warnings.Count -gt 0) {
  Write-Host ""
  Write-Host "  注意：" -ForegroundColor Yellow
  foreach ($warning in $warnings) {
    Write-Host "    $warning"
  }
  Write-Host "    请在“设置 -> 默认应用”中把相关扩展名设为 Typero，"
  Write-Host "    或右键文件 -> 打开方式 -> Typero。"
}
Write-Host ""
Write-Host "  卸载关联：uninstall-typero-association.cmd"
Write-Host "  停止后台服务：stop-typero.cmd"
Write-Host ""
exit 0
