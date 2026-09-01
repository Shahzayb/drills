import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Request } from 'express';
import { PostgresService } from '../postgres/postgres.service';

/** Where the resolved org is parked for the decorator to read. A symbol, not a
 *  string key: nothing else can collide with it and no middleware can set it by
 *  accident. */
export const API_KEY_ORG = Symbol('apiKeyOrg');

/** `dk_` so a leaked key is greppable in a log aggregator and recognisable in a
 *  screenshot. The prefix is part of the secret, not a lookup column. */
export const API_KEY_PREFIX = 'dk_';

export const hashApiKey = (key: string): string =>
  createHash('sha256').update(key).digest('hex');

/**
 * Authentication for `POST /ingest`, and the one place in this repo that runs a
 * query outside a tenant scope.
 *
 * That is not a shortcut, it is the shape of the problem. Drill 07's mechanism
 * needs `app.org_id` set before a policy admits any row, and this is the lookup
 * that decides what `app.org_id` should be. It cannot run inside the scope it
 * exists to establish.
 *
 * So it does not try. `app_org_for_api_key()` (migration 1788134400000) is
 * SECURITY DEFINER, runs as the table owner, and returns a bigint — the serving
 * role never gains SELECT on `api_keys`, so this path cannot enumerate keys even
 * if it wanted to. Everything downstream of here goes through `TenantDb.withOrg`
 * like every other route.
 *
 * A guard rather than a param decorator: this is authentication, so it belongs
 * where a 401 happens before the handler body exists. Applied per controller,
 * not globally — every other route keeps the `X-Org-Id` stub.
 *
 * Not constant-time, and that is fine: the lookup is a btree probe on a sha256
 * of the presented key, not a comparison against a stored secret. There is no
 * prefix to walk.
 *
 * See plans/2026-08-31_drill-12-idempotent-ingest.md.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly postgres: PostgresService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.header('authorization') ?? '';

    // Case-insensitive on the scheme, because clients disagree about it and a
    // 401 that depends on capitalisation is a support ticket.
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (!match) {
      throw new UnauthorizedException(
        'Authorization: Bearer <api key> is required',
      );
    }

    const { rows } = await this.postgres.query<{ org_id: string | null }>(
      `SELECT app_org_for_api_key($1) AS org_id`,
      [hashApiKey(match[1])],
    );

    // NULL covers all three of "no such key", "revoked" and "belongs to an org
    // that no longer exists". The caller gets one answer for all of them: a
    // response that distinguishes them is an oracle for guessing keys.
    const orgId = rows[0]?.org_id;
    if (!orgId) throw new UnauthorizedException('invalid api key');

    (request as Request & { [API_KEY_ORG]?: string })[API_KEY_ORG] = orgId;
    return true;
  }
}
