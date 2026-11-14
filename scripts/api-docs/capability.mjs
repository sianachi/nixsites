/**
 * What each public operation can change, stated from the route rather than
 * from a guess about a future body-edit API.
 *
 * No operation in the published document replaces a note, canvas, or
 * spreadsheet body. Those bodies are served by the collaboration service.
 */

/**
 * @param {string} method
 * @param {string} path
 * @returns {{ can: string, cannot: string }}
 */
export function capability(method, path) {
  const verb = method.toUpperCase();
  const specific = specificCapability(verb, path);
  if (specific !== null) {
    return specific;
  }

  if (verb === 'GET' || verb === 'HEAD' || verb === 'OPTIONS') {
    return {
      can: 'Read the resource named in the summary.',
      cannot:
        'Create, update, or delete stored data. It does not read or replace a note, canvas, or spreadsheet body.',
    };
  }

  if (isReadShapedPost(verb, path)) {
    return {
      can: 'Read. The call is a POST because the input does not fit in a URL.',
      cannot: 'Change stored data, including a note, canvas, or spreadsheet body.',
    };
  }

  if (verb === 'DELETE') {
    return {
      can: 'Delete or revoke what the summary names.',
      cannot:
        'Edit a note, canvas, or spreadsheet body, and it does not change resources the summary does not name.',
    };
  }

  return {
    can: 'Write what the summary names.',
    cannot:
      'Replace a note, canvas, or spreadsheet body. Moving an item, sharing it, and editing its body are separate operations, and no REST route edits a note body yet.',
  };
}

/**
 * @param {string} verb
 * @param {string} path
 * @returns {{ can: string, cannot: string } | null}
 */
function specificCapability(verb, path) {
  if (path === '/public/v1/auth/token' && verb === 'POST') {
    return {
      can: 'Exchange a personal access token for a short-lived bearer JWT.',
      cannot:
        'Create, list, or revoke personal access tokens, and it does not change workspace data. Revoking the personal access token still takes effect on the next request that presents an exchanged JWT.',
    };
  }

  if (path === '/public/v1/auth/jwks' && verb === 'GET') {
    return {
      can: 'Read the public signing keys for exchanged sessions.',
      cannot: 'Change keys, mint a session, or read workspace data.',
    };
  }

  if (path === '/api/v1/workspaces/{workspaceId}/items' && verb === 'POST') {
    return {
      can: 'Create an item under a parent, or at the workspace root when the parent is null. An optional idempotency key retries the same creation.',
      cannot:
        'Set the note, canvas, or spreadsheet body. The new item starts without body content from this call. Title, parent, and type are the creation fields.',
    };
  }

  if (path === '/api/v1/items/{itemId}' && verb === 'PATCH') {
    return {
      can: "Change the item's title.",
      cannot:
        'Move the item, delete it, change its properties, protection, or children, or edit its note, canvas, or spreadsheet body. There is no REST route that replaces a note body yet.',
    };
  }

  if (path === '/api/v1/items/{itemId}/move' && verb === 'POST') {
    return {
      can: 'Move the item under a new parent, including into another workspace when the request says so.',
      cannot:
        'Rename it, edit its body, or change its properties. A move can change who can see the item, because visibility follows the new parent.',
    };
  }

  if (path === '/api/v1/items/{itemId}' && verb === 'DELETE') {
    return {
      can: 'Soft-delete the item. The subtree stays recoverable until it is purged.',
      cannot:
        'Edit the body, and it does not permanently remove the item. Purge is a separate route.',
    };
  }

  if (path === '/api/v1/items/{itemId}/purge' && verb === 'DELETE') {
    return {
      can: 'Permanently delete an item that is already in the trash.',
      cannot:
        'Trash a live item, and it does not edit a body. An item that is not trashed is refused.',
    };
  }

  if (path === '/api/v1/items/{itemId}/restore' && verb === 'POST') {
    return {
      can: 'Restore a soft-deleted item to active.',
      cannot: 'Restore an item that has been purged, and it does not edit the body.',
    };
  }

  if (path === '/api/v1/items/{itemId}/protection' && verb === 'PUT') {
    return {
      can: 'Set whether the item can be deleted and whether it accepts new children. A null field is left unchanged.',
      cannot:
        'Rename the item, edit its body, or clear a protection the system manages, such as a linked calendar.',
    };
  }

  if (path === '/api/v1/items/{itemId}/properties' && verb === 'PATCH') {
    return {
      can: 'Set property values on the item. Tasks, habits, and other structured fields are properties on an ordinary item.',
      cannot: 'Change the title, the parent, or the note, canvas, or spreadsheet body.',
    };
  }

  if (path === '/api/v1/items/{itemId}/schema' && verb === 'PUT') {
    return {
      can: 'Replace the field definitions of a container: the schema its children inherit.',
      cannot: "Set property values on the children, and it does not edit anyone's body.",
    };
  }

  if (path === '/api/v1/items/{itemId}/views' && verb === 'PUT') {
    return {
      can: 'Replace the views saved on a container (list, board, calendar, and the rest).',
      cannot:
        'Change the children themselves or edit a body. Views are ways of reading the same children.',
    };
  }

  if (path.startsWith('/api/v1/items/{itemId}/habit')) {
    if (verb === 'GET') {
      return {
        can: 'Read habit settings, status, or check-ins for the item.',
        cannot: 'Record a check-in or edit the item body.',
      };
    }
    if (path.endsWith('/check-ins/{occurredOn}') && verb === 'DELETE') {
      return {
        can: 'Undo the check-in on the given day.',
        cannot: 'Delete the habit item or edit its body.',
      };
    }
    return {
      can: 'Update habit settings, status, or the check-in on one day, matching the summary.',
      cannot: 'Edit the note body, or change items that are not this habit.',
    };
  }

  if (path.includes('/calendar') && verb === 'GET') {
    return {
      can: 'Read calendar events or calendar-sync state in the window or list the summary names.',
      cannot:
        'Create an event, change a link, or edit a body. Synced events are ordinary items in the linked container.',
    };
  }

  if (path === '/api/v1/me/tokens' && verb === 'POST') {
    return {
      can: 'Mint a personal access token for the signed-in person. The secret is in this response only.',
      cannot:
        'Be called with a personal access token. Minting is an interactive session. The new token cannot outrun the person who minted it.',
    };
  }

  if (path === '/api/v1/me/tokens/{tokenId}' && verb === 'DELETE') {
    return {
      can: "Revoke one of the caller's personal access tokens immediately.",
      cannot:
        "Be called with a personal access token, and it does not revoke anyone else's token in a way the caller can observe. Unknown ids answer as success.",
    };
  }

  if (path === '/api/v1/me/tokens/{tokenId}/rotate' && verb === 'POST') {
    return {
      can: "Replace the secret of one of the caller's live personal access tokens. The new secret is in this response only, and the old one stops working at once.",
      cannot:
        'Be called with a personal access token, or revive a revoked or expired token. The expiry restarts with the original lifetime, never longer.',
    };
  }

  return null;
}

/**
 * @param {string} verb
 * @param {string} path
 */
function isReadShapedPost(verb, path) {
  if (verb !== 'POST') {
    return false;
  }
  const value = path.replace(/\/+$/, '').toLowerCase();
  if (value === '/api/v1/search/mentions') {
    return true;
  }
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
