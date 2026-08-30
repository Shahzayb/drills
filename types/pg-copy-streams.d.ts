// pg-copy-streams ships no types. Only `from` is used here, by db/seed.mts and
// db/search.mts, and only ever as the argument to `client.query()`.
declare module 'pg-copy-streams' {
  import type { Writable } from 'node:stream';

  /**
   * pg hands the socket to whatever `query()` is given, so this is both the
   * Writable the caller pipes into and the `Submittable` pg dispatches on —
   * `submit` is what makes `client.query(from(sql))` type-check.
   */
  interface CopyStreamQuery extends Writable {
    readonly rowCount: number;
    submit(connection: unknown): void;
  }

  export function from(sql: string): CopyStreamQuery;
}
