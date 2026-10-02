$ErrorActionPreference = 'Stop'
$destination = Join-Path $PSScriptRoot 'vendor/mpv'
$archive = Join-Path $env:TEMP 'fjordflix-mpv-pinned.zip'
$url = 'https://github.com/qlerup/fjordflix/releases/download/desktop-v0.1.0/mpv-v0.41.0-dev-ga1f50f2c3-36640285359-x86_64-w64-mingw32-full.zip'
Invoke-WebRequest $url -OutFile $archive
if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLower() -ne 'ff60d2eab4e89956209e92285193c6513f49f0cdf376da005c45090ed9b8435e') { throw 'mpv checksum mismatch' }
New-Item -ItemType Directory -Force $destination | Out-Null
Expand-Archive $archive -DestinationPath $destination -Force
Copy-Item (Join-Path $PSScriptRoot 'THIRD-PARTY.txt') $destination
