import { z } from 'zod';

/** The single embedding dimension supported in v1 (ADR 0006). */
export const EMBEDDING_DIMENSIONS = 1024;

export const ACCESS_MODES = ['public', 'authenticated', 'rbac'] as const;

/** How an instance identifies callers and which documents they may read (ADR 0003). */
export type AccessMode = (typeof ACCESS_MODES)[number];

const INSTANCE_ID = /^[a-z][a-z0-9-]{1,39}$/;
const ACCESS_TAG = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
// Role names come from token claims and become object keys, so a leading
// underscore is refused to keep names such as __proto__ out of the role map.
const ROLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
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
  if (value === '*') {
    ctx.addIssue({ code: 'custom', message: 'Wildcard origin "*" is not allowed' });
    return;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: `"${value}" is not a URL origin` });
    return;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== value) {
    ctx.addIssue({
      code: 'custom',
      message: `"${value}" must be an http(s) origin with no path or trailing slash`,
    });
  }
});

const personaSchema = z.strictObject({
  systemPrompt: nonEmpty,
  answerStyle: nonEmpty,
  outOfScope: nonEmpty,
  forbiddenTopics: z.array(nonEmpty).default([]),
});

const modelsSchema = z.strictObject({
  chat: nonEmpty,
  router: nonEmpty.optional(),
});

const embeddingSchema = z.strictObject({
  provider: z.enum(['voyage', 'ollama', 'fake']),
  model: nonEmpty,
  dimensions: z.literal(EMBEDDING_DIMENSIONS).default(EMBEDDING_DIMENSIONS),
});

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
    roles: z.record(z.string().regex(ROLE_NAME, 'Invalid role name'), z.array(permissionSchema)),
  }),
]);

const limitsSchema = z.strictObject({
  requestsPerMinutePerIp: z.int().positive().default(20),
  requestsPerMinutePerSession: z.int().positive().default(10),
  dailyTokensPerIp: z.int().positive().default(50_000),
  dailyTokensPerInstance: z.int().positive().default(1_000_000),
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
    maxTokens: z.int().positive().max(8000).default(800),
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
  models: modelsSchema,
  embedding: embeddingSchema,
  auth: authSchema,
  allowedOrigins: z.array(originSchema).min(1),
  limits: limitsSchema.prefault({}),
  theme: themeSchema.optional(),
  features: featuresSchema.prefault({}),
  sources: z.array(sourceSchema).min(1),
  chunking: chunkingSchema.prefault({}),
  evalSet: nonEmpty.optional(),
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
