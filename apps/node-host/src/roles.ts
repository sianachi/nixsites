export const ROLES = ['collab', 'companion', 'sites-worker'] as const;
export type Role = (typeof ROLES)[number];

/** `collab,companion`; empty or unset means every role. An unknown or repeated role throws. */
export function parseRoles(value: string | undefined): Role[] {
  const names = (value ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  if (names.length === 0) return [...ROLES];
  const roles: Role[] = [];
  for (const name of names) {
    const role = ROLES.find((known) => known === name);
    if (role === undefined)
      throw new Error(`Unknown NIX_NODE_ROLES entry '${name}'; use ${ROLES.join(', ')}.`);
    if (!roles.includes(role)) roles.push(role);
  }
  return roles;
}
