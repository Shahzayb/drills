export const REQUEST_ID_HEADER = 'x-request-id';

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function deriveRequestId(raw: string | null | undefined): string {
  return raw && SAFE_REQUEST_ID.test(raw) ? raw : crypto.randomUUID();
}
