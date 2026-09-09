import type { SapClient } from "../sap/client.js";
import { TimesheetError } from "./types.js";

/**
 * The Multiproject app takes an exclusive CATS lock for the user while editing
 * (ZB_LOCK_SRV: CatsLock / CatsRelock every 60 s / CatsUnlock).
 */
export class LockService {
  static readonly SERVICE = "/sap/opu/odata/sap/ZB_LOCK_SRV/";
  constructor(private readonly client: SapClient) {}

  async lock(): Promise<void> {
    const res = await this.client.getJson<{ d?: { LockObject?: string } }>(`${LockService.SERVICE}CatsLock`);
    if (res?.d?.LockObject !== "X") {
      throw new TimesheetError("The timesheet is currently locked by another session (open in the Fiori app?). Close it and retry.");
    }
  }

  async relock(): Promise<void> {
    await this.client.getJson(`${LockService.SERVICE}CatsRelock`);
  }

  async unlock(): Promise<void> {
    await this.client.getJson(`${LockService.SERVICE}CatsUnlock`).catch(() => {});
  }

  /** Runs `fn` while holding the lock; always unlocks. */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.lock();
    try {
      return await fn();
    } finally {
      await this.unlock();
    }
  }
}
