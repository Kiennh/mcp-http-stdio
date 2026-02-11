# MCP stdio → streamableHttp Proxy --- Implementation Plan

## 1) Goal

Build a single Node.js program that:

-   Runs as an MCP server over **stdio**
-   Forwards all MCP requests over **HTTP** to another MCP server
    running with **streamableHttp**
-   Supports:
    -   Configurable upstream URL
    -   Optional authentication
    -   Timeouts
    -   Basic logging and error handling

Architecture:

    Antigravity (stdio)
            │
            ▼
    [ MCP Proxy - stdio ]
            │ (HTTP JSON-RPC)
            ▼
    [ MCP Server - streamableHttp ]

------------------------------------------------------------------------

## 2) MCP Methods to Proxy

  From Antigravity (stdio)   To Upstream (HTTP)
  -------------------------- ---------------------------------------------
  `tools/list`               POST `{ method: "tools/list" }`
  `tools/call`               POST `{ method: "tools/call", params }`
  `resources/list`           POST `{ method: "resources/list" }`
  `resources/read`           POST `{ method: "resources/read", params }`

------------------------------------------------------------------------

## 3) Project Structure

    mcp-stdio-http-proxy/
    │
    ├── package.json
    ├── mcp-proxy.js
    └── README.md

------------------------------------------------------------------------

## 4) Implementation Steps

### 4.1 Initialize Node project

``` bash
npm init -y
npm install @modelcontextprotocol/sdk dotenv
```

------------------------------------------------------------------------

### 4.2 `mcp-proxy.js` (full implementation)

``` js
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import "dotenv/config";

const UPSTREAM_URL =
  process.env.UPSTREAM_MCP_URL ||
  process.argv[2] ||
  "http://localhost:8080/mcp";

const UPSTREAM_AUTH = process.env.UPSTREAM_AUTH || "";
const TIMEOUT_MS = Number(process.env.MCP_TIMEOUT_MS || "15000");

const server = new Server(
  { name: "mcp-stdio-http-proxy", version: "1.0.0" },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
      logging: {}
    }
  }
);

async function forwardToHttpMcp(method, params = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const requestBody = {
    jsonrpc: "2.0",
    id: Math.random().toString(36).slice(2),
    method,
    params
  };

  console.error(`[MCP-PROXY] → POST ${UPSTREAM_URL} | method=${method}`);

  try {
    const res = await fetch(UPSTREAM_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(UPSTREAM_AUTH ? { "Authorization": UPSTREAM_AUTH } : {})
      },
      body: JSON.stringify(requestBody)
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Upstream HTTP error ${res.status}: ${text}`);
    }

    const data = await res.json();

    if (data.error) {
       // Propagate error details if available
       const err = new Error(data.error.message || "Unknown upstream error");
       if (data.error.code) err.code = data.error.code;
       if (data.error.data) err.data = data.error.data;
       throw err;
    }

    return data.result;
  } catch (err) {
    clearTimeout(timeout);
    console.error(`[MCP-PROXY] Upstream error for ${method}:`, err.message);
    throw err;
  }
}

// Methods to proxy
const PROXY_METHODS = [
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/read",
  "prompts/list",
  "prompts/get",
  "completion/complete",
  "logging/setLevel"
];

// Register handlers dynamically
for (const method of PROXY_METHODS) {
  server.setRequestHandler(method, async (request) => {
    return await forwardToHttpMcp(method, request.params);
  });
}

const transport = new StdioServerTransport();
await server.connect(transport);

console.error(`[MCP-PROXY] Running on stdio → forwarding to ${UPSTREAM_URL}`);
```

------------------------------------------------------------------------

## 5) Running the Proxy

### Local upstream

``` bash
node mcp-proxy.js http://localhost:8080/mcp
```

### With authentication

``` bash
UPSTREAM_MCP_URL="https://api.example.com/mcp" UPSTREAM_AUTH="Bearer SECRET123" node mcp-proxy.js
```

### In Antigravity

Set command to:

    node /path/to/mcp-proxy.js

Arguments:

    http://your-remote-mcp-server/mcp

------------------------------------------------------------------------

## 6) Error Handling

-   **Upstream down:** fetch fails → logged and returned as MCP error.
-   **Slow upstream:** request aborts after `MCP_TIMEOUT_MS` (default
    15s).
-   **Invalid JSON:** request fails with clear error.

Increase timeout:

``` bash
MCP_TIMEOUT_MS=30000 node mcp-proxy.js
```

------------------------------------------------------------------------

## 7) Debug mode

Run with:

``` bash
MCP_DEBUG=1 node mcp-proxy.js
```

(You can extend logging in `forwardToHttpMcp` accordingly.)

------------------------------------------------------------------------

## 8) Optional Dockerfile

    FROM node:20

    WORKDIR /app
    COPY package.json .
    RUN npm install

    COPY mcp-proxy.js .

    ENTRYPOINT ["node", "mcp-proxy.js"]

Run:

``` bash
docker build -t mcp-proxy .
docker run -e UPSTREAM_MCP_URL="http://host.docker.internal:8080/mcp" mcp-proxy
```

------------------------------------------------------------------------

## 9) What this gives you

-   MCP server over **stdio**
-   Transparent proxy to **streamableHttp MCP**
-   Configurable upstream + auth
-   Works with Antigravity
