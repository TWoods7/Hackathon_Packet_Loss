// /api/chat: relays one turn of the conversation to Claude.
// The server is stateless: the browser keeps the conversation and runs the
// tools, then posts again with the tool results. The server adds the system
// prompt and tool definitions so the browser can't change them.
import Anthropic from "@anthropic-ai/sdk";
import { MODEL, SYSTEM_PROMPT, TOOLS } from "./prompt.js";

const MAX_BODY_BYTES = 2_000_000;
const MAX_MESSAGES = 400;

// Read a JSON request body, refusing anything over MAX_BODY_BYTES.
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Conversation is too long. Start a new chat."), { status: 413 }));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("Invalid JSON."), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

// Only plain user/assistant turns are accepted, so a client can't add its own
// system messages or overwrite the system prompt.
function validMessages(messages) {
  return (
    Array.isArray(messages) &&
    messages.length > 0 &&
    messages.length <= MAX_MESSAGES &&
    messages[0].role === "user" &&
    messages.every((m) => (m.role === "user" || m.role === "assistant") && m.content != null)
  );
}

// Send a JSON response with a status code.
function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

// Build the Connect-style middleware Vite mounts at /api/chat.
export function chatMiddleware(apiKey) {
  const client = apiKey ? new Anthropic({ apiKey }) : null;

  return async (req, res) => {
    if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST." });
    if (!client) {
      return sendJson(res, 503, { error: "The assistant isn't configured: set ANTHROPIC_API_KEY in .env and restart." });
    }

    try {
      const { messages } = await readJson(req);
      if (!validMessages(messages)) return sendJson(res, 400, { error: "Invalid conversation." });

      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        output_config: { effort: "low" },
        // Cache the fixed prompt + tools; only the conversation changes per turn.
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: TOOLS,
        messages,
        // If the model declines a request, the API retries it on a fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });

      // Audit trail: which tools were requested and token usage, never message text.
      const toolNames = response.content.filter((b) => b.type === "tool_use").map((b) => b.name);
      const { input_tokens, output_tokens, cache_read_input_tokens } = response.usage;
      console.log(
        `[chat] ${response.stop_reason} tools=[${toolNames.join(",")}] ` +
          `in=${input_tokens} cached=${cache_read_input_tokens ?? 0} out=${output_tokens}` +
          (response.stop_details?.category ? ` refusal=${response.stop_details.category}` : ""),
      );

      sendJson(res, 200, { content: response.content, stop_reason: response.stop_reason });
    } catch (err) {
      console.error("[chat]", err.status ?? "", err.message);
      if (err instanceof Anthropic.RateLimitError) {
        sendJson(res, 429, { error: "The assistant is busy. Please try again in a moment." });
      } else if (err instanceof Anthropic.AuthenticationError) {
        sendJson(res, 502, { error: "The assistant's API key was rejected. Check ANTHROPIC_API_KEY." });
      } else if (err instanceof Anthropic.APIError) {
        sendJson(res, 502, { error: "The assistant service had a problem. Please try again." });
      } else {
        sendJson(res, err.status ?? 500, { error: err.status ? err.message : "Something went wrong." });
      }
    }
  };
}
