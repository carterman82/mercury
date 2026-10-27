$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$assets = Join-Path $taskRoot '.build-resources'
$cache = Join-Path $assets 'mxc-source'
$target = Join-Path $assets 'mxc-runtime'
$version = '1.0.1'
$expected = '0e832239454ba7fcd338ff56218a287eef4c0a01c1484084b869f55feff8abe9'
New-Item -ItemType Directory -Force -Path $cache, $target | Out-Null
$archive = Join-Path $cache 'mxc-release-binaries.zip'
if (!(Test-Path -LiteralPath $archive)) {
  Invoke-WebRequest "https://github.com/microsoft/mxc/releases/download/v$version/mxc-release-binaries.zip" -OutFile $archive
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'MXC archive integrity check failed.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
$files = [ordered]@{}
try {
  foreach ($entry in $zip.Entries) {
    if ($entry.FullName -notmatch '^x64/[^/]+\.(exe|dll)$') { continue }
    $name = [IO.Path]::GetFileName($entry.FullName)
    $destination = Join-Path $target $name
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $true)
    $files[$name] = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
  }
} finally { $zip.Dispose() }
if (!$files.Contains('wxc-exec.exe') -or !$files.Contains('mxc_ffi.dll')) { throw 'Required MXC assets are missing.' }
$manifest = [ordered]@{ version=$version; contractVersion='1.0.0'; archiveSha256=$expected; files=$files } | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText((Join-Path $target 'runtime.json'), $manifest)
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'MXC-LICENSE.md') -Destination (Join-Path $target 'LICENSE.md') -Force
Write-Output "Verified MXC ${version}: $($files.Count) native runtime assets."
