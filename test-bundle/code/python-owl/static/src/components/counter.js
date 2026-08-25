/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";

/**
 * Compteur Owl branché sur demo.counter.
 *
 * Le seul point qui mérite un mot : l'incrément passe par le serveur, parce
 * que la valeur y est contrainte. Un compteur purement local se serait
 * désynchronisé au premier refus.
 */
export class DemoCounter extends Component {
    static template = "python_owl.DemoCounter";
    static props = { recordId: { type: Number, optional: true } };

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.state = useState({ value: 0, busy: false });
        onWillStart(() => this.load());
    }

    async load() {
        if (!this.props.recordId) return;
        const [rec] = await this.orm.read("demo.counter", [this.props.recordId], ["value"]);
        this.state.value = rec?.value ?? 0;
    }

    async onIncrement() {
        if (this.state.busy || !this.props.recordId) return;
        this.state.busy = true;
        try {
            this.state.value = await this.orm.call(
                "demo.counter", "action_increment", [[this.props.recordId]],
            );
        } catch (err) {
            this.notification.add(err.message ?? "Échec de l'incrément", { type: "danger" });
        } finally {
            this.state.busy = false;
        }
    }
}

registry.category("view_widgets").add("demo_counter", { component: DemoCounter });
