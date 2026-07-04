"""Gitnix SDK - Rate Limiter.

Token bucket with concurrent request limiting, backpressure, and retry.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Awaitable, Callable, TypeVar

from gitnix.types import RateLimiterConfig

T = TypeVar("T")


class RateLimiter:
    """Rate limiter with queue, backpressure, and retry."""

    def __init__(self, config: RateLimiterConfig | None = None) -> None:
        self._config = config or RateLimiterConfig()
        self._remaining = self._config.max_requests_per_hour
        self._limit = self._config.max_requests_per_hour
        self._reset = time.time() + 3600
        self._used = 0
        self._points_this_minute = 0
        self._writes_this_minute = 0
        self._active_concurrent = 0
        self._semaphore = asyncio.Semaphore(self._config.max_concurrent)
        self._minute_reset_task: asyncio.Task[None] | None = None

    def start(self) -> None:
        """Start background minute-reset loop."""
        if self._minute_reset_task is None:
            self._minute_reset_task = asyncio.create_task(self._reset_loop())

    def stop(self) -> None:
        """Stop background tasks."""
        if self._minute_reset_task:
            self._minute_reset_task.cancel()
            self._minute_reset_task = None

    async def _reset_loop(self) -> None:
        """Reset per-minute counters every 60 seconds."""
        while True:
            await asyncio.sleep(60)
            self._points_this_minute = 0
            self._writes_this_minute = 0

    def update_from_headers(self, headers: dict[str, str]) -> None:
        """Update state from GitHub response headers."""
        if "x-ratelimit-limit" in headers:
            self._limit = int(headers["x-ratelimit-limit"])
        if "x-ratelimit-remaining" in headers:
            self._remaining = int(headers["x-ratelimit-remaining"])
        if "x-ratelimit-reset" in headers:
            self._reset = int(headers["x-ratelimit-reset"])
        if "x-ratelimit-used" in headers:
            self._used = int(headers["x-ratelimit-used"])

    def _can_request(self, is_write: bool) -> bool:
        """Check if we can make a request now."""
        if self._remaining <= 0:
            if time.time() < self._reset:
                return False
            self._remaining = self._limit
            self._used = 0

        points = 5 if is_write else 1
        if self._points_this_minute + points > 900:
            return False

        if is_write and self._writes_this_minute >= self._config.max_writes_per_minute:
            return False

        return True

    async def execute(
        self,
        fn: Callable[[], Awaitable[T]],
        is_write: bool = False,
    ) -> T:
        """Execute with rate limiting, concurrency control, and retry."""
        # Wait for capacity
        while not self._can_request(is_write):
            await asyncio.sleep(0.1)

        async with self._semaphore:
            points = 5 if is_write else 1
            self._points_this_minute += points
            self._remaining -= 1
            self._used += 1
            if is_write:
                self._writes_this_minute += 1

            last_error: Exception | None = None
            for attempt in range(self._config.retry_attempts + 1):
                try:
                    return await fn()
                except Exception as e:
                    last_error = e
                    is_rate_limit = "rate limit" in str(e).lower() or "429" in str(e)
                    if not is_rate_limit or attempt == self._config.retry_attempts:
                        raise
                    delay = self._config.retry_base_delay * (2**attempt)
                    await asyncio.sleep(delay)

            raise last_error  # type: ignore[misc]

    @property
    def remaining(self) -> int:
        return self._remaining

    @property
    def used(self) -> int:
        return self._used
