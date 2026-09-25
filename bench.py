"""bench.py — measured token/$ savings for the local cache.

Fires identical calls (should HIT after the first) + varied calls (should MISS),
through the proxy, and prints cold-vs-warm cost. This produces the REAL numbers
the design doc only modeled.

Prereqs:
  pip install anthropic            # only dependency; the proxy itself is zero-dep
  export ANTHROPIC_API_KEY_REAL=sk-ant-...   # set in your SHELL, never in this file
  ./cachectl-a.sh on
Run:
  python bench.py --identical 5 --varied 5 --model claude-haiku-4-5-20251001

Use a cheap model (haiku) for the benchmark itself.
"""
import argparse
import time

import anthropic

PRICE = {  # per-token, blended; extend as needed
    "claude-haiku-4-5-20251001": (0.8e-6, 4e-6),
    "claude-opus-4-8": (15e-6, 75e-6),
}


def call(client, model, prompt):
    t = time.time()
    r = client.messages.create(
        model=model, max_tokens=256,
        messages=[{"role": "user", "content": prompt}],
    )
    dt = time.time() - t
    u = r.usage
    return u.input_tokens, u.output_tokens, dt


def cost(model, itok, otok):
    pin, pout = PRICE.get(model, (15e-6, 75e-6))
    return itok * pin + otok * pout


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--identical", type=int, default=5)
    ap.add_argument("--varied", type=int, default=5)
    ap.add_argument("--model", default="claude-haiku-4-5-20251001")
    ap.add_argument("--base-url", default="http://localhost:4000")
    a = ap.parse_args()

    client = anthropic.Anthropic(base_url=a.base_url, api_key="sk-local-cache")

    # 1) Identical prompt repeated: first = miss (billed), rest should be cache hits ($0).
    fixed = "Summarize the CAP theorem in one sentence."
    cold_i, cold_o, _ = call(client, a.model, fixed)
    cold_cost = cost(a.model, cold_i, cold_o)
    warm_costs = []
    for _ in range(a.identical - 1):
        i, o, dt = call(client, a.model, fixed)
        # A true hit returns instantly with no upstream usage billed.
        warm_costs.append((cost(a.model, i, o), dt))

    # 2) Varied prompts: all misses (control).
    varied_cost = 0.0
    for n in range(a.varied):
        i, o, _ = call(client, a.model, f"Explain idea #{n} about distributed caching.")
        varied_cost += cost(a.model, i, o)

    print("\n=== MEASURED ===")
    print(f"identical run: 1 cold (${cold_cost:.5f}) + {a.identical-1} warm")
    print(f"  warm avg cost: ${sum(c for c,_ in warm_costs)/max(1,len(warm_costs)):.5f}"
          f"   warm avg latency: {sum(d for _,d in warm_costs)/max(1,len(warm_costs)):.3f}s")
    naive = cold_cost * a.identical
    actual = cold_cost + sum(c for c, _ in warm_costs)
    print(f"  identical block: naive ${naive:.5f} -> actual ${actual:.5f}  "
          f"saved {100*(naive-actual)/naive:.1f}%")
    print(f"varied block (control, all miss): ${varied_cost:.5f}")
    print("\nNow run:  ./cachectl-a.sh stats   for the proxy-side ledger.")


if __name__ == "__main__":
    main()
