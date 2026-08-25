#!/usr/bin/env python3
"""Serveur Tornado de démonstration.

Trois choses à regarder dans la coloration : les décorateurs, les chaînes
préfixées, et les triples guillemets comme celui-ci.
"""
import asyncio
import json
import logging
from datetime import datetime, timezone

import tornado.web
import tornado.websocket

log = logging.getLogger("demo")

CLIENTS: set["EchoSocket"] = set()


class BaseHandler(tornado.web.RequestHandler):
    """Réponses JSON et erreurs qui ne fuient pas la trace."""

    def write_json(self, payload: dict, status: int = 200) -> None:
        self.set_status(status)
        self.set_header("Content-Type", "application/json; charset=utf-8")
        self.finish(json.dumps(payload, ensure_ascii=False))

    def write_error(self, status_code: int, **kwargs) -> None:
        self.write_json({"erreur": self._reason, "code": status_code}, status_code)


class StatusHandler(BaseHandler):
    async def get(self) -> None:
        await asyncio.sleep(0)  # rendre la main, pour la forme
        self.write_json({
            "service": "démo-tornado",
            "heure": datetime.now(timezone.utc).isoformat(),
            "clients": len(CLIENTS),
        })


class EchoSocket(tornado.websocket.WebSocketHandler):
    def open(self) -> None:
        CLIENTS.add(self)
        log.info("ouverture, %d client(s)", len(CLIENTS))

    def on_message(self, message: str) -> None:
        self.write_message(f"echo: {message}")

    def on_close(self) -> None:
        CLIENTS.discard(self)


def make_app() -> tornado.web.Application:
    return tornado.web.Application(
        [
            (r"/api/status", StatusHandler),
            (r"/ws/echo", EchoSocket),
        ],
        debug=False,
    )


async def main() -> None:
    logging.basicConfig(level=logging.INFO)
    make_app().listen(8888)
    log.info("écoute sur http://localhost:8888")
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
