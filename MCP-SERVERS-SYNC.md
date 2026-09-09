# MCP Servers Synchronization — 2026-06-25

Successfully copied all MCP server configurations from Claude Code to Auggie.

## Source
`~/.claude/settings.json` → `~/.augment/settings.json`

## MCP Servers Copied

### 1. **glean_default**
- Type: HTTP
- URL: https://mongodb-be.glean.com/mcp/default
- Purpose: MongoDB BE Glean integration

### 2. **glean_developer_docs**
- Type: HTTP
- URL: https://developers.glean.com/mcp
- Purpose: Glean developer documentation access

### 3. **monday-apps-mcp**
- Type: Command (npx)
- Package: @mondaydotcomorg/monday-api-mcp
- Mode: apps
- Auth: MONDAY_API_TOKEN environment variable
- Purpose: Monday.com apps integration

### 4. **MongoDB**
- Type: Command (npx)
- Package: mongodb-mcp-server@latest
- Mode: Read-only
- Auth: MDB_MCP_API_CLIENT_ID and MDB_MCP_API_CLIENT_SECRET
- Purpose: MongoDB API integration

### 5. **tam_mcp**
- Type: HTTP
- URL: http://127.0.0.1:3939/mcp
- Purpose: TAM (Technical Account Manager) MCP server

### 6. **mdb_case_assistant**
- Type: Command (tsx)
- Path: /Users/mitch.hudson/Documents/GitHub/mdb-case-assistant/mcp-server/src/index.ts
- Purpose: MongoDB case assistant integration

### 7. **monday-access-mcp**
- Type: Command (npx)
- Package: @mondaydotcomorg/monday-api-mcp
- Auth: MONDAY_API_TOKEN environment variable
- Purpose: Monday.com access integration

### 8. **vibe**
- Type: Command (npx)
- Package: @vibe/mcp
- Purpose: Vibe MCP integration

### 9. **granola**
- Type: HTTP
- URL: https://mcp.granola.ai/mcp
- Purpose: Granola MCP integration

### 10. **mdb_tam_account_context**
- Type: Command (node)
- Path: /Users/mitch.hudson/Documents/dashboard/mdb-tam/packages/mcp-server/src/server.js
- Environment:
  - DASHBOARD_API_TOKEN: [configured]
  - DASHBOARD_URL: http://127.0.0.1:8787
- Purpose: MongoDB TAM account context integration

## Verification

✅ All 10 MCP servers copied successfully
✅ JSON syntax validated
✅ Configuration preserved exactly as in Claude Code

## Next Steps

To use these MCP servers in Auggie:
1. Restart Auggie to load the new configuration
2. Ensure all required environment variables are set:
   - `MONDAY_API_TOKEN`
   - `MDB_MCP_API_CLIENT_ID`
   - `MDB_MCP_API_CLIENT_SECRET`
3. Verify that local MCP servers are running:
   - tam_mcp (port 3939)
   - mdb_tam_account_context (dashboard on port 8787)

## Notes

- HTTP-based MCPs (Glean, Granola) require network access
- Command-based MCPs will launch on-demand
- Local file paths are preserved (mdb_case_assistant, mdb_tam_account_context)
- All authentication tokens use environment variable substitution for security
