param(
    [Parameter(Mandatory=$true)][string]$CertificateProfile,
    [string]$TvIp,
    [string]$SdkRoot = 'C:\tizen-studio'
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$tizen = Join-Path $SdkRoot 'tools/ide/bin/tizen.bat'
$sdb = Join-Path $SdkRoot 'tools/sdb.exe'
if (!(Test-Path -LiteralPath $tizen)) { throw 'Installér Tizen Studio Web CLI, eller angiv -SdkRoot.' }
if ($TvIp) {
    $parsedIp = $null
    if (![System.Net.IPAddress]::TryParse($TvIp, [ref]$parsedIp) -or $parsedIp.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { throw 'TvIp skal være TVets IPv4-adresse.' }
    if (!(Test-Path -LiteralPath $sdb)) { throw 'SDB blev ikke fundet i Tizen Studio.' }
}
Push-Location $projectRoot
try {
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Build mislykkedes.' }
    $app = Join-Path $projectRoot 'dist/app'
    & $tizen package -t wgt -s $CertificateProfile -- $app
    if ($LASTEXITCODE -ne 0) { throw 'Samsung-signering mislykkedes. Kontrollér certifikatprofil og TVets DUID.' }
    $packages = @(Get-ChildItem -LiteralPath $app -Filter '*.wgt' -File)
    if ($packages.Count -ne 1) { throw 'Forventede præcis én signeret WGT fra Tizen CLI.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($packages[0].FullName)
    try {
        if (!$zip.GetEntry('author-signature.xml') -or !$zip.GetEntry('signature1.xml')) { throw 'Pakken mangler Samsung/Tizen-signaturer.' }
    } finally { $zip.Dispose() }
    $version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
    $name = "FjordFlix-Samsung_$version.wgt"
    $dist = Join-Path $projectRoot 'dist'
    Copy-Item -LiteralPath $packages[0].FullName -Destination (Join-Path $dist $name) -Force
    Write-Output "Signeret pakke: $(Join-Path $dist $name)"
    if ($TvIp) {
        & $sdb connect $TvIp
        if ($LASTEXITCODE -ne 0) { throw 'Kunne ikke forbinde til TVet. Kontrollér Developer Mode og PCens IP.' }
        $devices = & $sdb devices
        $serial = @($devices | ForEach-Object { ($_ -split '\s+')[0] } | Where-Object { $_ -eq $TvIp -or $_.StartsWith($TvIp + ':') }) | Select-Object -First 1
        if (!$serial) { throw 'TVet mangler i sdb devices.' }
        & $tizen install -s $serial --name $name -- $dist
        if ($LASTEXITCODE -ne 0) { throw 'Installation fejlede. Kontrollér DUID og Permit to install applications i Device Manager.' }
        & $tizen run -s $serial -p 'FjordFlix1.FjordFlix'
        if ($LASTEXITCODE -ne 0) { throw 'Appen blev installeret, men kunne ikke startes automatisk.' }
    }
} finally { Pop-Location }
