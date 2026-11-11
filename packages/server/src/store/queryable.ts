import type { QueryResult, QueryResultRow } from 'pg';

/** The part of a `pg` client or pool the storage layer uses. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

/** A client checked out of a pool, as returned by `pg.Pool#connect`. */
export interface PooledClient extends Queryable {
  release(destroy?: boolean): void;
}
