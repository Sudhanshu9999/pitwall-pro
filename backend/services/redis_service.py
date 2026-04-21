"""
Redis service — Pub/Sub helpers and key-value caching.

Channel naming convention:
  replay:{session_key}          — replay frames published by the replay worker
  replay:{session_key}:control  — control messages from clients (speed, pause, stop)
"""
from __future__ import annotations
import json
import os
from typing import AsyncIterator

import redis.asyncio as aioredis

_REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")

# One shared connection pool for the process
_pool: aioredis.Redis | None = None


def _get_redis() -> aioredis.Redis:
    global _pool
    if _pool is None:
        try:
            # Try real Redis first
            import socket
            from urllib.parse import urlparse
            parsed = urlparse(_REDIS_URL)
            host = parsed.hostname or "localhost"
            port = parsed.port or 6379
            s = socket.create_connection((host, port), timeout=1)
            s.close()
            _pool = aioredis.from_url(_REDIS_URL, decode_responses=True)
        except Exception:
            # Fall back to fakeredis for local development without a Redis server
            try:
                import fakeredis.aioredis as fakeredis  # type: ignore
                _pool = fakeredis.FakeRedis(decode_responses=True)
            except ImportError:
                # No fakeredis either — use real Redis and let it fail at call time
                _pool = aioredis.from_url(_REDIS_URL, decode_responses=True)
    return _pool


# ---------------------------------------------------------------------------
# Key helpers
# ---------------------------------------------------------------------------

def replay_channel(session_key: str) -> str:
    return f"replay:{session_key}"


def control_channel(session_key: str) -> str:
    return f"replay:{session_key}:control"


def session_meta_key(session_key: str) -> str:
    return f"session:{session_key}:meta"


# ---------------------------------------------------------------------------
# Publish / subscribe
# ---------------------------------------------------------------------------

async def publish(channel: str, message: dict) -> None:
    r = _get_redis()
    await r.publish(channel, json.dumps(message))


async def subscribe_frames(channel: str) -> AsyncIterator[dict]:
    """Async generator that yields decoded messages from a Pub/Sub channel."""
    r = _get_redis()
    pubsub = r.pubsub()
    await pubsub.subscribe(channel)
    try:
        async for raw in pubsub.listen():
            if raw["type"] != "message":
                continue
            try:
                yield json.loads(raw["data"])
            except json.JSONDecodeError:
                continue
    finally:
        await pubsub.unsubscribe(channel)
        await pubsub.aclose()


# ---------------------------------------------------------------------------
# Session metadata cache
# ---------------------------------------------------------------------------

async def cache_session_meta(session_key: str, meta: dict, ttl: int = 3600) -> None:
    r = _get_redis()
    await r.setex(session_meta_key(session_key), ttl, json.dumps(meta))


async def get_session_meta(session_key: str) -> dict | None:
    r = _get_redis()
    raw = await r.get(session_meta_key(session_key))
    return json.loads(raw) if raw else None


async def is_session_loaded(session_key: str) -> bool:
    return await get_session_meta(session_key) is not None


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

async def ping() -> bool:
    try:
        r = _get_redis()
        return await r.ping()
    except Exception:
        return False
