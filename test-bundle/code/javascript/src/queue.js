/**
 * File d'attente à concurrence bornée.
 *
 * Le piège que ce code évite : résoudre la promesse d'attente avant que le
 * créneau soit vraiment libre. Le compteur est décrémenté dans le `finally`,
 * pas dans le `then`, sinon un rejet laisse un créneau perdu pour toujours.
 */
export class BoundedQueue {
    #limit;
    #running = 0;
    #waiting = [];

    constructor(limit = 4) {
        if (!Number.isInteger(limit) || limit < 1) {
            throw new RangeError(`limite invalide : ${limit}`);
        }
        this.#limit = limit;
    }

    get pending() {
        return this.#waiting.length;
    }

    async run(task) {
        if (this.#running >= this.#limit) {
            await new Promise((resolve) => this.#waiting.push(resolve));
        }
        this.#running += 1;
        try {
            return await task();
        } finally {
            this.#running -= 1;
            this.#waiting.shift()?.();
        }
    }

    async all(tasks) {
        return Promise.all(tasks.map((t) => this.run(t)));
    }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
