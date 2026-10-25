import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";
import { chatMiddleware } from "./server/chat.js";

// Mount the chatbot's /api/chat route on the dev and preview servers.
// ANTHROPIC_API_KEY has no VITE_ prefix, so it stays on the server.
function chatApi(apiKey) {
  // Block body: Vite treats a function returned from configureServer as a post hook.
  const mount = (server) => {
    server.middlewares.use("/api/chat", chatMiddleware(apiKey));
  };
  return { name: "chat-api", configureServer: mount, configurePreviewServer: mount };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [chatApi(env.ANTHROPIC_API_KEY)],
    build: {
      rollupOptions: {
        input: resolve(__dirname, "index.html"),
      },
    },
  };
});
