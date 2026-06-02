from __future__ import annotations

import argparse
import pathlib
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sdk" / "python"))

from civilization_town_client import CivilizationTownClient


def main() -> None:
    parser = argparse.ArgumentParser(description="Minimal Civilization Town remote agent")
    parser.add_argument("--hub", default="http://127.0.0.1:4183")
    parser.add_argument("--token", required=True)
    parser.add_argument("--name", default="External Researcher")
    parser.add_argument("--poll-interval", type=float, default=5.0)
    args = parser.parse_args()

    client = CivilizationTownClient(args.hub, args.token)
    registration = client.register(
        args.name,
        [
            "society:read",
            "message:receive",
            "message:send",
            "board:write",
            "task:claim",
        ],
    )
    agent_id = registration["agent_id"]
    print(f"registered remote agent: {agent_id}")

    last_seq = 0
    while True:
        inbox = client.inbox(agent_id)
        events = client.events(agent_id, since=last_seq)
        for event in events.get("events", []):
            last_seq = max(last_seq, int(event.get("seq", last_seq)))

        for message in inbox.get("messages", []):
            message_id = message.get("message_id", "message")
            sender = message.get("from_agent_id") or message.get("from") or "unknown"
            content = message.get("content", "")
            if message.get("need_reply"):
                client.submit_action(
                    agent_id,
                    {
                        "type": "message.send",
                        "target_agent_id": sender,
                        "message_id": f"{agent_id}-reply-{int(time.time())}",
                        "reply_to_message_id": message_id,
                        "need_reply": False,
                        "content": f"I received your message and will inspect it. Preview: {content[:120]}",
                    },
                )

        client.heartbeat(agent_id, "idle", last_observed_event_seq=last_seq)
        time.sleep(args.poll_interval)


if __name__ == "__main__":
    main()
