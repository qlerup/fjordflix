# Run once from a PowerShell window opened as administrator, only if the phone cannot connect.
param(
    [Parameter(Mandatory = $true)]
    [System.Net.IPAddress]$LocalAddress
)

$ErrorActionPreference = 'Stop'
$fjordRule = Get-NetFirewallRule -DisplayName 'FjordFlix lokal telefon-test' -ErrorAction SilentlyContinue
if (-not $fjordRule) {
    New-NetFirewallRule -DisplayName 'FjordFlix lokal telefon-test' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8096 -LocalAddress $LocalAddress.IPAddressToString -RemoteAddress LocalSubnet -Profile Private | Out-Null
}
Write-Host 'FjordFlix er tilladt fra det lokale subnet paa dit private netvaerk, TCP 8096.'
