import type { InstanceConfig, Permission } from '../config/schema.js';

/**
 * Who is asking and what they may read, derived by the server from verified
 * identity only (ADR 0003). Nothing in a request body or URL contributes to it.
 */
export interface AccessContext {
  instanceId: string;
  /** Matched by equality in row-level security; `_` unless a consumer supplies one. */
  tenantKey: string;
  subject: string;
  permissions: readonly Permission[];
  /** Matched by overlap against each document's access tags in row-level security. */
  accessTags: readonly string[];
}

const DOCS_READ_PREFIX = 'docs:read:';

function sortedUnique<T extends string>(values: Iterable<T>): T[] {
  return [...new Set(values)].sort();
}

/**
 * Permissions granted to a caller. In `public` and `authenticated` mode every
 * caller may chat; in `rbac` mode permissions come from the role map, and
 * roles the map does not define grant nothing.
 */
export function resolvePermissions(
  config: Pick<InstanceConfig, 'auth'>,
  roles: readonly string[],
): Permission[] {
  const { auth } = config;
  if (auth.mode !== 'rbac') return ['chat:use'];
  // Roles come from a token claim, so only the map's own keys count: a role
  // named "constructor" must not resolve to an inherited property.
  return sortedUnique(
    roles.flatMap((role) => (Object.hasOwn(auth.roles, role) ? (auth.roles[role] ?? []) : [])),
  );
}

/** Access tags for row-level security, per the mode table in ADR 0003. */
export function resolveAccessTags(
  config: Pick<InstanceConfig, 'auth'>,
  roles: readonly string[],
): string[] {
  const { auth } = config;
  switch (auth.mode) {
    case 'public':
      return ['public'];
    case 'authenticated':
      return sortedUnique(auth.defaultTags);
    case 'rbac':
      return sortedUnique(
        resolvePermissions(config, roles)
          .filter((permission) => permission.startsWith(DOCS_READ_PREFIX))
          .map((permission) => permission.slice(DOCS_READ_PREFIX.length)),
      );
  }
}

export function hasPermission(
  access: Pick<AccessContext, 'permissions'>,
  permission: Permission,
): boolean {
  return access.permissions.includes(permission);
}
