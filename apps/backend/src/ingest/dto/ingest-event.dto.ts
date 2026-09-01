import { IsIn, IsOptional, Length, Matches } from 'class-validator';

// Eight characters is a floor against a caller sending `1` as its event id and
// colliding with itself. The ceiling keeps a megabyte of text out of a btree
// index key — Postgres refuses an index entry past ~2,700 bytes, and the error
// arrives at INSERT time on one unlucky event rather than at deploy time.
export const MIN_EVENT_ID_LENGTH = 8;
export const MAX_EVENT_ID_LENGTH = 200;

export const MAX_MESSAGE_LENGTH = 10_000;

/**
 * What a provider POSTs to `/ingest`.
 *
 * `eventId` is the idempotency key, and it is charset-allowlisted rather than
 * merely length-checked because it lands in two places with different rules: a
 * unique index in Postgres, which does not care, and a **Redis key**, which is
 * a flat namespace with no escaping. `idem:{org}:{eventId}` with a newline or a
 * space in it is still a legal Redis key, so nothing would break loudly — it
 * would just be a different key than the one the next delivery computes, and
 * the guard would silently stop guarding.
 *
 * The org is deliberately absent. It comes from the API key, which is the whole
 * point of this route — see ingest.controller.ts.
 */
export class IngestEventDto {
  @Length(MIN_EVENT_ID_LENGTH, MAX_EVENT_ID_LENGTH)
  @Matches(/^[A-Za-z0-9._:-]+$/, {
    message: 'eventId may contain only letters, digits and . _ : -',
  })
  eventId!: string;

  @Length(1, MAX_MESSAGE_LENGTH)
  message!: string;

  // Optional with a default, unlike `q` on the search DTO: a webhook that does
  // not say is 'open', which is the only sensible reading. `@IsOptional` is
  // what stops the validator rejecting an absent value before the default
  // applies.
  @IsOptional()
  @IsIn(['open', 'closed'])
  status: 'open' | 'closed' = 'open';
}
