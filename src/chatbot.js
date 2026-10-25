import { runTool, TOOL_STATUS } from "./assistantTools.js";

// The assistant is a full-page view over the map. Searching a location opens
// it (map.js fires "location-searched"); "Back to map" returns to the map.
const panel = document.getElementById("chatbot");
const backButton = panel.querySelector(".back-to-map");
const openChatButton = document.getElementById("open-chat");
// Map-page parts hidden from keyboard and screen readers while the chat covers them.
const mapParts = [...document.querySelectorAll("#map, .map-controls, .storm-panel")];
const messages = panel.querySelector(".chatbot-messages");
const form = panel.querySelector(".chatbot-form");
const input = panel.querySelector(".chatbot-input");
const sendButton = form.querySelector("button");

// Safety limit on tool round trips for one customer message.
const MAX_TOOL_ROUNDS = 8;

// Full conversation in API format. Assistant turns are stored exactly as the
// API returned them (thinking blocks included) and never edited afterwards.
const conversation = [];

// Send the conversation to /api/chat and return Claude's next turn.
async function requestTurn() {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: conversation }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

// Separate the <explanation> section ("How I got this") from the customer-facing text.
function splitExplanation(text) {
  const explanation = [];
  const answer = text.replace(/<explanation>([\s\S]*?)(<\/explanation>|$)/g, (_, inner) => {
    explanation.push(inner.trim());
    return "";
  });
  return { explanation, answer: answer.trim() };
}

// Run the tool loop for one customer message. Returns the explanation and
// the final answer text. onStatus shows progress while tools run.
async function getBotReply(text, onStatus) {
  conversation.push({ role: "user", content: text });
  const explanation = [];

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const { content, stop_reason } = await requestTurn();
    conversation.push({ role: "assistant", content });

    // Text that comes with tool calls is working-out, so it goes with the explanation.
    const parts = content.filter((b) => b.type === "text").map((b) => splitExplanation(b.text));
    for (const part of parts) explanation.push(...part.explanation);
    const answer = parts.map((p) => p.answer).filter(Boolean).join("\n\n");

    if (stop_reason === "refusal") {
      return { explanation, answer: "Sorry, I can't help with that. I can answer questions about outages, storms, preparation, and alerts." };
    }
    if (stop_reason !== "tool_use") {
      const cutOff = stop_reason === "max_tokens" ? "\n\n(My answer was cut off. Ask me to continue.)" : "";
      return { explanation, answer: (answer || "Sorry, I couldn't put together an answer.") + cutOff };
    }
    if (answer) explanation.push(answer);

    // Run every requested tool, then return all results in one message.
    const toolUses = content.filter((b) => b.type === "tool_use");
    const results = [];
    for (const toolUse of toolUses) {
      onStatus(TOOL_STATUS[toolUse.name] ?? "Working…");
      results.push(await runTool(toolUse));
    }
    conversation.push({ role: "user", content: results });
  }

  return {
    explanation,
    answer: "I couldn't finish working that out. Please try asking in a simpler way, or check the utility's official outage map.",
  };
}

// Escape text so model output can't inject markup.
function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

// Render the small Markdown subset the assistant uses: **bold**, "- " bullets, paragraphs.
// Text is escaped first, so only the tags added here can appear.
function renderMarkdown(text) {
  const inline = (line) => escapeHtml(line).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  const html = [];
  let list = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const bullet = line.match(/^[-*•]\s+(.*)/);
    if (bullet) {
      list ??= [];
      list.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    if (list) {
      html.push(`<ul>${list.join("")}</ul>`);
      list = null;
    }
    if (line) html.push(`<p>${inline(line)}</p>`);
  }
  if (list) html.push(`<ul>${list.join("")}</ul>`);
  return html.join("");
}

// Add a message bubble and scroll the conversation to the newest message.
function addMessage(text, sender) {
  const bubble = document.createElement("div");
  bubble.className = `chatbot-message ${sender}`;
  // textContent, not innerHTML, so user input can't inject markup
  bubble.textContent = text;
  messages.appendChild(bubble);
  messages.scrollTop = messages.scrollHeight;
  return bubble;
}

// Fill a bot bubble with the answer and a collapsed "How I got this" section.
function showReply(bubble, { explanation, answer }) {
  bubble.classList.add("rich");
  bubble.innerHTML = renderMarkdown(answer);
  if (explanation.length) {
    const details = document.createElement("details");
    details.className = "chatbot-explanation";
    const summary = document.createElement("summary");
    summary.textContent = "How I got this";
    const body = document.createElement("div");
    body.innerHTML = renderMarkdown(explanation.join("\n\n"));
    details.append(summary, body);
    bubble.appendChild(details);
  }
}

// Switch between the chat view and the map.
function setOpen(open) {
  panel.hidden = !open;
  for (const part of mapParts) part.inert = open;
  // Once a conversation exists, the map offers a way back to it.
  const hasMessages = messages.childElementCount > 0;
  openChatButton.hidden = open || !hasMessages;
  if (open) input.focus();
  else if (hasMessages) openChatButton.focus();
}

// Open the chat as a browser history entry, so the browser's Back button
// returns to the map.
function openChat() {
  if (panel.hidden) {
    history.pushState({ view: "chat" }, "", "#chat");
    setOpen(true);
  }
}

// Leave the chat the same way the browser's Back button would.
backButton.addEventListener("click", () => {
  if (history.state?.view === "chat") history.back();
  else setOpen(false);
});
openChatButton.addEventListener("click", openChat);
window.addEventListener("popstate", (e) => setOpen(e.state?.view === "chat" && messages.childElementCount > 0));

// A reload can't restore the conversation, so start on the map.
if (location.hash === "#chat") history.replaceState(null, "", location.pathname);

// One exchange at a time, so a search during a reply waits its turn instead of
// interleaving two tool loops in the same conversation.
let queue = Promise.resolve();

// Show the customer's message, get the reply, and fill in the bot bubble.
// shown: what appears in the chat; text: what is sent to the assistant.
function ask(shown, text) {
  openChat();
  addMessage(shown, "user");
  const typing = addMessage("…", "bot typing");

  queue = queue.then(async () => {
    sendButton.disabled = true;
    const conversationLength = conversation.length;
    try {
      const reply = await getBotReply(text, (status) => {
        typing.textContent = status;
      });
      showReply(typing, reply);
    } catch (err) {
      // Drop the failed exchange so the next message starts from a valid conversation.
      conversation.length = conversationLength;
      typing.textContent = `Sorry, something went wrong: ${err.message}`;
    } finally {
      typing.classList.remove("typing");
      sendButton.disabled = false;
      messages.scrollTop = messages.scrollHeight;
    }
  });
}

// A search from the address bar starts (or continues) the conversation with a
// short summary for that location. The map has already moved there.
document.addEventListener("location-searched", ({ detail }) => {
  ask(
    `📍 ${detail.query}`,
    `[Searched from the map's address bar: "${detail.query}", matched to "${detail.formattedAddress}". ` +
      "This location is already selected on the map.] Give me a short summary for this location.",
  );
});

// Send a follow-up question typed into the chat.
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  ask(text, text);
  input.focus();
});
