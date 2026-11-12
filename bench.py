"""Measure local-cache latency and estimated savings. Calls are live and paid on MISS.

Run: python3 bench.py --identical 5 --varied 0 --base-url http://127.0.0.1:4000
No Python packages are required. CACHE_AUTH_TOKEN authenticates to a gated proxy.
Prices are illustrative; the proxy ledger and provider invoice remain authoritative.
"""
import argparse
import json
import os
import time
import urllib.request

PRICE = {
    "claude-haiku-4-5-20251001": (0.8e-6, 4e-6),
    "claude-opus-4-8": (15e-6, 75e-6),
}


def call(base_url, model, prompt):
    """Return input/output tokens, latency, and the proxy's cache classification."""
    body = json.dumps({"model": model, "max_tokens": 256,
                       "messages": [{"role": "user", "content": prompt}]}).encode()
    headers = {"Content-Type": "application/json", "anthropic-version": "2023-06-01"}
    if os.environ.get("CACHE_AUTH_TOKEN"):
        headers["x-cache-auth"] = os.environ["CACHE_AUTH_TOKEN"]
    req = urllib.request.Request(base_url.rstrip("/") + "/v1/messages", data=body, headers=headers)
    started = time.perf_counter()
    with urllib.request.urlopen(req, timeout=120) as response:
        result = json.load(response)
        classification = response.headers.get("x-cache", "UNKNOWN")
    usage = result.get("usage", {})
    return (usage.get("input_tokens", 0), usage.get("output_tokens", 0),
            time.perf_counter() - started, classification)


def cost(model, itok, otok):
    pin, pout = PRICE.get(model, (15e-6, 75e-6))
    return itok * pin + otok * pout


def estimated_costs(model, results):
    """Replay carries original usage, so only x-cache can identify an unbilled hit."""
    if any(row[3] not in {"MISS", "HIT", "HIT-NORM", "HIT-SUFFIX", "HIT-COALESCED"} for row in results):
        raise ValueError("missing or unknown x-cache classification; cannot estimate savings")
    naive = sum(cost(model, row[0], row[1]) for row in results)
    actual = sum(cost(model, row[0], row[1]) for row in results if row[3] == "MISS")
    return naive, actual


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--identical", type=int, default=5)
    ap.add_argument("--varied", type=int, default=5)
    ap.add_argument("--model", default="claude-haiku-4-5-20251001")
    ap.add_argument("--base-url", default="http://127.0.0.1:4000")
    args = ap.parse_args(argv)
    if args.identical < 1 or args.varied < 0:
        ap.error("--identical must be >=1 and --varied must be >=0")
    nonce = time.time_ns()
    prompt = f"Summarize the CAP theorem in one sentence. benchmark={nonce}"
    results = [call(args.base_url, args.model, prompt) for _ in range(args.identical)]
    varied = [call(args.base_url, args.model, f"Explain distributed caching idea {n}. benchmark={nonce}")
              for n in range(args.varied)]
    naive, actual = estimated_costs(args.model, results)
    hits = sum(row[3].startswith("HIT") for row in results)
    warm = results[1:]
    print("\n=== MEASURED CACHE RESULTS ===")
    print(f"identical calls: {len(results)}; cache hits: {hits}; upstream MISS: {len(results) - hits}")
    print(f"cold latency: {results[0][2]:.3f}s; warm avg latency: "
          f"{sum(row[2] for row in warm) / max(1, len(warm)):.3f}s")
    saved = 100 * (naive - actual) / naive if naive else 0
    print(f"estimated identical cost: naive ${naive:.5f} -> upstream ${actual:.5f}; saved {saved:.1f}%")
    if varied:
        _, varied_cost = estimated_costs(args.model, varied)
        print(f"varied calls: {len(varied)}; estimated upstream cost: ${varied_cost:.5f}")
    print("Estimates use built-in rates. Run ./cachectl-a.sh stats for the proxy ledger.")


if __name__ == "__main__":
    main()
