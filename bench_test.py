"""Offline benchmark regressions; no credentials or paid requests."""
import contextlib
import http.server
import io
import json
import threading
import unittest
import bench


class BenchmarkTests(unittest.TestCase):
    def test_replayed_usage_is_not_billed_again(self):
        rows = [(100, 10, 0.5, "MISS"), (100, 10, 0.001, "HIT")]
        naive, actual = bench.estimated_costs("claude-haiku-4-5-20251001", rows)
        self.assertAlmostEqual(naive, 2 * actual)
        with self.assertRaisesRegex(ValueError, "classification"):
            bench.estimated_costs("model", [(0, 0, 0, "UNKNOWN")])

    def test_invalid_counts_stop_before_any_network_call(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as result:
            bench.main(["--identical", "0"])
        self.assertEqual(result.exception.code, 2)

    def test_raw_http_preserves_cache_classification_and_usage(self):
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                self.server.received = (self.path, body)
                self.send_response(200)
                self.send_header("x-cache", "HIT")
                self.end_headers()
                self.wfile.write(b'{"usage":{"input_tokens":12,"output_tokens":3}}')

            def log_message(self, *_args):
                pass

        with http.server.HTTPServer(("127.0.0.1", 0), Handler) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                row = bench.call(f"http://127.0.0.1:{server.server_port}", "test-model", "prompt")
                self.assertEqual((row[0], row[1], row[3]), (12, 3, "HIT"))
                self.assertEqual(server.received[0], "/v1/messages")
                self.assertEqual(server.received[1]["messages"][0]["content"], "prompt")
            finally:
                server.shutdown()
                thread.join()


if __name__ == "__main__":
    unittest.main()
