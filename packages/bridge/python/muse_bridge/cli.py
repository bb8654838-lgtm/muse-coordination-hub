from __future__ import annotations

import argparse
import json
import os
import sys

from .client import BridgeClient, BridgeError


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="muse-bridge-py")
    root.add_argument("--url", default=os.getenv("MUSE_HUB_URL"))
    root.add_argument("--key", default=os.getenv("MUSE_AGENT_KEY"))
    commands = root.add_subparsers(dest="command", required=True)

    register = commands.add_parser("register")
    register.add_argument("--workspace", required=True)
    register.add_argument("--invite", required=True)
    register.add_argument("--name", required=True)
    register.add_argument("--role", required=True)

    heartbeat = commands.add_parser("heartbeat")
    heartbeat.add_argument("--status", choices=("online", "idle", "offline"), default="online")

    inbox = commands.add_parser("inbox")
    inbox.add_argument("--limit", type=int, default=50)
    inbox.add_argument("--watch", action="store_true")
    inbox.add_argument("--interval", type=int, default=60)

    message = commands.add_parser("message")
    message.add_argument("--channel", required=True)
    message.add_argument("--body", required=True)
    message.add_argument("--type", choices=("NOTE", "TASK", "HANDOFF", "ALERT", "DONE"), default="NOTE")
    message.add_argument("--mentions", default="")
    message.add_argument("--reply-to")

    upload = commands.add_parser("file")
    upload.add_argument("file_path")
    upload.add_argument("--task")
    upload.add_argument("--content-type")

    acknowledge = commands.add_parser("ack")
    acknowledge.add_argument("task_id")

    complete = commands.add_parser("complete")
    complete.add_argument("task_id")
    complete.add_argument("--result-link")
    return root


def main() -> None:
    args = parser().parse_args()
    if not args.url:
        raise SystemExit("--url or MUSE_HUB_URL is required")
    client = BridgeClient(args.url, agent_key=args.key)

    try:
        if args.command == "register":
            result = client.register(
                workspace_id=args.workspace,
                invite_key=args.invite,
                display_name=args.name,
                role=args.role,
            )
        elif args.command == "heartbeat":
            result = client.heartbeat(status=args.status)
        elif args.command == "inbox" and args.watch:
            try:
                for result in client.poll_inbox(
                    limit=args.limit, interval_seconds=args.interval
                ):
                    print(json.dumps(result, separators=(",", ":")), flush=True)
            except KeyboardInterrupt:
                return
            return
        elif args.command == "inbox":
            result = client.inbox(limit=args.limit)
        elif args.command == "message":
            result = client.send_message(
                channel_id=args.channel,
                body=args.body,
                message_type=args.type,
                mentions=[item.strip() for item in args.mentions.split(",") if item.strip()],
                reply_to=args.reply_to,
            )
        elif args.command == "file":
            result = client.upload_file(
                args.file_path,
                task_id=args.task,
                content_type=args.content_type,
            )
        elif args.command == "ack":
            result = client.ack_task(args.task_id)
        elif args.command == "complete":
            result = client.complete_task(args.task_id, result_link=args.result_link)
        else:
            raise AssertionError("unhandled command")
    except BridgeError as error:
        print(
            json.dumps(
                {"error": str(error), "status": error.status, "details": error.payload}
            ),
            file=sys.stderr,
        )
        raise SystemExit(1) from error

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
