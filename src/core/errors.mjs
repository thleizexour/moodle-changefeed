export class ChangefeedError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ChangefeedError";
    this.code = code;
    this.details = details;
  }
}

export function normalizeChangefeedError(
  error,
  { fallbackCode = "changefeed_operation_failed" } = {}
) {
  if (error instanceof ChangefeedError) return error;
  const message = String(error?.message || "Moodle changefeed operation failed");
  if (/版本冲突|version conflict/i.test(message)) {
    return new ChangefeedError("review_version_conflict", message);
  }
  if (/不存在|not found/i.test(message)) {
    return new ChangefeedError("review_not_found", message);
  }
  return new ChangefeedError(fallbackCode, message);
}
