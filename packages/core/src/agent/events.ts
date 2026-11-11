import type { TokenUsage } from '../llm/types.js';

export type FinalState = 'ANSWERED' | 'INSUFFICIENT_EVIDENCE' | 'OUT_OF_SCOPE' | 'REFUSED';

export type GraphNode = 'route' | 'retrieve' | 'answer' | 'verify' | 'guard_out';

/** The server-sent events of one chat turn (ADR 0005). */
export type ChatEvent =
  | {
      event: 'meta';
      data: { requestId: string; conversationId: string; indexVersion: string };
    }
  | { event: 'status'; data: { node: GraphNode } }
  | { event: 'token'; data: { text: string } }
  | {
      event: 'citation';
      data: { citationId: string; title: string; excerpt: string; sourceUri: string };
    }
  | { event: 'reset'; data: { reason: string } }
  | {
      event: 'final';
      data: { state: FinalState; citationIds: string[]; usage: TokenUsage };
    }
  | { event: 'error'; data: { code: string; retryable: boolean } };
