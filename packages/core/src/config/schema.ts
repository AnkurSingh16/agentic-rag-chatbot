import { z } from 'zod';

/** The single embedding dimension, matching all-MiniLM-L6-v2 (ADR 0008). */
export const EMBEDDING_DIMENSIONS = 384;

export const ACCESS_MODES = ['public', 'authenticated', 'rbac'] as const;

/** How an instance identifies callers and which documents they may read (ADR 0003). */
export type AccessMode = (typeof ACCESS_MODES)[number];

const INSTANCE_ID = /^[a-z][a-z0-9-]{1,39}$/;
const ACCESS_TAG = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const ROLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
// Role names are matched against token claims by object key. Zod silently
// drops a "__proto__" key from records, so these names are checked on the raw
// object and rejected with an error instead of disappearing or shadowing
// inherited properties.
const RESERVED_ROLE_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);
const POLICY_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const GITHUB_REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
// Theme values are injected into client CSS, so only plain hex colours and
// simple lengths are accepted rather than arbitrary CSS.
const HEX_COLOUR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const CSS_LENGTH = /^\d{1,3}(?:\.\d{1,2})?(?:px|rem|em)$/;

const nonEmpty = z.string().trim().min(1);
const accessTag = z.string().regex(ACCESS_TAG, 'Must be a lower-case access tag');
const httpUrl = z.url({ protocol: /^https?$/ });
const issuerUrl = z.url({ protocol: /^https$/ });

const permissionSchema = z.union([
  z.enum(['chat:use', 'instance:train', 'instance:admin', 'analytics:read']),
  z.templateLiteral(['docs:read:', accessTag]),
]);

/** A capability granted to a caller; `docs:read:<tag>` grants read access to documents with that tag. */
export type Permission = z.infer<typeof permissionSchema>;

const originSchema = z.string().superRefine((value, ctx) => {
  if (value.includes('*')) {
    ctx.addIssue({ code: 'custom', message: `Wildcards are not allowed in origin "${value}"` });
    return;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: `"${value}" is not a URL origin` });
    return;
  }
  const loopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (!(url.protocol === 'https:' || loopbackHttp)) {
    ctx.addIssue({
      code: 'custom',
      message: `"${value}" must use https; http is allowed only for localhost, 127.0.0.1 and [::1]`,
    });
    return;
  }
  if (url.origin !== value) {
    ctx.addIssue({
      code: 'custom',
      message: `"${value}" must be an origin with no path or trailing slash`,
    });
  }
});

const roleMapSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    if (typeof value !== 'object' || value === null) return;
    for (const key of Object.keys(value)) {
      if (RESERVED_ROLE_NAMES.has(key)) {
        ctx.addIssue({ code: 'custom', path: [key], message: `Reserved role name "${key}"` });
      }
    }
  })
  .pipe(z.record(z.string().regex(ROLE_NAME, 'Invalid role name'), z.array(permissionSchema)));

/** The house style used when an instance sets no `persona.styleGuide`. */
export const DEFAULT_STYLE_GUIDE =
  'Be friendly and plain-spoken. Use plain English, short paragraphs and the first person ("I" for the assistant).';

const httpsUrl = z.url({ protocol: /^https$/ });

const exampleSchema = z.strictObject({
  question: nonEmpty.max(300),
  answer: nonEmpty.max(800),
});

// The fallback is what the visitor sees when the documents do not answer, a question is out of
// scope or an answer is blocked (ADR 0005, docs/reference/instance-config.md).
const fallbackSchema = z.strictObject({
  message: nonEmpty.max(1000),
  suggestedTopics: z.array(nonEmpty.max(200)).max(3).default([]),
  handoff: z.strictObject({ url: httpsUrl, label: nonEmpty.max(60) }).optional(),
});

// Persona text goes into every model call; these caps keep the instructions within the
// per-call input budget of the agent graph (ADR 0005).
const personaSchema = z.strictObject({
  systemPrompt: nonEmpty.max(4000),
  answerStyle: nonEmpty.max(1000),
  styleGuide: nonEmpty.max(1000).optional(),
  examples: z.array(exampleSchema).max(3).default([]),
  fallback: fallbackSchema,
  forbiddenTopics: z.array(nonEmpty.max(200)).max(50).default([]),
});

const verificationSchema = z.strictObject({
  /**
   * Asks the chat model whether each paragraph states only what its cited chunks say, before the
   * paragraph is released. One extra model call per paragraph; off by default (ADR 0005).
   */
  judge: z.boolean().default(false),
});

const evaluationSchema = z.strictObject({
  /**
   * Share of unanswerable eval questions that must retrieve nothing above the minimum score for
   * `ragctl eval` to pass. The default requires all of them.
   */
  minUnanswerableEmptyRate: z.number().min(0).max(1).default(1),
});

// Both optional: the server falls back to LLM_MODEL, then to the platform default (ADR 0008).
const modelsSchema = z.strictObject({
  chat: nonEmpty.optional(),
  router: nonEmpty.optional(),
});

export const EMBEDDING_PROVIDERS = ['local', 'mock'] as const;

/** The model each embedding provider uses when the config names none (ADR 0008). */
export const DEFAULT_EMBEDDING_MODELS: Readonly<
  Record<(typeof EMBEDDING_PROVIDERS)[number], string>
> = {
  local: 'Xenova/all-MiniLM-L6-v2',
  mock: 'mock-hash-v1',
};

const embeddingSchema = z
  .strictObject({
    provider: z.enum(EMBEDDING_PROVIDERS).default('local'),
    model: nonEmpty.optional(),
    dimensions: z.literal(EMBEDDING_DIMENSIONS).default(EMBEDDING_DIMENSIONS),
  })
  .transform((value) => ({
    ...value,
    model: value.model ?? DEFAULT_EMBEDDING_MODELS[value.provider],
  }));

// Auth variants strip unknown keys instead of rejecting them, so one block can
// hold the fields for several modes and an environment override of `mode`
// (see loadInstanceConfig) can switch between them.
const authSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('public') }),
  z.object({
    mode: z.literal('authenticated'),
    issuer: issuerUrl,
    audience: nonEmpty,
    defaultTags: z.array(accessTag).min(1),
  }),
  z.object({
    mode: z.literal('rbac'),
    issuer: issuerUrl,
    audience: nonEmpty,
    roleClaim: nonEmpty,
    roles: roleMapSchema,
  }),
]);

// Every limit fails closed (ADR 0008). Caps keep a typo from configuring an unbounded spend.
const limitsSchema = z.strictObject({
  maxOutputTokens: z.int().min(64).max(4096).default(512),
  maxTurnsPerSession: z.int().positive().max(1000).default(20),
  requestsPerMinutePerIp: z.int().positive().max(1000).default(20),
  dailyRequests: z.int().positive().max(1_000_000).default(500),
  dailyRequestsPerIp: z.int().positive().max(1_000_000).default(100),
});

const themeSchema = z.strictObject({
  primaryColor: z.string().regex(HEX_COLOUR, 'Must be a hex colour').optional(),
  backgroundColor: z.string().regex(HEX_COLOUR, 'Must be a hex colour').optional(),
  textColor: z.string().regex(HEX_COLOUR, 'Must be a hex colour').optional(),
  borderRadius: z.string().regex(CSS_LENGTH, 'Must be a length in px, rem or em').optional(),
});

const featuresSchema = z.strictObject({
  adminApi: z.boolean().default(false),
});

const sourceSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('folder'), path: nonEmpty }),
  z.strictObject({ type: z.literal('urls'), urls: z.array(httpUrl).min(1) }),
  z.strictObject({ type: z.literal('sitemap'), url: httpUrl }),
  z.strictObject({
    type: z.literal('github'),
    repo: z.string().regex(GITHUB_REPO, 'Must be "owner/name"'),
    path: nonEmpty,
    ref: nonEmpty.default('main'),
  }),
]);

/** Chunk sizes in estimated tokens (characters / 4); defaults from ADR 0006. */
export const chunkingSchema = z
  .strictObject({
    targetTokens: z.int().positive().default(450),
    overlapTokens: z.int().nonnegative().default(60),
    minTokens: z.int().nonnegative().default(50),
    // The chunker prepends up to 200 characters of heading path; 100 tokens
    // (400 characters) leaves room for text under it.
    maxTokens: z.int().min(100).max(8000).default(800),
  })
  .superRefine((value, ctx) => {
    if (value.targetTokens > value.maxTokens) {
      ctx.addIssue({
        code: 'custom',
        path: ['targetTokens'],
        message: 'Must not exceed maxTokens',
      });
    }
    if (value.minTokens >= value.targetTokens) {
      ctx.addIssue({ code: 'custom', path: ['minTokens'], message: 'Must be below targetTokens' });
    }
    if (value.overlapTokens >= value.targetTokens) {
      ctx.addIssue({
        code: 'custom',
        path: ['overlapTokens'],
        message: 'Must be below targetTokens',
      });
    }
  });

/** Schema for `instances/<id>/instance.yaml` (ADR 0002). Unknown keys are rejected. */
export const instanceConfigSchema = z.strictObject({
  id: z.string().regex(INSTANCE_ID, 'Must match ^[a-z][a-z0-9-]{1,39}$'),
  displayName: nonEmpty,
  persona: personaSchema,
  models: modelsSchema.prefault({}),
  embedding: embeddingSchema.prefault({}),
  auth: authSchema,
  allowedOrigins: z.array(originSchema).min(1),
  limits: limitsSchema.prefault({}),
  theme: themeSchema.optional(),
  features: featuresSchema.prefault({}),
  sources: z.array(sourceSchema).min(1),
  chunking: chunkingSchema.prefault({}),
  evalSet: nonEmpty.optional(),
  evaluation: evaluationSchema.prefault({}),
  verification: verificationSchema.prefault({}),
  requiredPolicies: z.array(z.string().regex(POLICY_NAME, 'Invalid policy name')).optional(),
});

/** A validated instance configuration with defaults applied. */
export type InstanceConfig = z.infer<typeof instanceConfigSchema>;
/** The shape accepted before defaults are applied, as written in YAML. */
export type InstanceConfigInput = z.input<typeof instanceConfigSchema>;
export type AuthConfig = InstanceConfig['auth'];
export type EmbeddingConfig = InstanceConfig['embedding'];
export type EmbeddingProviderName = EmbeddingConfig['provider'];
export type LimitsConfig = InstanceConfig['limits'];
export type SourceConfig = InstanceConfig['sources'][number];
export type ChunkingConfig = z.infer<typeof chunkingSchema>;
export type PersonaConfig = InstanceConfig['persona'];
export type FallbackConfig = PersonaConfig['fallback'];
