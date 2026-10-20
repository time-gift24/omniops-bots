#!/usr/bin/env python3
"""Build the desktop with manual CEF and Agent Chrome; --dev runs it with Vite hot updates."""
import json
import os
import platform
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

root = Path(__file__).resolve().parents[2]
crate = root / 'crates/omniops-bots-desktop'
dev = '--dev' in sys.argv
debug = dev or '--debug' in sys.argv
if any(arg not in ('--dev', '--debug', '--no-dmg') for arg in sys.argv[1:]):
    raise SystemExit('Usage: build-native-macos.py [--dev] [--debug] [--no-dmg]')
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
vite = None
try:
    if dev:
        # CEF needs the signed app bundle; frontend edits only need Vite after startup.
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(('127.0.0.1', 5173))
            except OSError:
                raise SystemExit('Port 5173 is in use; stop the existing Vite server first.')
        vite = subprocess.Popen([
            'node', str(root / 'web/node_modules/vite/bin/vite.js'),
            '--host', '127.0.0.1', '--port', '5173', '--strictPort',
        ], cwd=root / 'web', env=env)
        for _ in range(100):
            time.sleep(0.1)
            if vite.poll() is not None:
                raise SystemExit('Vite could not start; free port 5173 and try again.')
            try:
                with urllib.request.urlopen('http://127.0.0.1:5173/@vite/client', timeout=1):
                    break
            except (urllib.error.URLError, TimeoutError):
                pass
        else:
            raise SystemExit('Vite did not become ready on port 5173.')
    run('node', str(cli), 'build', *(['--debug'] if debug else []),
        *(['--config', str(crate / 'tauri.dev.conf.json')] if dev else []),
        '--bundles', bundles, cwd=crate)
    config = json.loads((crate / 'tauri.conf.json').read_text())
    app = target / profile / 'bundle/macos' / (config['productName'] + '.app')
    run('codesign', '--verify', '--deep', '--strict', str(app))
    assert (app / 'Contents/Frameworks/Chromium Embedded Framework.framework').is_dir()
    assert not (app / 'Contents/Resources/browsers').exists()
    assert not list((app / 'Contents/Resources/runtime').rglob('model.env'))
    print(f'Native app: {app}', flush=True)
    if dev:
        run(str(app / 'Contents/MacOS' / config['mainBinaryName']))
finally:
    if vite is not None and vite.poll() is None:
        vite.terminate()
        try:
            vite.wait(timeout=5)
        except subprocess.TimeoutExpired:
            vite.kill()
            vite.wait()
