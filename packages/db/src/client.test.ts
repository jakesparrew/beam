import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createDbHandle, watchPool } from "./client";

describe("pool error handling", () => {
  it("an idle-connection error on the pool is logged instead of crashing the process", () => {
    const pool = new EventEmitter();
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    watchPool(pool, "neon-ws");
    // Without a listener, EventEmitter throws on an "error" event (Node would exit).
    expect(() => pool.emit("error", new Error("Connection terminated unexpectedly"))).not.toThrow();
    expect(write).toHaveBeenCalledWith(expect.stringContaining("Connection terminated unexpectedly"));
    // A client the pool hands out gets its own listener: a drop while checked out does not throw either.
    const client = new EventEmitter();
    pool.emit("connect", client);
    expect(() => client.emit("error", new Error("Connection terminated unexpectedly"))).not.toThrow();
    write.mockRestore();
  });

  it("both drivers' pools listen for errors (no connection is opened)", async () => {
    for (const driver of ["pg", "neon-ws"] as const) {
      const handle = await createDbHandle(driver, "postgres://beam:beam@127.0.0.1:1/beam");
      const pool = (handle.db as unknown as { $client: EventEmitter }).$client;
      expect(pool.listenerCount("error"), driver).toBeGreaterThan(0);
      await handle.close();
    }
  });
});
