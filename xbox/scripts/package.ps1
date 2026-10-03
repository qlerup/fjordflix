param([string]$SdkToolsPath)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$sdkVersion = '10.0.26100.9169'
if (!$SdkToolsPath) {
    $sdkRoot = Join-Path $projectRoot '.tools/sdk'
    $packager = Get-ChildItem -LiteralPath $sdkRoot -Filter makeappx.exe -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.Directory.Name -eq 'x64' } | Select-Object -First 1
    if (!$packager) {
        New-Item -ItemType Directory -Path (Join-Path $projectRoot '.tools') -Force | Out-Null
        $archive = Join-Path $projectRoot '.tools/sdk.zip'
        Invoke-WebRequest -UseBasicParsing -Uri "https://api.nuget.org/v3-flatcontainer/microsoft.windows.sdk.buildtools/$sdkVersion/microsoft.windows.sdk.buildtools.$sdkVersion.nupkg" -OutFile $archive
        Expand-Archive -LiteralPath $archive -DestinationPath $sdkRoot -Force
        $packager = Get-ChildItem -LiteralPath $sdkRoot -Filter makeappx.exe -Recurse |
            Where-Object { $_.Directory.Name -eq 'x64' } | Select-Object -First 1
    }
    if (!$packager) { throw 'Microsoft MakeAppx kunne ikke findes.' }
    $SdkToolsPath = $packager.Directory.FullName
}
$makeAppx = Join-Path $SdkToolsPath 'makeappx.exe'
$signTool = Join-Path $SdkToolsPath 'signtool.exe'
$output = Join-Path $projectRoot 'dist/FjordFlix-Xbox_0.1.10.appx'
& $makeAppx pack /d (Join-Path $projectRoot 'dist/app') /p $output /o
if ($LASTEXITCODE -ne 0) { throw 'APPX-validering eller pakning mislykkedes.' }
$signingDir = Join-Path $projectRoot '.signing'
New-Item -ItemType Directory -Path $signingDir -Force | Out-Null
$thumbprintPath = Join-Path $signingDir 'thumbprint.txt'
$certificate = $null
if (Test-Path -LiteralPath $thumbprintPath) {
    $thumbprint = (Get-Content -LiteralPath $thumbprintPath -Raw).Trim()
    $certificate = Get-Item -LiteralPath "Cert:/CurrentUser/My/$thumbprint" -ErrorAction SilentlyContinue
}
if (!$certificate -or $certificate.NotAfter -le (Get-Date).AddDays(7)) {
    $certificate = New-SelfSignedCertificate -Type Custom -Subject 'CN=FjordFlix Development' -FriendlyName 'FjordFlix Xbox development signing' -KeyUsage DigitalSignature -CertStoreLocation 'Cert:/CurrentUser/My' -NotAfter (Get-Date).AddYears(2) -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
    $certificate.Thumbprint | Set-Content -LiteralPath $thumbprintPath
}
& $signTool sign /fd SHA256 /sha1 $certificate.Thumbprint /s My $output
if ($LASTEXITCODE -ne 0) { throw 'Signering mislykkedes.' }
Export-Certificate -Cert $certificate -FilePath (Join-Path $projectRoot 'dist/FjordFlix-Xbox.cer') | Out-Null
$signature = Get-AuthenticodeSignature -LiteralPath $output
if (!$signature.SignerCertificate -or $signature.SignerCertificate.Thumbprint -ne $certificate.Thumbprint -or $signature.Status -eq 'HashMismatch') {
    throw 'Den signerede pakke kunne ikke verificeres.'
}
Get-FileHash -LiteralPath $output -Algorithm SHA256 | ForEach-Object {
    "$($_.Hash)  FjordFlix-Xbox_0.1.10.appx" | Set-Content -LiteralPath (Join-Path $projectRoot 'dist/SHA256SUMS.txt')
}
Write-Output 'APPX valideret og signeret. Certifikatet er selvsigneret til Developer Mode, ikke Microsoft Store.'
