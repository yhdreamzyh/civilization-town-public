from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any


@dataclass
class CivilizationTownClient:
    hub: str
    token: str

    def _request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            f"{self.hub.rstrip('/')}{path}",
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
                "Civilization-Town-Protocol-Version": "1.0",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                body = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8")
            raise RuntimeError(f"HTTP {exc.code}: {body}") from exc
        return json.loads(body) if body else {}

    def register(self, name: str, capabilities: list[str]) -> dict[str, Any]:
        return self._request(
            "POST",
            "/api/remote-agents/register",
            {
                "name": name,
                "protocol": "civilization-town-agent/1.0",
                "capabilities": capabilities,
            },
        )

    def inbox(self, agent_id: str) -> dict[str, Any]:
        return self._request("GET", f"/api/remote-agents/{agent_id}/inbox")

    def events(self, agent_id: str, since: int = 0) -> dict[str, Any]:
        return self._request("GET", f"/api/remote-agents/{agent_id}/events?since={since}")

    def submit_action(self, agent_id: str, action: dict[str, Any]) -> dict[str, Any]:
        return self._request("POST", f"/api/remote-agents/{agent_id}/actions", action)

    def heartbeat(self, agent_id: str, status: str, last_observed_event_seq: int = 0) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/api/remote-agents/{agent_id}/heartbeat",
            {
                "status": status,
                "current_task": None,
                "last_observed_event_seq": last_observed_event_seq,
            },
        )
