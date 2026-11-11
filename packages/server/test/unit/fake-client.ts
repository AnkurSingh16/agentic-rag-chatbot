import type { QueryResult, QueryResultRow } from 'pg';

export interface RecordedQuery {
  text: string;
  values: unknown[] | undefined;
}

export type Responder = (text: string, values: unknown[] | undefined) => QueryResultRow[] | Error;

// A scripted stand-in for a pg client: each query is recorded and answered by `respond`.
export class FakeClient {
  readonly calls: RecordedQuery[] = [];
  readonly released: (boolean | undefined)[] = [];

  constructor(private readonly respond: Responder = () => []) {}

  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>> {
    this.calls.push({ text, values });
    const answer = this.respond(text, values);
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve({
      rows: answer as R[],
      rowCount: answer.length,
      command: '',
      oid: 0,
      fields: [],
    });
  }

  release(destroy?: boolean): void {
    this.released.push(destroy);
  }

  texts(): string[] {
    return this.calls.map((call) => call.text);
  }
}
