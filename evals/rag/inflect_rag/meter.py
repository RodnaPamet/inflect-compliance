"""The run's cost meter, as the judge sees it: the metering proxy on loopback.

`evals/cost-meter/anthropic-proxy.mjs` holds the key and the job's share and
reserves every judge call before it is sent. This module only READS its state
(what the record's `spendUsd`, `status` and `priceTableHash` are taken from)
and reserves / settles spend the job causes elsewhere (the product answering a
question), so the judge and the answers share one share.

There is no way here to spend without the proxy: the judge's client is pointed
at it, and the harness never holds the key.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass


class BudgetExhausted(Exception):
    """The proxy refused a call: the job's share cannot fit it. The run stops."""


@dataclass(frozen=True)
class MeterState:
    job: str
    model: str
    share_usd: float
    price_table_hash: str
    spent_usd: float
    status: str  # COMPLETE | BUDGET_EXHAUSTED
    open_reservations: int


class Meter:
    def __init__(self, base_url: str, timeout: float = 10.0):
        if not base_url.startswith(("http://127.0.0.1", "http://localhost")):
            raise ValueError("the metering proxy listens on loopback only")
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def _call(self, method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(
            f"{self.base_url}{path}", data=data, method=method, headers={"content-type": "application/json"}
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:  # noqa: S310 - loopback only
                return res.status, json.loads(res.read() or b"{}")
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read() or b"{}")

    def state(self) -> MeterState:
        status, s = self._call("GET", "/meter/state")
        if status != 200:
            raise RuntimeError(f"the metering proxy answered {status} for its state")
        return MeterState(
            job=s["job"],
            model=s["model"],
            share_usd=s["shareUsd"],
            price_table_hash=s["priceTableHash"],
            spent_usd=s["spentUsd"],
            status=s["status"],
            open_reservations=s["openReservations"],
        )

    def exhausted(self) -> bool:
        return self.state().status == "BUDGET_EXHAUSTED"

    def reserve(self, input_tokens: int, max_output_tokens: int) -> int:
        """Reserve spend the job causes outside the proxy; raises BudgetExhausted when it cannot fit."""
        status, r = self._call("POST", "/meter/reserve", {"inputTokens": input_tokens, "maxOutputTokens": max_output_tokens})
        if status == 402:
            raise BudgetExhausted("the share cannot fit the answer turn")
        if status != 200 or not r.get("ok"):
            raise RuntimeError(f"the metering proxy refused a reservation ({status})")
        return int(r["id"])

    def settle(self, reservation: int, usage: dict | None) -> None:
        """Settle a reservation; `None` (or an unreadable usage) keeps the worst case."""
        status, _ = self._call("POST", "/meter/settle", {"id": reservation, "usage": usage})
        if status != 200:
            raise RuntimeError(f"the metering proxy could not settle reservation {reservation} ({status})")
