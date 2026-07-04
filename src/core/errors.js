export class VeilError extends Error {
  constructor(code, message, status, details = []) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
