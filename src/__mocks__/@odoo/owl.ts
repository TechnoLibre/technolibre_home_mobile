export class EventBus {
	private _handlers: Record<string, Function[]> = {};

	addEventListener(event: string, handler: Function) {
		if (!this._handlers[event]) this._handlers[event] = [];
		this._handlers[event].push(handler);
	}

	trigger(event: string, detail?: any) {
		for (const handler of this._handlers[event] || []) {
			handler(detail);
		}
	}
}
