"""Custom LiteLLM logger: cache metrics + segment-dedup analytics + completion guard.

Observability only — NEVER alters what is served. Writes to ~/.llm-cache/metrics.db.
Wired via config.yaml: litellm_settings.callbacks = ["callback.cache_metrics"].
"""
import hashlib
import json
import os
import sqlite3
import time
from pathlib import Path

from litellm.integrations.custom_logger import CustomLogger

CACHE_DIR = Path(os.path.expanduser("~/.llm-cache"))
CACHE_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = CACHE_DIR / "metrics.db"

# Approx blended Opus price; override via env to match your model.
PRICE_IN = float(os.environ.get("CACHE_PRICE_IN_PER_M", "15")) / 1_000_000
PRICE_OUT = float(os.environ.get("CACHE_PRICE_OUT_PER_M", "75")) / 1_000_000


def _db():
    con = sqlite3.connect(DB_PATH)
    con.execute(
        """CREATE TABLE IF NOT EXISTS calls(
            ts REAL, model TEXT, cache_hit INTEGER,
            in_tok INTEGER, out_tok INTEGER,
            saved_in INTEGER, saved_out INTEGER, saved_usd REAL)"""
    )
    con.execute(
        """CREATE TABLE IF NOT EXISTS segments(
            ts REAL, kind TEXT, seg_hash TEXT, tok INTEGER)"""
    )
    return con


def _toklen(obj) -> int:
    # Cheap proxy for tokens: ~4 chars/token over the JSON serialization.
    return len(json.dumps(obj, default=str)) // 4


def _hash(obj) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, default=str).encode()).hexdigest()[:16]


class CacheMetrics(CustomLogger):
    def log_success_event(self, kwargs, response_obj, start_time, end_time):
        try:
            self._record(kwargs, response_obj)
        except Exception:
            # Metrics must never break serving.
            pass

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        try:
            self._record(kwargs, response_obj)
        except Exception:
            pass

    def _record(self, kwargs, response_obj):
        # Completion guard: only count complete responses with a real usage block.
        usage = getattr(response_obj, "usage", None) or (
            response_obj.get("usage") if isinstance(response_obj, dict) else None
        )
        if not usage:
            return
        in_tok = int(getattr(usage, "prompt_tokens", 0) or (usage.get("prompt_tokens", 0) if isinstance(usage, dict) else 0))
        out_tok = int(getattr(usage, "completion_tokens", 0) or (usage.get("completion_tokens", 0) if isinstance(usage, dict) else 0))

        hit = bool(kwargs.get("cache_hit", False))
        # On a hit, the saved tokens = what the call WOULD have cost upstream.
        saved_in = in_tok if hit else 0
        saved_out = out_tok if hit else 0
        saved_usd = saved_in * PRICE_IN + saved_out * PRICE_OUT
        model = kwargs.get("model", "?")

        con = _db()
        with con:
            con.execute(
                "INSERT INTO calls VALUES(?,?,?,?,?,?,?,?)",
                (time.time(), model, int(hit), in_tok, out_tok, saved_in, saved_out, saved_usd),
            )
            # Segment analytics on misses only (hits never hit the wire).
            if not hit:
                params = kwargs.get("optional_params", {}) or {}
                msgs = kwargs.get("messages", []) or []
                system = [m for m in msgs if isinstance(m, dict) and m.get("role") == "system"]
                if system:
                    con.execute("INSERT INTO segments VALUES(?,?,?,?)",
                                (time.time(), "system", _hash(system), _toklen(system)))
                for tool in params.get("tools", []) or []:
                    con.execute("INSERT INTO segments VALUES(?,?,?,?)",
                                (time.time(), "tool", _hash(tool), _toklen(tool)))
        con.close()


cache_metrics = CacheMetrics()
