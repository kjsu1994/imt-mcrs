param([switch]$Wsl)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (!$isAdmin) {
    # Windows port forwarding and firewall configuration require administrator rights.
    $script = '& {' + (Get-Content -LiteralPath $PSCommandPath -Raw) + '} -Wsl:$' + $Wsl.IsPresent.ToString()
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
    $process = Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded)
    if ($process.ExitCode -ne 0) { throw 'LAN setup failed. Retry docker-up.ps1 from an administrator PowerShell.' }
    return
}
if ($Wsl) {
    $addresses = wsl -d Ubuntu --cd / --exec hostname -I
    if ($LASTEXITCODE -ne 0 -or !$addresses) { throw 'Unable to read the WSL Ubuntu address.' }
    $wslAddress = ($addresses.Trim() -split '\s+')[0]
    $parsed = $null
    if (![Net.IPAddress]::TryParse($wslAddress, [ref]$parsed) -or $parsed.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { throw 'Invalid WSL IPv4 address.' }
}
foreach ($lanPort in @(5174, 5714)) {
    if ($Wsl) {
        netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$lanPort connectaddress=$wslAddress connectport=$lanPort protocol=tcp
        if ($LASTEXITCODE -ne 0) { throw "Unable to configure Windows to WSL forwarding on port $lanPort." }
    }
    $ruleName = "MCSR-Sim-LAN-$lanPort"
    if (Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue) {
        Set-NetFirewallRule -Name $ruleName -Enabled True -Direction Inbound -Action Allow -Profile Any -Protocol TCP -LocalPort $lanPort -RemoteAddress LocalSubnet | Out-Null
    } else {
        New-NetFirewallRule -Name $ruleName -DisplayName "MCSR simulator LAN TCP $lanPort" -Enabled True -Direction Inbound -Action Allow -Profile Any -Protocol TCP -LocalPort $lanPort -RemoteAddress LocalSubnet | Out-Null
    }
}
