import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type http from "node:http";
import test from "node:test";

import { writeSseChunk } from "../src/server/request-context.js";

function fakeResponse(writeResult: boolean): http.ServerResponse & EventEmitter {
  const response = new EventEmitter() as http.ServerResponse & EventEmitter;
  Object.defineProperty(response, "destroyed", { value: false });
  Object.defineProperty(response, "writableEnded", { value: false });
  response.write = (() => writeResult) as http.ServerResponse["write"];
  return response;
}

test("SSE writer waits for drain and stops waiting on disconnect", async () => {
  const slow = fakeResponse(false);
  let settled = false;
  const pending = writeSseChunk(slow, "data: x\n\n").then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  slow.emit("drain");
  await pending;
  assert.equal(settled, true);
  assert.equal(slow.listenerCount("drain"), 0);

  const disconnected = fakeResponse(false);
  const aborted = writeSseChunk(disconnected, "data: x\n\n");
  disconnected.emit("close");
  await assert.rejects(aborted, /disconnected/);
  assert.equal(disconnected.listenerCount("drain"), 0);
});

test("slow writable allows only one queued application write", async () => {
  const response = fakeResponse(false);
  let outstanding = 0;
  let peakOutstanding = 0;
  let writes = 0;
  response.write = (() => {
    writes++;
    outstanding++;
    peakOutstanding = Math.max(peakOutstanding, outstanding);
    setImmediate(() => {
      outstanding--;
      response.emit("drain");
    });
    return false;
  }) as http.ServerResponse["write"];

  for (let i = 0; i < 100; i++) {
    await writeSseChunk(response, `data: ${i}\n\n`);
  }
  assert.equal(writes, 100);
  assert.equal(peakOutstanding, 1);
});
