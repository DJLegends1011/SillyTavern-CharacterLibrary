param(
    [string]$OutputApk = "",
    [string]$AndroidSdk = "$env:LOCALAPPDATA\Android\Sdk"
)

$ErrorActionPreference = 'Stop'
if (-not $OutputApk) { $OutputApk = Join-Path $PSScriptRoot 'CharacterLibraryBridge-debug.apk' }
$BuildTools = Join-Path $AndroidSdk 'build-tools\34.0.0'
$AndroidJar = Join-Path $AndroidSdk 'platforms\android-34\android.jar'
$Aapt2 = Join-Path $BuildTools 'aapt2.exe'
$Aapt = Join-Path $BuildTools 'aapt.exe'
$D8 = Join-Path $BuildTools 'd8.bat'
$ZipAlign = Join-Path $BuildTools 'zipalign.exe'
$ApkSigner = Join-Path $BuildTools 'apksigner.bat'

foreach ($required in @($AndroidJar, $Aapt2, $Aapt, $D8, $ZipAlign, $ApkSigner)) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "Missing Android build dependency: $required"
    }
}

$BuildRoot = Join-Path $env:TEMP ("cl-android-bridge-" + [guid]::NewGuid().ToString('N'))
$Classes = Join-Path $BuildRoot 'classes'
$Dex = Join-Path $BuildRoot 'dex'
$Unsigned = Join-Path $BuildRoot 'unsigned.apk'
$Aligned = Join-Path $BuildRoot 'aligned.apk'
$Keystore = Join-Path $BuildRoot 'debug.keystore'
New-Item -ItemType Directory -Force -Path $Classes, $Dex | Out-Null

& $Aapt2 link -o $Unsigned -I $AndroidJar --manifest (Join-Path $PSScriptRoot 'AndroidManifest.xml') --min-sdk-version 26 --target-sdk-version 34
if ($LASTEXITCODE -ne 0) { throw 'aapt2 link failed' }

$Sources = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'src') -Recurse -Filter '*.java' | ForEach-Object FullName
& javac -encoding UTF-8 -source 8 -target 8 -classpath $AndroidJar -d $Classes $Sources
if ($LASTEXITCODE -ne 0) { throw 'javac failed' }

$ClassFiles = Get-ChildItem -LiteralPath $Classes -Recurse -Filter '*.class' | ForEach-Object FullName
& $D8 --release --min-api 26 --lib $AndroidJar --output $Dex $ClassFiles
if ($LASTEXITCODE -ne 0) { throw 'd8 failed' }

Push-Location $Dex
try {
    & $Aapt add $Unsigned 'classes.dex'
    if ($LASTEXITCODE -ne 0) { throw 'aapt add failed' }
} finally {
    Pop-Location
}

& $ZipAlign -f 4 $Unsigned $Aligned
if ($LASTEXITCODE -ne 0) { throw 'zipalign failed' }

& keytool -genkeypair -keystore $Keystore -storepass android -keypass android -alias androiddebugkey -dname 'CN=CL Browser Bridge Debug,O=SillyTavern,C=US' -keyalg RSA -keysize 2048 -validity 10000
if ($LASTEXITCODE -ne 0) { throw 'keytool failed' }

& $ApkSigner sign --ks $Keystore --ks-pass pass:android --key-pass pass:android --out $OutputApk $Aligned
if ($LASTEXITCODE -ne 0) { throw 'apksigner failed' }
& $ApkSigner verify --verbose $OutputApk
if ($LASTEXITCODE -ne 0) { throw 'APK verification failed' }

Write-Output "Built $OutputApk"
