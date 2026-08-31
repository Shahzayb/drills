import { headers } from 'next/headers';
import { REQUEST_ID_HEADER, deriveRequestId } from './request-id';

export async function getRequestId(): Promise<string> {
  return deriveRequestId((await headers()).get(REQUEST_ID_HEADER));
}
