/**
 * Token-scope classification for the public API reference.
 *
 * This follows Nix.Authentication.AccessTokenScopePolicy. Routes that never
 * enter that middleware (health, token exchange, public forms) are named
 * here so the reference does not call them ordinary writes.
 */

/**
 * @param {string} method
 * @param {string} path OpenAPI path template.
 * @returns {'read' | 'write' | 'admin' | 'interactive' | 'public'}
 */
export function tokenScope(method, path) {
  if (path === '/healthz' || path.startsWith('/api/v1/health/') || path === '/api/v1/health') {
    return 'public';
  }
  if (path === '/public/v1/auth/token' || path === '/public/v1/auth/jwks') {
    return 'public';
  }
  if (path.startsWith('/public/v1/forms/')) {
    return 'public';
  }
  return classify(method, path);
}

/**
 * @param {'read' | 'write' | 'admin' | 'interactive' | 'public'} scope
 * @returns {string}
 */
export function scopeSentence(scope) {
  switch (scope) {
    case 'public':
      return 'No personal access token. Health, token exchange, signing keys, and public forms do not use a bearer session.';
    case 'read':
      return 'Requires a personal access token with the read scope, or an interactive session. A scope never grants more than the person who minted the token can already do, and read, write, and admin are independent.';
    case 'write':
      return 'Requires a personal access token with the write scope, or an interactive session. Holding write does not imply read.';
    case 'admin':
      return 'Requires a personal access token with the admin scope, or an interactive session. Admin covers sharing, membership, automations, sites, and moving an item.';
    case 'interactive':
      return 'A personal access token cannot call this. Only an interactive browser session can.';
    default:
      return scope;
  }
}

/**
 * @param {string} method
 * @param {string} path
 * @returns {'read' | 'write' | 'admin' | 'interactive'}
 */
export function classify(method, path) {
  const verb = method.toUpperCase();
  const lowerPath = path.toLowerCase();

  if (
    startsWithSegment(lowerPath, '/api/v1/me/tokens') ||
    startsWithSegment(lowerPath, '/api/v1/me/pets/runtime') ||
    startsWithSegment(lowerPath, '/api/v1/me/pets/connection') ||
    startsWithSegment(lowerPath, '/api/v1/me/pets/inline') ||
    (startsWithSegment(lowerPath, '/api/v1/conversations') &&
      trimSlash(lowerPath).endsWith('/turns'))
  ) {
    return 'interactive';
  }

  const value = trimSlash(lowerPath);

  if (
    !isRead(verb) &&
    (startsWithSegment(lowerPath, '/api/v1/me/preferences') ||
      startsWithSegment(lowerPath, '/api/v1/me/pets/providers') ||
      startsWithSegment(lowerPath, '/api/v1/me/workspace-arrangement') ||
      startsWithSegment(lowerPath, '/api/v1/me/ui-settings') ||
      startsWithSegment(lowerPath, '/api/v1/me/push-subscriptions'))
  ) {
    return 'interactive';
  }

  if (!isRead(verb) && startsWithSegment(lowerPath, '/api/v1/me/calendar/connections')) {
    return 'interactive';
  }

  if (!isRead(verb) && startsWithSegment(lowerPath, '/api/v1/me/calendar/links')) {
    return value.endsWith('/sync') ? 'write' : 'admin';
  }

  if (value.includes('/public-link') || value.endsWith('/move') || value.endsWith('/invitees')) {
    return 'admin';
  }

  if (isRead(verb)) {
    return 'read';
  }

  if (verb === 'POST' && value === '/api/v1/search/mentions') {
    return 'read';
  }

  if (verb === 'POST' && isWorkspaceQueryPath(value)) {
    return 'read';
  }

  if (
    value.includes('/members') ||
    value.includes('/invitations') ||
    value.endsWith('/leave') ||
    value.endsWith('/recover') ||
    (value.startsWith('/api/v1/workspaces/') &&
      (value.endsWith('/archive') || value.endsWith('/restore'))) ||
    (verb === 'DELETE' && value.startsWith('/api/v1/workspaces/')) ||
    value.includes('/automations') ||
    startsWithSegment(value, '/api/v1/sites') ||
    startsWithSegment(value, '/api/v1/tenant/admins')
  ) {
    return 'admin';
  }

  if (value.includes('/permissions')) {
    return 'admin';
  }

  return 'write';
}

/**
 * @param {string} method
 */
function isRead(method) {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

/**
 * @param {string} path
 * @param {string} prefix
 */
function startsWithSegment(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * @param {string} path
 */
function trimSlash(path) {
  return path.replace(/\/+$/, '');
}

/**
 * @param {string} value trimmed, lowercased path
 */
function isWorkspaceQueryPath(value) {
  const prefix = '/api/v1/workspaces/';
  if (!value.startsWith(prefix)) {
    return false;
  }
  const rest = value.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) {
    return false;
  }
  const tail = rest.slice(slash + 1);
  return tail === 'query' || tail === 'query/aggregate';
}
