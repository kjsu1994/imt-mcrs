$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$usingWslDocker = $false

if (Get-Command docker -ErrorAction SilentlyContinue) {
    docker compose up -d --build
    if ($LASTEXITCODE -ne 0) { throw 'Docker Compose failed.' }
} else {
    $usingWslDocker = $true
    # Docker's systemd service alone does not keep an idle WSL distro alive.
    $keepAliveTask = Get-ScheduledTask -TaskName 'MCSR-Sim-WSL' -ErrorAction SilentlyContinue
    if ($keepAliveTask -and $keepAliveTask.State -ne 'Running') {
        Start-ScheduledTask -TaskName 'MCSR-Sim-WSL'
    }
    # WSL cannot read this machine's O: cloud drive; stage only build inputs on C:.
    wsl -d Ubuntu --cd / --exec docker info --format '{{.ServerVersion}}'
    if ($LASTEXITCODE -ne 0) { throw 'Start Docker in WSL Ubuntu first.' }
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    $buildDir = Join-Path $tempRoot ('mcsr-sim-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $buildDir | Out-Null
    try {
        foreach ($name in @('Dockerfile', 'docker-compose.yml', '.dockerignore', 'package.json', 'package-lock.json', 'index.html', 'tsconfig.json', 'vite.config.ts', 'src', 'scripts', 'examples')) {
            Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $buildDir -Recurse
        }
        New-Item -ItemType Directory -Path (Join-Path $buildDir 'public') | Out-Null
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'public\textures') -Destination (Join-Path $buildDir 'public') -Recurse
        $linuxDir = wsl -d Ubuntu --cd / --exec wslpath -a ($buildDir -replace '\\', '/')
        if (!$linuxDir) { throw 'Unable to translate temporary build path for WSL.' }
        $linuxDir = $linuxDir.Trim()
        if ($LASTEXITCODE -ne 0 -or !$linuxDir.StartsWith('/mnt/')) { throw 'Unable to translate temporary build path for WSL.' }
        wsl -d Ubuntu --cd / --exec docker compose --project-directory $linuxDir -f "$linuxDir/docker-compose.yml" config --quiet
        if ($LASTEXITCODE -ne 0) { throw 'Invalid Compose configuration.' }
        wsl -d Ubuntu --cd / --exec docker compose --project-directory $linuxDir -f "$linuxDir/docker-compose.yml" up -d --build
        if ($LASTEXITCODE -ne 0) { throw 'Docker Compose failed.' }
    } finally {
        $resolved = [IO.Path]::GetFullPath($buildDir)
        if ($resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved) -match '^mcsr-sim-[0-9a-f]{32}$') {
            Remove-Item -LiteralPath $resolved -Recurse -Force
        }
    }
}
& (Join-Path $PSScriptRoot 'docker-lan.ps1') -Wsl:$usingWslDocker
Write-Host 'MCSR simulator: http://localhost:5174'
Write-Host 'LAN access: http://<Windows LAN IPv4>:5174 (5714 also available)'
