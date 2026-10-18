#!/usr/bin/env python3
"""Tauri beforeBundle hook: stage signed CEF framework and sandbox helpers."""
import json
import os
import plistlib
import shutil
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[2]
crate = root / 'crates/cognacta-desktop'
debug = os.environ.get('TAURI_ENV_DEBUG') == 'true'
profile = 'debug' if debug else 'release'
target = Path(os.environ.get('CARGO_TARGET_DIR', root / 'target')).resolve()
cef_path = Path(os.environ.get('CEF_PATH', Path.home() / 'Library/Caches/tauri-cef'))
env = {**os.environ, 'CEF_PATH': str(cef_path), 'CARGO_TARGET_DIR': str(target)}

def run(*args):
    subprocess.run(args, cwd=root, env=env, check=True)

run('cargo', 'build', '-p', 'cognacta-desktop-helper', *([] if debug else ['--release']))
config = json.loads((crate / 'tauri.conf.json').read_text())
cef = cef_path if (cef_path / 'Chromium Embedded Framework.framework').is_dir() else cef_path / '154.0.34/cef_macos_aarch64'
framework = cef / 'Chromium Embedded Framework.framework'
assert framework.is_dir(), f'Pinned CEF SDK is missing: {framework}'
binary = config['mainBinaryName']
dest = crate / 'resources/Frameworks'
dest.mkdir(exist_ok=True)
run('ditto', str(framework), str(dest / framework.name))
shutil.copy2(cef / 'CREDITS.html', crate / 'resources/CEF-CREDITS.html')
shutil.copy2(root / 'crates/cognacta-desktop-helper/CEF-LICENSE.txt', crate / 'resources/CEF-LICENSE.txt')
entitlements = target / 'cef-entitlements.plist'
with entitlements.open('wb') as file:
    plistlib.dump({f'com.apple.security.cs.{key}': True for key in (
        'allow-jit', 'allow-unsigned-executable-memory', 'disable-library-validation'
    )}, file)

def sign(path, jit=False):
    extra = ['--entitlements', str(entitlements)] if jit else []
    run('codesign', '--force', '--sign', '-', '--options', 'runtime', *extra, str(path))

for suffix in ('', ' (Alerts)', ' (GPU)', ' (Plugin)', ' (Renderer)'):
    name = binary + ' Helper' + suffix
    helper = dest / (name + '.app')
    contents = helper / 'Contents'
    (contents / 'MacOS').mkdir(parents=True, exist_ok=True)
    shutil.copy2(target / profile / 'cognacta-desktop-helper', contents / 'MacOS' / name)
    with (contents / 'Info.plist').open('wb') as file:
        plistlib.dump({
            'CFBundleExecutable': name, 'CFBundleName': name,
            'CFBundleIdentifier': config['identifier'] + '.helper' + suffix.lower().replace(' (', '.').replace(')', ''),
            'CFBundlePackageType': 'APPL', 'CFBundleVersion': config['version'],
            'CFBundleShortVersionString': config['version'], 'LSUIElement': True,
            'LSMinimumSystemVersion': config['bundle']['macOS']['minimumSystemVersion'],
        }, file)
    sign(helper, jit=True)
for library in (dest / framework.name / 'Libraries').glob('*.dylib'):
    sign(library)
sign(dest / framework.name)
