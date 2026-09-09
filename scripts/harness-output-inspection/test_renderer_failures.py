"""Real restricted-process failure controls using owned synthetic inputs."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

from reportlab.pdfgen import canvas


ROOT = None
ROOT_OWNED = False
INSPECTOR = None


def setUpModule():
    global ROOT, ROOT_OWNED, INSPECTOR
    configured = os.environ.get('ATLAS_FAILURE_TEST_ROOT')
    if not configured or not Path(configured).is_absolute():
        raise ValueError('ATLAS_FAILURE_TEST_ROOT must be a fresh absolute directory')
    ROOT = Path(configured)
    ROOT.mkdir()
    ROOT_OWNED = True
    source = Path(__file__).with_name('inspect_output.py')
    spec = importlib.util.spec_from_file_location('failure_inspector', source)
    INSPECTOR = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(INSPECTOR)
    INSPECTOR.write_json(ROOT / 'registration.json', {
        'inspector': INSPECTOR.reference(source),
        'tests': INSPECTOR.reference(Path(__file__)),
        'scope': 'Synthetic timeout, partial page retention, unregistered command and denied loopback bind; no remote traffic or semantic qualification.',
        'partialControl': 'Request the first page only from the real rasterizer while preserving the renderer policy; independent page count still requires both pages.',
    })


class FailureTests(unittest.TestCase):
    def setUp(self):
        self.case = ROOT / self._testMethodName
        self.case.mkdir()
        self.capture = self.case / 'capture'
        self.capture.mkdir()
        self.original = self.capture / 'original.pdf'
        document = canvas.Canvas(str(self.original))
        for number in (1, 2):
            document.drawString(50, 750, f'Synthetic page {number}')
            document.showPage()
        document.save()
        self.before = INSPECTOR.reference(self.original)

    def tearDown(self):
        self.assertEqual(INSPECTOR.reference(self.original), self.before)

    def test_actual_timeout_retains_terminal_receipt(self):
        render = self.capture / 'rendered'
        render.mkdir()
        receipt = INSPECTOR.run_process(
            [INSPECTOR.BIN + '/pdfinfo', str(self.original)], render, 'timeout', 0
        )
        self.assertTrue(receipt['started'])
        self.assertTrue(receipt['timedOut'])
        self.assertIsNotNone(receipt['exitCode'])
        self.assertNotEqual(receipt['exitCode'], 0)
        self.assertEqual(len(receipt['logs']), 2)
        self.assertTrue(receipt['bindingsUnchanged'])

    def test_unregistered_command_never_starts(self):
        render = self.capture / 'rendered'
        render.mkdir()
        receipt = INSPECTOR.run_process(['/bin/sleep', '1'], render, 'unregistered', 2)
        self.assertFalse(receipt['started'])
        self.assertIsNone(receipt['exitCode'])
        self.assertFalse(receipt['timedOut'])

    def test_actual_partial_raster_is_retained_as_unavailable(self):
        real_run = INSPECTOR.run_process

        def first_page_only(command, root, label, seconds):
            if label == 'raster':
                command = [command[0], '-f', '1', '-l', '1', *command[1:]]
            return real_run(command, root, label, seconds)

        INSPECTOR.run_process = first_page_only
        try:
            result = INSPECTOR.inspect({
                'inspectionId': 'partial-raster-control', 'family': 'pdf_create',
                'artifact': self.before, 'outputRoot': str(self.case / 'inspection'),
            })
        finally:
            INSPECTOR.run_process = real_run
        self.assertEqual(result['observedRenderPages'], 2)
        self.assertEqual(len(result['pages']), 1)
        self.assertTrue(result['pages'][0]['imageAvailable'])
        self.assertEqual(result['coverage']['visual']['state'], 'unavailable')
        self.assertFalse(result['inspectionMeasurementAvailable'])
        self.assertIsNone(result['semanticPass'])

    def test_exact_policy_denies_loopback_bind(self):
        render = self.capture / 'rendered'
        render.mkdir()
        launch, env, evidence = INSPECTOR.renderer_launch(
            [INSPECTOR.BIN + '/pdfinfo', str(self.original)], render
        )
        prefix = launch[:launch.index('-p') + 2]
        code = '''socket(my $s, PF_INET, SOCK_STREAM, 0) or die "socket: $!";
if (bind($s, sockaddr_in(0, inet_aton("127.0.0.1")))) { die "unexpected allowed bind"; }
die "unexpected error: $!" unless $!{EPERM} || $!{EACCES};
print "BIND_DENIED\\n";'''
        INSPECTOR.write_json(self.case / 'admission.json', evidence)
        completed = subprocess.run(
            [*prefix, '/usr/bin/perl', '-MSocket', '-e', code],
            cwd=render, env=env, capture_output=True, timeout=10, check=False,
        )
        (self.case / 'stdout.log').write_bytes(completed.stdout)
        (self.case / 'stderr.log').write_bytes(completed.stderr)
        INSPECTOR.write_json(self.case / 'result.json', {'exitCode': completed.returncode})
        self.assertEqual(completed.returncode, 0)
        self.assertEqual(completed.stdout, b'BIND_DENIED\n')


class RetainedResult(unittest.TextTestResult):
    def stopTestRun(self):
        super().stopTestRun()
        if ROOT_OWNED and INSPECTOR is not None:
            INSPECTOR.write_json(ROOT / 'unittest-result.json', {
                'testsRun': self.testsRun, 'successful': self.wasSuccessful(),
                'failures': [{'test': test.id(), 'traceback': tb} for test, tb in self.failures],
                'errors': [{'test': test.id(), 'traceback': tb} for test, tb in self.errors],
                'limits': 'No descendant quiescence or full semantic coverage claim.',
            })


if __name__ == '__main__':
    unittest.main(testRunner=unittest.TextTestRunner(verbosity=2, resultclass=RetainedResult))
