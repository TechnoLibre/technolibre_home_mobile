from odoo import api, fields, models
from odoo.exceptions import ValidationError


class DemoCounter(models.Model):
    _name = "demo.counter"
    _description = "Compteur de démonstration"
    _order = "sequence, id"

    name = fields.Char(required=True, translate=True)
    sequence = fields.Integer(default=10)
    value = fields.Integer(default=0)
    step = fields.Integer(default=1, help="De combien un clic avance.")
    doubled = fields.Integer(compute="_compute_doubled", store=False)

    @api.depends("value")
    def _compute_doubled(self):
        for rec in self:
            rec.doubled = rec.value * 2

    @api.constrains("step")
    def _check_step(self):
        for rec in self:
            if rec.step <= 0:
                raise ValidationError("Le pas doit être strictement positif.")

    def action_increment(self):
        """Appelé depuis le composant Owl."""
        for rec in self:
            rec.value += rec.step
        return self.value
