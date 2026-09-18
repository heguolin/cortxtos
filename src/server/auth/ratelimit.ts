export class LoginRateLimiter {
  private failures = 0
  private lockedUntil = 0

  constructor(
    private readonly maxFailures = 5,
    private readonly lockMs = 5 * 60 * 1000,
  ) {}

  check(): { ok: boolean; retryAfterSec: number } {
    if (Date.now() < this.lockedUntil) {
      return { ok: false, retryAfterSec: Math.ceil((this.lockedUntil - Date.now()) / 1000) }
    }
    return { ok: true, retryAfterSec: 0 }
  }

  onFailure(): void {
    this.failures += 1
    if (this.failures >= this.maxFailures) {
      this.lockedUntil = Date.now() + this.lockMs
      this.failures = 0
    }
  }

  onSuccess(): void {
    this.failures = 0
  }
}
