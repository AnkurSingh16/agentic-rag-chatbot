import { describe, expect, it } from 'vitest';
import { hasPermission, resolveAccessTags, resolvePermissions } from '../src/access/access.js';
import type { AuthConfig } from '../src/config/schema.js';

const publicConfig = { auth: { mode: 'public' } satisfies AuthConfig };

const authenticatedConfig = {
  auth: {
    mode: 'authenticated',
    issuer: 'https://issuer.example.com/',
    audience: 'chatbot',
    defaultTags: ['members', 'faq', 'members'],
  } satisfies AuthConfig,
};

const rbacConfig = {
  auth: {
    mode: 'rbac',
    issuer: 'https://issuer.example.com/',
    audience: 'chatbot',
    roleClaim: 'roles',
    roles: {
      staff: ['chat:use', 'docs:read:internal', 'docs:read:faq'],
      viewer: ['chat:use', 'docs:read:faq'],
      trainer: ['instance:train'],
    },
  } satisfies AuthConfig,
};

describe('resolveAccessTags', () => {
  it('gives public callers only the public tag, whatever roles they claim', () => {
    expect(resolveAccessTags(publicConfig, ['staff'])).toEqual(['public']);
  });

  it('gives authenticated callers the instance default tags', () => {
    expect(resolveAccessTags(authenticatedConfig, [])).toEqual(['faq', 'members']);
  });

  it('maps rbac roles to the tags of their docs:read permissions', () => {
    expect(resolveAccessTags(rbacConfig, ['viewer'])).toEqual(['faq']);
    expect(resolveAccessTags(rbacConfig, ['staff', 'viewer'])).toEqual(['faq', 'internal']);
  });

  it('gives no tags for roles without docs:read or roles the map does not define', () => {
    expect(resolveAccessTags(rbacConfig, ['trainer'])).toEqual([]);
    expect(resolveAccessTags(rbacConfig, ['admin'])).toEqual([]);
    expect(resolveAccessTags(rbacConfig, [])).toEqual([]);
  });

  it('does not resolve role names that match inherited object properties', () => {
    const roles = ['constructor', 'toString', '__proto__', 'hasOwnProperty'];
    expect(resolveAccessTags(rbacConfig, roles)).toEqual([]);
    expect(resolvePermissions(rbacConfig, roles)).toEqual([]);
  });
});

describe('resolvePermissions', () => {
  it('lets every caller chat in public and authenticated mode', () => {
    expect(resolvePermissions(publicConfig, ['staff'])).toEqual(['chat:use']);
    expect(resolvePermissions(authenticatedConfig, [])).toEqual(['chat:use']);
  });

  it('combines permissions of every rbac role without duplicates', () => {
    expect(resolvePermissions(rbacConfig, ['viewer', 'trainer', 'viewer'])).toEqual([
      'chat:use',
      'docs:read:faq',
      'instance:train',
    ]);
  });
});

describe('hasPermission', () => {
  it('checks for an exact permission', () => {
    const access = { permissions: resolvePermissions(rbacConfig, ['viewer']) };
    expect(hasPermission(access, 'chat:use')).toBe(true);
    expect(hasPermission(access, 'docs:read:faq')).toBe(true);
    expect(hasPermission(access, 'docs:read:internal')).toBe(false);
    expect(hasPermission(access, 'instance:admin')).toBe(false);
  });
});
