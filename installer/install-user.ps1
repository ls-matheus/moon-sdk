param(
    [Parameter(Mandatory = $true)][string]$Destination,
    [ValidatePattern('^(main|[a-fA-F0-9]{40})$')][string]$Commit = 'main',
    [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Destination = [IO.Path]::GetFullPath($Destination).TrimEnd('\')
$bin = Join-Path $Destination 'bin'

function Update-UserPath([bool]$Remove) {
    $current = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = @($current -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -ine $bin })
    if (-not $Remove) { $entries = @($bin) + $entries }
    [Environment]::SetEnvironmentVariable('Path', ($entries -join ';'), 'User')
}
if ($Uninstall) { Update-UserPath $true; exit 0 }

New-Item -ItemType Directory -Path $Destination -Force | Out-Null
Start-Transcript -Path (Join-Path $Destination 'install.log') -Append | Out-Null
$work = Join-Path ([IO.Path]::GetTempPath()) ('moon-install-' + [guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $work | Out-Null
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $nodeVersion = '22.23.2'
    $nodeFile = "node-v$nodeVersion-win-x64.zip"
    $nodeZip = Join-Path $work $nodeFile
    Write-Output 'Baixando Node.js portatil...'
    Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/v$nodeVersion/$nodeFile" -OutFile $nodeZip -TimeoutSec 600
    $checksums = (Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/v$nodeVersion/SHASUMS256.txt" -TimeoutSec 60).Content
    $pattern = '(?m)^([a-fA-F0-9]{64})\s+' + [regex]::Escape($nodeFile) + '\s*$'
    $match = [regex]::Match($checksums, $pattern)
    function Compute-FileHash([string]$path) {
        if (Get-Command Get-FileHash -ErrorAction SilentlyContinue) {
            return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        try {
            $out = & certutil -hashfile $path SHA256 2>$null
            if ($out) {
                $lines = $out -split "`r?`n"
                if ($lines.Length -ge 2) { return ($lines[1] -replace '\s+','').ToLowerInvariant() }
            }
        } catch {}
        # Fallback to .NET implementation
        $stream = [IO.File]::OpenRead($path)
        try {
            $sha = [System.Security.Cryptography.SHA256]::Create()
            $hashBytes = $sha.ComputeHash($stream)
            return ([BitConverter]::ToString($hashBytes)).Replace('-','').ToLowerInvariant()
        } finally { $stream.Close() }
    }
    $downloadHash = Compute-FileHash $nodeZip
    if (-not $match.Success -or $downloadHash -ne $match.Groups[1].Value.ToLowerInvariant()) {
        throw 'Checksum do Node.js invalido.'
    }
    $releases = Join-Path $Destination 'releases'
    New-Item -ItemType Directory -Path $releases -Force | Out-Null
    $release = Join-Path $releases ([guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $release | Out-Null
    Expand-Archive -LiteralPath $nodeZip -DestinationPath $release
    $nodeDir = Join-Path $release "node-v$nodeVersion-win-x64"
    $sdkZip = Join-Path $work 'sdk.zip'
    Write-Output 'Baixando Moon SDK...'
    Invoke-WebRequest -UseBasicParsing "https://github.com/ls-matheus/moon-sdk/archive/$Commit.zip" -OutFile $sdkZip -TimeoutSec 600
    $source = Join-Path $work 'source'
    Expand-Archive -LiteralPath $sdkZip -DestinationPath $source
    $folders = @(Get-ChildItem -LiteralPath $source -Directory)
    if ($folders.Count -ne 1) { throw 'Arquivo do SDK invalido.' }
    $sdk = Join-Path $release 'sdk'
    if (-not $folders[0].FullName.StartsWith(([IO.Path]::GetFullPath($work).TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase) -or
        -not ([IO.Path]::GetFullPath($sdk)).StartsWith(($Destination + '\releases\'), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Caminho de extracao fora da pasta de instalacao.'
    }
    Move-Item -LiteralPath $folders[0].FullName -Destination $sdk
    $env:PATH = "$nodeDir;$env:PATH"
    $env:npm_config_cache = Join-Path $work 'npm-cache'
    $env:npm_config_fetch_retries = '0'
    $env:npm_config_fetch_timeout = '30000'
    if (-not $env:npm_config_https_proxy) {
        $uri = [uri]'https://registry.npmjs.org'
        $proxy = [Net.WebRequest]::DefaultWebProxy.GetProxy($uri)
        if ($proxy -and $proxy -ne $uri) { $env:npm_config_https_proxy = $proxy.AbsoluteUri }
    }
    & (Join-Path $nodeDir 'npm.cmd') ci --prefix $sdk --omit=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar dependencias do Moon.' }
    $entry = Join-Path $sdk 'bin\moon.mjs'
    & (Join-Path $nodeDir 'node.exe') $entry --help
    if ($LASTEXITCODE -ne 0) { throw 'Falha na verificacao do Moon.' }
    # Only activate the new release after installation and validation succeed.
    New-Item -ItemType Directory -Path $bin -Force | Out-Null
    $psNode = $nodeDir.Replace("'", "''")
    $psEntry = $entry.Replace("'", "''")
    $launcher = "`$env:PATH = '$psNode;' + `$env:PATH`r`n& '$psNode\node.exe' '$psEntry' @args`r`nexit `$LASTEXITCODE`r`n"
    Set-Content -LiteralPath (Join-Path $bin 'moon.ps1') -Value $launcher -Encoding UTF8
    $cmd = '@echo off' + "`r`n" + '"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0moon.ps1" %*' + "`r`n" + 'exit /b %errorlevel%'
    Set-Content -LiteralPath (Join-Path $bin 'moon.cmd') -Value $cmd -Encoding ASCII
    Update-UserPath $false
    Write-Output 'Moon instalado para seu usuario. Abra um novo terminal e execute moon --help.'
} catch {
    Write-Output ('Falha: ' + $_.Exception.Message)
    exit 1
} finally {
    # The only recursive cleanup is the unique temporary directory created above.
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    $resolvedWork = [IO.Path]::GetFullPath($work)
    if ($resolvedWork.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolvedWork -Leaf) -match '^moon-install-[a-f0-9]{32}$') {
        Remove-Item -LiteralPath $resolvedWork -Recurse -Force -ErrorAction SilentlyContinue
    }
    Stop-Transcript | Out-Null
}
