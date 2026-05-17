#!/usr/bin/env node
// Diagnostic script to test Xiaomi MiMo API directly
// Usage: XIAOMI_API_KEY=xxx XIAOMI_BASE_URL=https://token-plan-sgp.xiaomimimo.com/v1 node scripts/test-xiaomi.mjs

const API_KEY = process.env.XIAOMI_API_KEY;
const BASE_URL = process.env.XIAOMI_BASE_URL;

if (!API_KEY || !BASE_URL) {
  console.error("Set XIAOMI_API_KEY and XIAOMI_BASE_URL environment variables");
  process.exit(1);
}

async function test(label, body) {
  console.log(`\n--- Test: ${label} ---`);
  const url = `${BASE_URL}/chat/completions`;
  const bodyStr = JSON.stringify(body, null, 2);
  console.log(`Request body (${bodyStr.length} chars):`, bodyStr.slice(0, 500));
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: bodyStr,
    });
    const text = await res.text();
    console.log(`Status: ${res.status}`);
    console.log(`Response: ${text.slice(0, 500)}`);
    return res.ok;
  } catch (e) {
    console.error(`Error: ${e.message}`);
    return false;
  }
}

const MODEL = "MiMo-V2-Omni";

// Test 1: Minimal request (no tools)
await test("Minimal (no tools)", {
  model: MODEL,
  messages: [{ role: "user", content: "Say hello in one word." }],
});

// Test 2: With max_completion_tokens
await test("With max_completion_tokens", {
  model: MODEL,
  messages: [{ role: "user", content: "Say hello in one word." }],
  max_completion_tokens: 100,
});

// Test 3: With temperature
await test("With temperature", {
  model: MODEL,
  messages: [{ role: "user", content: "Say hello in one word." }],
  temperature: 0.7,
});

// Test 4: With a single simple tool
await test("With one simple tool", {
  model: MODEL,
  messages: [{ role: "user", content: "List files in the current directory." }],
  tools: [{
    type: "function",
    function: {
      name: "list_files",
      description: "List files in a directory",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path" },
        },
        required: ["path"],
      },
    },
  }],
});

// Test 5: With tool_choice
await test("With tool_choice=auto", {
  model: MODEL,
  messages: [{ role: "user", content: "List files in the current directory." }],
  tools: [{
    type: "function",
    function: {
      name: "list_files",
      description: "List files in a directory",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path" },
        },
        required: ["path"],
      },
    },
  }],
  tool_choice: "auto",
});

// Test 6: With multiple tools (like architect uses)
await test("With multiple tools", {
  model: MODEL,
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "List files in the current directory." },
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read file contents",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path to read" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_files",
        description: "List files in a directory",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Directory path", required: false },
          },
        },
      },
    },
  ],
});

// Test 7: With response_format
await test("With response_format", {
  model: MODEL,
  messages: [{ role: "user", content: "Return JSON: {\"hello\": \"world\"}" }],
  response_format: { type: "json_object" },
});

console.log("\n--- Done ---");
