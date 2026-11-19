# MCP and agents

## MCP server

Nix has a Model Context Protocol server, so agent tools that speak MCP can work in your workspaces. Whichever way it connects, it runs as you and can never reach further than you can.

### On your own computer

`nixctl mcp` runs the server over stdio, with your profile's token. Add it to an MCP client's configuration like this:

```json
{
  "mcpServers": {
    "nix": {
      "command": "nixctl",
      "args": ["--profile", "default", "mcp"]
    }
  }
}
```

### Over the network

`nixctl mcp --listen` serves the same tools over HTTP. Every request carries its own personal access token in an `Authorization: Bearer` header, and acts as that person. On an install where the operator has set the MCP address, **Settings > MCP** shows the address and a ready-made command for Claude Code. It also lists your MCP tokens, where you can create and revoke them.

Use a token with only the scopes the agent needs. A `read` token cannot change anything; automations and other administrative changes need `admin`. Tokens can be rotated from **Settings > Access tokens**, or with `nixctl token rotate`: the token keeps its name and scopes, you see the new secret once, and the old one stops working at once.

### Hosted clients

Hosted clients such as claude.ai and ChatGPT sign in with OAuth, so you never copy a token by hand. The client finds Nix's sign-in details, registers itself, and sends you to a consent page that names the client and where it returns to. You choose the scopes it gets and press **Approve** or **Deny**. The client then holds an ordinary personal access token that expires after 90 days. You can see it, rotate it and revoke it with your other tokens. This only works on an install where the operator has set the MCP address and the public origin.

### Switching MCP on or off

A tenant administrator can turn remote MCP on or off for everyone in the tenant, under **Settings > Administrators > Agents and sharing > MCP for agents**. The switch is disabled where the install itself has MCP turned off. Workspace owners can also decide whether agents may create public links or approve file versions, in the workspace's settings.

### What the tools cover

Over stdio the server offers 125 tools. Over HTTP it offers 119, because six that read or write files on the machine running the server are left out (document import, file upload, replace and download, and template archive preview and export). Uploads and downloads are still available through short-lived upload and download links. The tools cover:

- items: list, read, create, move, rename, trash and restore, set properties and schemas, find and query by property, and write records in bulk;
- notes: read and write bodies, search, history, restore and name versions, and comments;
- references, backlinks and attachments;
- workspaces, invitations and members;
- templates: browse, preflight, capture, drafts, apply, import and export;
- document import with preview, commit and cancel;
- files: upload, replace, list versions, set review states and download;
- public links: read, create and revoke;
- structures and blueprints: read, validate, describe and build;
- habits: definitions, status, check-ins and undo;
- notifications, reminders and automations;
- calendar links and sync logs;
- item protection;
- chat notes and the companion;
- a find-and-run pair that reaches any other Nix operation.

Tool inputs are validated before they reach the server, and errors carry the server's explanation, including which token scope a refused call needed. Operations reserved for people, such as workspace passwords, are refused.

Tool results are data. Note contents and filenames that come back from a tool never grant an agent new authority.

## Properties

- title: MCP and agents

