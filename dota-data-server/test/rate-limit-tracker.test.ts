import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RateLimitTracker } from "../src/rate-limit-tracker.js";

describe("RateLimitTracker", () => {
  it("counts events inside the rolling window", () => {
    const tracker = new RateLimitTracker(10 * 60 * 1_000);

    for (let eventNumber = 1; eventNumber <= 10; eventNumber += 1) {
      assert.equal(tracker.record(eventNumber * 1_000), eventNumber);
    }
  });

  it("drops events that are at least one full window old", () => {
    const tenMinutes = 10 * 60 * 1_000;
    const tracker = new RateLimitTracker(tenMinutes);

    assert.equal(tracker.record(1_000), 1);
    assert.equal(tracker.record(tenMinutes), 2);
    assert.equal(tracker.record(tenMinutes + 1_000), 2);
  });
});
