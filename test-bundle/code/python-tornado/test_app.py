import json

from tornado.testing import AsyncHTTPTestCase

from app import make_app


class TestStatus(AsyncHTTPTestCase):
    def get_app(self):
        return make_app()

    def test_status_repond_du_json(self):
        rep = self.fetch("/api/status")
        assert rep.code == 200
        corps = json.loads(rep.body)
        assert corps["service"] == "démo-tornado"

    def test_une_route_inconnue_rend_une_erreur_json(self):
        rep = self.fetch("/api/absent")
        assert rep.code == 404
        assert "erreur" in json.loads(rep.body)
