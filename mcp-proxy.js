#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
    ListPromptsRequestSchema,
    GetPromptRequestSchema,
    CompleteRequestSchema,
    SetLevelRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_CACHE_PATH = path.join(os.homedir(), ".mcp-session-cache");

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
            logging: {},
            completions: {}
        }
    }
);

let upstreamInitialized = false;
let upstreamSessionId = process.env.MCP_SESSION_ID || null;
if (upstreamSessionId) {
    console.error(`[MCP-PROXY] Using initial session ID from environment: ${upstreamSessionId}`);
}

// Load session from disk on startup if not provided via environment
if (!upstreamSessionId) {
    try {
        const data = await fs.readFile(SESSION_CACHE_PATH, "utf-8");
        upstreamSessionId = data.trim() || null;
        if (upstreamSessionId) {
            console.error(`[MCP-PROXY] Loaded session ID from cache: ${upstreamSessionId}`);
        }
    } catch (e) {
        // Ignore if file doesn't exist
    }
}

async function saveSessionToCache(sessionId) {
    if (!sessionId || sessionId === upstreamSessionId) return;
    upstreamSessionId = sessionId;
    try {
        await fs.writeFile(SESSION_CACHE_PATH, sessionId, "utf-8");
        console.error(`[MCP-PROXY] Saved session ID to cache: ${sessionId}`);
    } catch (e) {
        console.error(`[MCP-PROXY] Failed to save session to cache:`, e.message);
    }
}

async function fetchMcp(url, body) {
    const headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        ...(UPSTREAM_AUTH ? { "Authorization": UPSTREAM_AUTH } : {}),
        ...(upstreamSessionId ? { "Mcp-Session-Id": upstreamSessionId } : {})
    };

    if (upstreamSessionId) {
        console.error(`[MCP-PROXY] Request with Mcp-Session-Id: ${upstreamSessionId}`);
    } else {
        console.error(`[MCP-PROXY] Request with NO Session ID`);
    }

    const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body)
    });

    // Log headers for debugging
    const allHeaders = {};
    res.headers.forEach((v, k) => { allHeaders[k] = v; });
    try { await fs.appendFile("/tmp/mcp_debug.log", `[DEBUG] Response Headers: ${JSON.stringify(allHeaders)}\n`); } catch (e) { }

    // Capture Session ID if provided in headers
    const sessionId = res.headers.get("mcp-session-id");
    if (sessionId) {
        console.error(`[MCP-PROXY] Found Session ID in header: ${sessionId}`);
        await saveSessionToCache(sessionId);
    } else {
        // try { await fs.appendFile("/tmp/mcp_debug.log", `[DEBUG] No mcp-session-id header found\n`); } catch (e) { }
    }

    if (!res.ok) {
        const text = await res.text();
        let errorData;
        try {
            errorData = JSON.parse(text);
        } catch (e) { }

        const err = new Error(errorData?.error?.message || `Upstream error ${res.status}: ${text}`);
        err.status = res.status;
        err.code = errorData?.error?.code;
        throw err;
    }

    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop();

            for (const line of lines) {
                if (line.startsWith("data: ")) {
                    const dataStr = line.slice(6).trim();
                    try {
                        const data = JSON.parse(dataStr);

                        if (data.result?.sessionId) {
                            await saveSessionToCache(data.result.sessionId);
                        }

                        if (data.result || data.error) {
                            reader.cancel();
                            return data;
                        }
                    } catch (e) { }
                }
            }
        }
        throw new Error("Upstream SSE stream ended without a result");
    } else {
        const data = await res.json();
        if (data.result?.sessionId) {
            await saveSessionToCache(data.result.sessionId);
        }
        return data;
    }
}

async function clearSessionCache() {
    upstreamSessionId = null;
    upstreamInitialized = false;
    try {
        await fs.unlink(SESSION_CACHE_PATH);
        console.error(`[MCP-PROXY] Cleared session cache.`);
    } catch (e) {
        // Ignore if file doesn't exist
    }
}

async function ensureUpstreamInitialized() {
    if (upstreamInitialized) return;

    console.error(`[MCP-PROXY] Ensuring upstream initialized...`);

    // Use a unique client name per session to ensure fresh initialization
    const clientNameSuffix = Math.random().toString(36).slice(2);
    const initRequestBody = {
        jsonrpc: "2.0",
        id: "init-" + clientNameSuffix,
        method: "initialize",
        params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: {
                name: "mcp-stdio-http-proxy-" + clientNameSuffix,
                version: "1.0.0"
            }
        }
    };

    try {
        const data = await fetchMcp(UPSTREAM_URL, initRequestBody);
        try { await fs.appendFile("/tmp/mcp_debug.log", `INIT SUCCESS DATA: ${JSON.stringify(data)}\n`); } catch (e) { }

        if (data.error) {
            const errMsg = (data.error.message || "").toLowerCase();
            if (errMsg.includes("already initialized") || errMsg.includes("already started")) {
                console.error(`[MCP-PROXY] Upstream was already initialized.`);
                upstreamInitialized = true;
                return;
            }
            throw new Error(`Upstream Init error: ${data.error.message}`);
        }

        // Send initialized notification
        const initHeaders = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            ...(UPSTREAM_AUTH ? { "Authorization": UPSTREAM_AUTH } : {}),
            ...(upstreamSessionId ? { "Mcp-Session-Id": upstreamSessionId } : {})
        };

        console.error(`[MCP-PROXY] Sending notifications/initialized...`);
        await fetch(UPSTREAM_URL, {
            method: "POST",
            headers: initHeaders,
            body: JSON.stringify({
                jsonrpc: "2.0",
                method: "notifications/initialized"
            })
        });

        upstreamInitialized = true;
        console.error(`[MCP-PROXY] Upstream ready (Session: ${upstreamSessionId || "unknown"}).`);
    } catch (err) {
        try { await fs.appendFile("/tmp/mcp_debug.log", `INIT CATCH ERROR: ${err.message}\n`); } catch (e) { }
        // If 400/401/406 or specific error text, clear memory and retry
        const errMsg = (err.message || "").toLowerCase();
        if (errMsg.includes("already initialized")) {
            console.error(`[MCP-PROXY] Upstream reported already initialized, treating as success.`);
            upstreamInitialized = true;
            return;
        }

        if (errMsg.includes("not initialized") || errMsg.includes("session") || err.status === 401 || err.status === 406) {
            console.error(`[MCP-PROXY] Init failed with session error (${err.message}), clearing memory and retrying...`);
            upstreamSessionId = null;
            upstreamInitialized = false;
            // No need to await clearSessionCache again, just null the memory
            const retryData = await fetchMcp(UPSTREAM_URL, initRequestBody);
            if (retryData.error) throw new Error(`Upstream Init Retry error: ${retryData.error.message}`);

            // Send initialized notification for the retry
            await fetch(UPSTREAM_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json, text/event-stream",
                    ...(UPSTREAM_AUTH ? { "Authorization": UPSTREAM_AUTH } : {}),
                    ...(upstreamSessionId ? { "Mcp-Session-Id": upstreamSessionId } : {})
                },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    method: "notifications/initialized"
                })
            });
            upstreamInitialized = true;
            return;
        }

        console.error(`[MCP-PROXY] Failed to initialize upstream:`, err.message);
        throw err;
    }
}

async function forwardToHttpMcp(method, params = {}, retryCount = 0) {
    await ensureUpstreamInitialized();

    const requestBody = {
        jsonrpc: "2.0",
        id: Math.random().toString(36).slice(2),
        method,
        params
    };

    console.error(`[MCP-PROXY] → POST ${UPSTREAM_URL} | method=${method}`);

    try {
        const data = await fetchMcp(UPSTREAM_URL, requestBody);

        if (data.error) {
            console.error(`[MCP-PROXY] Upstream returned error: ${JSON.stringify(data.error)}`);
            // Handle session issues mid-session
            const errMsg = (data.error.message || "").toLowerCase();
            const isSessionError = errMsg.includes("not initialized") ||
                errMsg.includes("session") ||
                errMsg.includes("expired") ||
                data.error.code === -32000; // Not Acceptable can sometimes mean bad state

            if (retryCount < 1 && isSessionError) {
                console.error(`[MCP-PROXY] Upstream reported session issue during ${method}. Retrying...`);
                await clearSessionCache();
                upstreamSessionId = null; // Ensure memory is cleared
                return await forwardToHttpMcp(method, params, retryCount + 1);
            }

            const err = new Error(data.error.message || "Unknown upstream error");
            if (data.error.code) err.code = data.error.code;
            if (data.error.data) err.data = data.error.data;
            throw err;
        }

        return data.result;
    } catch (err) {
        console.error(`[MCP-PROXY] Fetch catch error: ${err.message} (Status: ${err.status})`);
        // Handle session issues mid-session (via status code or error message)
        const errMsg = (err.message || "").toLowerCase();
        const isSessionError = errMsg.includes("not initialized") ||
            errMsg.includes("session") ||
            errMsg.includes("expired") ||
            err.status === 401 ||
            err.status === 406;

        if (retryCount < 1 && isSessionError) {
            console.error(`[MCP-PROXY] Upstream error session/auth during ${method}. Retrying...`);
            await clearSessionCache();
            upstreamSessionId = null; // Ensure memory is cleared
            return await forwardToHttpMcp(method, params, retryCount + 1);
        }

        console.error(`[MCP-PROXY] Upstream error for ${method}:`, err.message);
        throw err;
    }
}

// Register handlers with explicit schemas
server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const result = await forwardToHttpMcp("tools/list", request.params);
    // Add custom update tool
    if (result && result.tools) {
        result.tools.push({
            name: "update",
            description: "Refresh the tool list from the upstream server and reset the session cache.",
            inputSchema: {
                type: "object",
                properties: {},
                required: []
            }
        });
    }
    return result;
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "update") {
        console.error(`[MCP-PROXY] Intercepted 'update' tool call. Clearing session...`);
        await clearSessionCache();
        return {
            content: [{
                type: "text",
                text: "Successfully cleared session cache. The tool list will be re-initialized from the upstream on the next request."
            }]
        };
    }
    return await forwardToHttpMcp("tools/call", request.params);
});

server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    return await forwardToHttpMcp("resources/list", request.params);
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    return await forwardToHttpMcp("resources/read", request.params);
});

server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
    return await forwardToHttpMcp("prompts/list", request.params);
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    return await forwardToHttpMcp("prompts/get", request.params);
});

server.setRequestHandler(CompleteRequestSchema, async (request) => {
    return await forwardToHttpMcp("completion/complete", request.params);
});

server.setRequestHandler(SetLevelRequestSchema, async (request) => {
    return await forwardToHttpMcp("logging/setLevel", request.params);
});

const transport = new StdioServerTransport();
await server.connect(transport);

console.error(`[MCP-PROXY] Running on stdio → forwarding to ${UPSTREAM_URL}`);
