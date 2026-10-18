#!/usr/bin/env python3
"""Build a complete native CEF app; --debug is the local development entry."""
import json
import os
import platform
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[2]
crate = root / 'crates/cognacta-desktop'
debug = '--debug' in sys.argv
if any(arg not in ('--debug', '--no-dmg') for arg in sys.argv[1:]):
    raise SystemExit('Usage: build-native-macos.py [--debug] [--no-dmg]')
if platform.system() != 'Darwin' or platform.machine() != 'arm64':
    raise SystemExit('This build requires macOS arm64.')
target = Path(os.environ.get('CARGO_TARGET_DIR', root / 'target')).resolve()
target.mkdir(parents=True, exist_ok=True)
cef_path = Path(os.environ.get('CEF_PATH', Path.home() / 'Library/Caches/tauri-cef'))
env = {**os.environ, 'CEF_PATH': str(cef_path), 'CARGO_TARGET_DIR': str(target),
       'TAURI_FRONTEND_PATH': str(root / 'web')}
profile = 'debug' if debug else 'release'

def run(*args, cwd=root):
    subprocess.run(args, cwd=cwd, env=env, check=True)

cli = root / 'web/node_modules/@tauri-apps/cli/tauri.js'
if not cli.is_file():
    raise SystemExit('Install web dependencies before building the desktop app.')
bundles = 'app' if debug or '--no-dmg' in sys.argv else 'app,dmg'
run('node', str(cli), 'build', *(['--debug'] if debug else []), '--bundles', bundles, cwd=crate)
config = json.loads((crate / 'tauri.conf.json').read_text())
app = target / profile / 'bundle/macos' / (config['productName'] + '.app')
run('codesign', '--verify', '--deep', '--strict', str(app))
assert (app / 'Contents/Frameworks/Chromium Embedded Framework.framework').is_dir()
assert not (app / 'Contents/Resources/browsers').exists()
assert not list((app / 'Contents/Resources/runtime').rglob('model.env'))
print(f'Native app: {app}')
