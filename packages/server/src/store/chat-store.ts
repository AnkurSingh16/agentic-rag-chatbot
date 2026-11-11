import { ChatbotError, toChatbotError } from '@agentic-rag/core';
import type { ChatMessage } from '@agentic-rag/core';
import type { PooledClient } from './queryable.js';
import { withInstanceTransaction } from './transaction.js';

/** Who owns a conversation; RLS on conversations and messages filters on it (ADR 0004). */
export interface OwnerAccess {
  instanceId: string;
  ownerKey: string;
}

export interface OpenedConversation {
  conversationId: string;
  /** Earlier turns, oldest first. */
  history: ChatMessage[];
  /** User messages the owner has sent on this instance, across all of their conversations. */
  turns: number;
}

export interface UsageTotals {
  /** `null` for the global counter. */
  scope: string | null;
  tokens: number;
  requests: number;
}

/** Conversation and usage storage for the chat route. */
export interface ChatStore {
  /**
   * Loads the owner's conversation, or creates one when `conversationId` is undefined. An ID the
   * owner does not hold, or one that expired, is `not_found`.
   */
  openConversation(access: OwnerAccess, conversationId?: string): Promise<OpenedConversation>;
  appendTurn(
    access: OwnerAccess,
    conversationId: string,
    user: string,
    assistant: string,
  ): Promise<void>;
  /** Adds to the daily counters of `scopes` through `rag.consume_usage` and returns the totals. */
  consumeUsage(
    instanceId: string,
    scopes: readonly string[],
    delta: { tokens: number; requests: number },
  ): Promise<UsageTotals[]>;
}

// Conversations live as long as the session that owns them.
const CONVERSATION_LIFETIME = '1 day';
// Earlier turns sent to the model; older ones are dropped to bound input tokens.
const HISTORY_MESSAGES = 6;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sqlState(error: unknown): string | undefined {
  const cause = error instanceof ChatbotError ? error.cause : error;
  return typeof cause === 'object' && cause !== null && 'code' in cause
    ? String(cause.code)
    : undefined;
}

/** The PostgreSQL implementation of {@link ChatStore}. `pool` must log in as `rag_runtime`. */
export function createPostgresChatStore(pool: { connect(): Promise<PooledClient> }): ChatStore {
  function asOwner<T>(access: OwnerAccess, fn: (client: PooledClient) => Promise<T>) {
    return withInstanceTransaction(
      pool,
      { instanceId: access.instanceId, tenantKey: '_', accessTags: [], ownerKey: access.ownerKey },
      fn,
    );
  }

  return {
    openConversation: (access, conversationId) =>
      asOwner(access, async (client) => {
        const turns = await client.query<{ turns: number }>(
          `SELECT count(*)::int AS turns FROM rag.messages
           WHERE instance_id = $1 AND owner_key = $2 AND role = 'user'`,
          [access.instanceId, access.ownerKey],
        );
        const turnCount = turns.rows[0]?.turns ?? 0;
        if (conversationId === undefined) {
          const created = await client.query<{ id: string }>(
            `INSERT INTO rag.conversations (instance_id, owner_key, expires_at)
             VALUES ($1, $2, now() + $3::interval) RETURNING id`,
            [access.instanceId, access.ownerKey, CONVERSATION_LIFETIME],
          );
          const id = created.rows[0]?.id;
          if (id === undefined) throw new ChatbotError('internal', 'Conversation was not created');
          return { conversationId: id, history: [], turns: turnCount };
        }
        const notFound = new ChatbotError('not_found', 'Conversation not found');
        if (!UUID.test(conversationId)) throw notFound;
        const found = await client.query(
          `SELECT 1 FROM rag.conversations
           WHERE instance_id = $1 AND owner_key = $2 AND id = $3 AND expires_at > now()`,
          [access.instanceId, access.ownerKey, conversationId],
        );
        if (found.rowCount !== 1) throw notFound;
        const messages = await client.query<{ role: 'user' | 'assistant'; content: string }>(
          `SELECT role, content FROM (
             SELECT role, content, created_at, id FROM rag.messages
             WHERE instance_id = $1 AND owner_key = $2 AND conversation_id = $3
             ORDER BY created_at DESC, id DESC LIMIT $4
           ) recent ORDER BY created_at, id`,
          [access.instanceId, access.ownerKey, conversationId, HISTORY_MESSAGES],
        );
        // The model API needs the history to start with a user turn.
        const history = messages.rows.map((row) => ({ role: row.role, content: row.content }));
        while (history[0]?.role === 'assistant') history.shift();
        return { conversationId, history, turns: turnCount };
      }),

    appendTurn: (access, conversationId, user, assistant) =>
      asOwner(access, async (client) => {
        // now() is fixed for the whole transaction, so clock_timestamp() gives the user message
        // the earlier created_at that history ordering relies on.
        for (const [role, content] of [
          ['user', user],
          ['assistant', assistant],
        ] as const) {
          await client.query(
            `INSERT INTO rag.messages (instance_id, conversation_id, owner_key, role, content, created_at)
             VALUES ($1, $2, $3, $4, $5, clock_timestamp())`,
            [access.instanceId, conversationId, access.ownerKey, role, content],
          );
        }
      }),

    consumeUsage: async (instanceId, scopes, delta) => {
      try {
        return await withInstanceTransaction(
          pool,
          { instanceId, tenantKey: '_', accessTags: [] },
          async (client) => {
            const result = await client.query<{
              counter_scope: string | null;
              total_tokens: string;
              total_requests: string;
            }>('SELECT * FROM rag.consume_usage($1::text[], $2, $3)', [
              [...scopes],
              delta.tokens,
              delta.requests,
            ]);
            return result.rows.map((row) => ({
              scope: row.counter_scope,
              tokens: Number(row.total_tokens),
              requests: Number(row.total_requests),
            }));
          },
        );
      } catch (error) {
        // usage_counters references rag.instances, whose row is created by the first training.
        if (sqlState(error) === '23503') {
          throw new ChatbotError('not_found', `Instance "${instanceId}" has not been trained`, {
            cause: error,
          });
        }
        throw toChatbotError(error);
      }
    },
  };
}
