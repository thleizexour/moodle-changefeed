import { randomBytes } from "node:crypto";

import { sha256Hex } from "./contracts.mjs";
import { ChangefeedError } from "./errors.mjs";

export class MemoryConfirmationProvider {
  constructor({ clock = () => Date.now() } = {}) {
    this.clock = clock;
    this.records = new Map();
  }

  issue({ binding, expiresAt }) {
    if (typeof binding !== "string" || binding.length < 32) {
      throw new TypeError("confirmation binding is required");
    }
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.clock()) {
      throw new TypeError("confirmation expiry must be in the future");
    }
    const token = randomBytes(32).toString("base64url");
    this.records.set(sha256Hex(token), {
      binding,
      expiresAt,
      consumed: false
    });
    return token;
  }

  async consume({ token, binding }) {
    const record = this.records.get(sha256Hex(token || ""));
    if (
      !record ||
      record.consumed ||
      record.binding !== binding ||
      record.expiresAt < this.clock()
    ) {
      throw new ChangefeedError(
        "confirmation_invalid",
        "Confirmation is invalid, expired, or already used"
      );
    }
    record.consumed = true;
    return { consumedAt: this.clock() };
  }
}
