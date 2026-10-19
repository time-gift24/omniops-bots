"""Exercise desktop startup without building or launching native processes."""
import runpy
import subprocess
import unittest
import urllib.error
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import MagicMock, patch


SCRIPT = Path(__file__).with_name('build-native-macos.py')
ROOT = SCRIPT.resolve().parents[2]


class DesktopDevTest(unittest.TestCase):
    def setUp(self):
        stack = ExitStack()
        self.addCleanup(stack.close)
        for name, value in [('system', 'Darwin'), ('machine', 'arm64')]:
            stack.enter_context(patch(f'platform.{name}', return_value=value))
        for name, value in [('mkdir', None), ('is_file', True), ('is_dir', True),
                            ('exists', False), ('rglob', [])]:
            stack.enter_context(patch.object(Path, name, return_value=value))
        stack.enter_context(patch.dict('os.environ', {'CARGO_TARGET_DIR': str(ROOT / 'target')}))
        stack.enter_context(patch('time.sleep'))
        stack.enter_context(patch('builtins.print'))
        self.socket = stack.enter_context(patch('socket.socket'))
        self.run = stack.enter_context(patch('subprocess.run'))
        self.vite = MagicMock()
        self.vite.poll.return_value = None
        self.popen = stack.enter_context(patch('subprocess.Popen', return_value=self.vite))
        self.urlopen = stack.enter_context(patch('urllib.request.urlopen'))

    def execute(self, *args):
        with patch('sys.argv', [str(SCRIPT), *args]):
            runpy.run_path(str(SCRIPT), run_name='__main__')

    def test_dev_builds_debug_bundle_and_runs_app(self):
        self.execute('--dev')
        commands = [call.args[0] for call in self.run.call_args_list]
        self.assertEqual(commands[0], (
            'node', str(ROOT / 'web/node_modules/@tauri-apps/cli/tauri.js'),
            'build', '--debug', '--config',
            str(ROOT / 'crates/omniops-bots-desktop/tauri.dev.conf.json'),
            '--bundles', 'app',
        ))
        app = ROOT / 'target/debug/bundle/macos/omniops-bots.app'
        self.assertEqual(commands[1], ('codesign', '--verify', '--deep', '--strict', str(app)))
        self.assertEqual(commands[2], (str(app / 'Contents/MacOS/omniops-bots-desktop'),))
        self.assertEqual(self.popen.call_args.args[0][-5:], [
            '--host', '127.0.0.1', '--port', '5173', '--strictPort',
        ])
        self.urlopen.assert_called_once_with('http://127.0.0.1:5173/@vite/client', timeout=1)
        self.vite.terminate.assert_called_once_with()
        self.vite.wait.assert_called_once_with(timeout=5)

    def test_regular_builds_do_not_start_vite_or_app(self):
        for args, debug, bundles in [((), False, 'app,dmg'),
                                     (('--debug',), True, 'app'),
                                     (('--no-dmg',), False, 'app')]:
            with self.subTest(args=args):
                self.run.reset_mock()
                self.execute(*args)
                self.assertEqual(self.run.call_count, 2)
                command = self.run.call_args_list[0].args[0]
                self.assertNotIn('--config', command)
                self.assertEqual('--debug' in command, debug)
                self.assertEqual(command[-2:], ('--bundles', bundles))
        self.popen.assert_not_called()

    def test_vite_startup_timeout_cleans_up(self):
        self.urlopen.side_effect = urllib.error.URLError('not ready')
        with self.assertRaisesRegex(SystemExit, 'did not become ready'):
            self.execute('--dev')
        self.run.assert_not_called()
        self.vite.terminate.assert_called_once_with()
        self.vite.wait.assert_called_once_with(timeout=5)

    def test_busy_port_does_not_start_or_stop_processes(self):
        self.socket.return_value.__enter__.return_value.bind.side_effect = OSError('in use')
        with self.assertRaisesRegex(SystemExit, 'Port 5173 is in use'):
            self.execute('--dev')
        self.popen.assert_not_called()
        self.run.assert_not_called()
        self.vite.terminate.assert_not_called()

    def test_build_failure_kills_vite_when_termination_times_out(self):
        self.run.side_effect = subprocess.CalledProcessError(1, 'tauri build')
        self.vite.wait.side_effect = [subprocess.TimeoutExpired('vite', 5), None]
        with self.assertRaises(subprocess.CalledProcessError):
            self.execute('--dev')
        self.vite.terminate.assert_called_once_with()
        self.vite.kill.assert_called_once_with()
        self.assertEqual(self.vite.wait.call_count, 2)


if __name__ == '__main__':
    unittest.main()
