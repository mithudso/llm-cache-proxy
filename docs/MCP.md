# MCP scope

This project ships no MCP server, tools or project-required client integrations.
`.mcp.json` and `.vscode/mcp.json` are empty inventories. The runtime uses Node
built-ins and Anthropic HTTP. Machine-level MCP notes in historical files are not
runtime requirements and have not been revalidated by this bootstrap.

Do not add credential-bearing server definitions to this public repository. A new
integration needs an explicit purpose, documented auth boundary and mock tests.
