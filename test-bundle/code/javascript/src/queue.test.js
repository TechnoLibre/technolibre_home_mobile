import { test } from "node:test";
import assert from "node:assert/strict";

import { BoundedQueue, sleep } from "./queue.js";

test("ne dépasse jamais la limite", async () => {
    const q = new BoundedQueue(2);
    let live = 0;
    let peak = 0;
    await q.all(
        Array.from({ length: 8 }, () => async () => {
            live += 1;
            peak = Math.max(peak, live);
            await sleep(5);
            live -= 1;
        }),
    );
    assert.equal(peak, 2);
});

test("un rejet ne perd pas le créneau", async () => {
    const q = new BoundedQueue(1);
    await assert.rejects(q.run(async () => { throw new Error("boum"); }));
    assert.equal(await q.run(async () => "après"), "après");
});

test("refuse une limite absurde", () => {
    assert.throws(() => new BoundedQueue(0), RangeError);
});
