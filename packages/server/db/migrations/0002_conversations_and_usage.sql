CREATE TABLE rag.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id text NOT NULL REFERENCES rag.instances (id),
  -- A hash of the session ID or token subject (ADR 0004); never the raw value.
  owner_key text NOT NULL CHECK (length(owner_key) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE (instance_id, owner_key, id)
);

CREATE INDEX conversations_owner ON rag.conversations (instance_id, owner_key, created_at);
CREATE INDEX conversations_expiry ON rag.conversations (expires_at);

CREATE TABLE rag.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id text NOT NULL,
  conversation_id uuid NOT NULL,
  -- Copied from the conversation so the owner policy needs no join.
  owner_key text NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (instance_id, owner_key, conversation_id)
    REFERENCES rag.conversations (instance_id, owner_key, id) ON DELETE CASCADE,
  UNIQUE (instance_id, owner_key, id)
);

CREATE INDEX messages_conversation ON rag.messages (conversation_id, created_at);

CREATE TABLE rag.feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id text NOT NULL,
  message_id uuid NOT NULL,
  -- Only the owner of a conversation can rate its messages or read those ratings.
  owner_key text NOT NULL,
  rating smallint NOT NULL CHECK (rating IN (-1, 1)),
  comment text NOT NULL DEFAULT '' CHECK (length(comment) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (instance_id, owner_key, message_id)
    REFERENCES rag.messages (instance_id, owner_key, id) ON DELETE CASCADE
);

CREATE INDEX feedback_message ON rag.feedback (instance_id, owner_key, message_id);

-- scope names the counter: the instance itself, a client IP prefix or a session (ADR 0004).
CREATE TABLE rag.usage_counters (
  instance_id text NOT NULL REFERENCES rag.instances (id),
  scope text NOT NULL CHECK (length(scope) BETWEEN 1 AND 200),
  day date NOT NULL,
  tokens bigint NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  requests bigint NOT NULL DEFAULT 0 CHECK (requests >= 0),
  PRIMARY KEY (instance_id, scope, day)
);

CREATE TABLE rag.usage_global (
  day date PRIMARY KEY,
  tokens bigint NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  requests bigint NOT NULL DEFAULT 0 CHECK (requests >= 0)
);
