declare module 'pg-copy-streams' {
  import type { Writable } from 'node:stream';

  interface CopyStreamQuery extends Writable {
    readonly rowCount: number;
    submit(connection: unknown): void;
  }

  export function from(sql: string): CopyStreamQuery;
}
