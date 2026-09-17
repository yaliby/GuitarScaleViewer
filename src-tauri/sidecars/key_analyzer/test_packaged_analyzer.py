"""Run the distributed analyzer from an unrelated working directory."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class PackagedAnalyzerTests(unittest.TestCase):
    def test_packaged_runtime_analyzes_d_major_without_system_python(self):
        native = Path(__file__).resolve().parents[2]
        executable = Path(os.environ.get("PACKAGED_ANALYZER_PATH", str(native / "sidecars/key_analyzer/dist/key_analyzer/key_analyzer.exe")))
        request = {"wavPath": str(native / "tests/fixtures/clear_major_loop.wav"),
                   "sampleRateHz": 44100, "windowSeconds": 12, "hopSeconds": 4,
                   "profileTypes": ["bgate", "krumhansl", "shaath", "temperley", "edma"]}
        with tempfile.TemporaryDirectory() as cwd:
            result = subprocess.run([str(executable), "--serve"], input=json.dumps(request) + "\n",
                                    text=True, capture_output=True, timeout=10, cwd=cwd,
                                    creationflags=subprocess.CREATE_NO_WINDOW)
        self.assertEqual(result.returncode, 0, result.stderr)
        ready, response = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertTrue(ready["numpyAvailable"])
        self.assertEqual(response["backendUsed"], "numpy_fallback")
        self.assertEqual(len(response["windows"]), 12)
        self.assertEqual({(window["key"], window["scale"]) for window in response["windows"]}, {("D", "major")})
        for window in response["windows"]:
            self.assertEqual(len(window.get("candidates", [])), 24)
            self.assertIsInstance(window.get("tuningCents"), (int, float))
            self.assertGreaterEqual(window["firstToSecondRelativeStrength"], 0)


if __name__ == "__main__":
    unittest.main()
