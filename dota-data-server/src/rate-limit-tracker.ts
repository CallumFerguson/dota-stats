export class RateLimitTracker {
  private timestamps: number[] = [];

  constructor(private readonly windowMs: number) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error("Rate-limit window must be a positive number.");
    }
  }

  record(timestamp = Date.now()): number {
    const cutoff = timestamp - this.windowMs;
    this.timestamps = this.timestamps.filter(
      (recordedAt) => recordedAt > cutoff,
    );
    this.timestamps.push(timestamp);
    return this.timestamps.length;
  }
}
