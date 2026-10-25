import { runTool, TOOL_STATUS, draftNotifications, handoffSummary } from "./assistantTools.js";

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
const alertsButton = panel.querySelector(".alerts-button");
const personButton = panel.querySelector(".person-button");

// Safety topics checked in every typed message, so a warning appears straight
// away even if the assistant is slow or unavailable. flag: the escalation
// reason a utility agent would see (alert_rules in server/prompt.js).
const SAFETY_RULES = [
  {
    pattern: /\b(down(ed)?\s+(power\s+)?(lines?|wires?)|(lines?|wires?)\s+(is\s+|are\s+)?(down|on the ground)|fallen\s+(power\s+)?(lines?|wires?)|(trees?|branch(es)?|limbs?)\s+(fell\s+|is\s+|are\s+)?(on|onto|across|into)\s+(the\s+|a\s+|my\s+)?(power\s+)?(lines?|wires?)|sparks?|sparking|arcing|electrocut\w*)\b/i,
    message: "Stay at least 35 feet away from downed lines and anything touching them, and keep others away. Treat every downed line as live. Call 911 now.",
    flag: "downed line or sparks reported",
  },
  {
    pattern: /\b(on fire|(house|electrical|transformer|pole|wire|outlet) fire|fire (in|at|near|on|by|coming)|smell(s|ing)?( of)? (smoke|burning)|(see|seeing|there'?s|there is) (smoke|a fire|flames)|smoke (coming|pouring|from)|flames?)\b/i,
    message: "If there's fire or smoke, get everyone out and call 911.",
    flag: "fire or smoke reported",
  },
  {
    pattern: /\b(generators?|carbon monoxide|co (alarm|detector)|fumes)\b/i,
    message: "Never run a generator indoors, in a garage, or near windows. If a carbon monoxide alarm sounds or anyone feels dizzy or sick, get to fresh air and call 911.",
    flag: null,
  },
  {
    pattern: /\b(flood\w*|water in (my|the) (basement|house|home))\b/i,
    message: "Stay out of floodwater: it can hide live lines. Don't touch electrical equipment while you're wet or standing in water.",
    flag: null,
  },
  {
    pattern: /\b(can'?t breathe|chest pain|unconscious|not breathing|oxygen|ventilator|dialysis|life support)\b/i,
    message: "If someone's life is in danger, call 911 now. If you rely on powered medical equipment, plan where you'd go if an outage lasts, and tick the medical-equipment box in your alert preview.",
    flag: "possible medical emergency",
  },
];

// Escalation reasons raised in this conversation, and needs the customer
// declared on an alert card; both go into the "Talk to a person" summary.
const safetyFlags = new Set();
let declaredNeeds = [];

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
  // Alert previews from draft_notifications, shown as cards under the answer.
  const cards = [];

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const { content, stop_reason } = await requestTurn();
    conversation.push({ role: "assistant", content });

    // Text that comes with tool calls is working-out, so it goes with the explanation.
    const parts = content.filter((b) => b.type === "text").map((b) => splitExplanation(b.text));
    for (const part of parts) explanation.push(...part.explanation);
    const answer = parts.map((p) => p.answer).filter(Boolean).join("\n\n");

    if (stop_reason === "refusal") {
      return { explanation, cards, answer: "Sorry, I can't help with that. I can answer questions about outages, storms, preparation, and alerts." };
    }
    if (stop_reason !== "tool_use") {
      const cutOff = stop_reason === "max_tokens" ? "\n\n(My answer was cut off. Ask me to continue.)" : "";
      return { explanation, cards, answer: (answer || "Sorry, I couldn't put together an answer.") + cutOff };
    }
    if (answer) explanation.push(answer);

    // Run every requested tool, then return all results in one message.
    const toolUses = content.filter((b) => b.type === "tool_use");
    const results = [];
    for (const toolUse of toolUses) {
      onStatus(TOOL_STATUS[toolUse.name] ?? "Working…");
      const result = await runTool(toolUse);
      if (toolUse.name === "draft_notifications" && !result.is_error) cards.push(JSON.parse(result.content));
      results.push(result);
    }
    conversation.push({ role: "user", content: results });
  }

  return {
    explanation,
    cards,
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

// Build an element with a class and optional text (textContent, so no markup).
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Fill an alert card from a draft_notifications result. The medical-equipment
// checkbox is the customer's own declaration; changing it redraws the card.
function fillAlertCard(card, alerts) {
  card.replaceChildren();
  const header = el("header", "alert-card-header");
  header.append(
    el("strong", null, "Your alert preview"),
    el("span", `alert-badge ${alerts.eligible ? "eligible" : ""}`, alerts.eligible ? "Qualifies for alerts" : "Not enrolled automatically"),
  );

  const facts = el("ul", "alert-facts");
  facts.append(
    el("li", null, alerts.reasons.join(" ")),
    el("li", null, `Sent by ${alerts.channels.join(", ")}.`),
    el("li", null, `A person from the utility steps in when ${alerts.escalate_to_human_when.join("; ")}.`),
  );

  const needLabel = el("label", "alert-need");
  const needBox = el("input");
  needBox.type = "checkbox";
  needBox.checked = alerts.priority_escalation;
  needLabel.append(needBox, " I rely on powered medical equipment (adds a phone call and priority follow-up)");
  needBox.addEventListener("change", async () => {
    needBox.disabled = true;
    declaredNeeds = needBox.checked ? ["medical_equipment"] : [];
    const next = await draftNotifications({ declared_needs: declaredNeeds });
    if (next.error) {
      needBox.disabled = false;
      return;
    }
    fillAlertCard(card, next);
    card.querySelector(".alert-need input").focus();
  });

  const list = el("ol", "alert-messages");
  for (const message of alerts.messages) {
    const item = el("li");
    const head = el("div", "alert-message-head");
    head.append(el("strong", null, message.title), el("span", null, `${message.send_when} · ${message.channels.join(", ")}`));
    item.append(head, el("p", "alert-text", message.text));
    list.append(item);
  }

  card.append(header, facts, needLabel, list, el("p", "simulation-note", alerts.note));
}

// A new alert card for a draft_notifications result.
function alertCard(alerts) {
  const card = el("section", "alert-card");
  card.setAttribute("aria-label", "Alert preview");
  fillAlertCard(card, alerts);
  return card;
}

// Fill a bot bubble with the answer and a collapsed "How I got this" section.
function showReply(bubble, { explanation, answer, cards = [] }) {
  bubble.classList.add("rich");
  bubble.innerHTML = renderMarkdown(answer);
  for (const alerts of cards) bubble.appendChild(alertCard(alerts));
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

// Show a safety banner for any safety topic in a typed message, before the
// assistant answers. Topics that need a person are flagged for the handoff.
function checkSafety(text) {
  const hits = SAFETY_RULES.filter((rule) => rule.pattern.test(text));
  if (!hits.length) return;
  const bubble = el("div", "chatbot-message bot rich safety");
  bubble.setAttribute("role", "alert");
  bubble.append(el("strong", null, "⚠️ Safety"), ...hits.map((hit) => el("p", null, hit.message)));
  const flags = hits.map((hit) => hit.flag).filter(Boolean);
  if (flags.length) {
    for (const flag of flags) safetyFlags.add(flag);
    const button = el("button", "person-button", "🙋 Talk to a person");
    button.type = "button";
    button.addEventListener("click", talkToPerson);
    bubble.append(el("p", null, "This has been flagged for a person at the utility (simulated)."), button);
  }
  messages.appendChild(bubble);
  messages.scrollTop = messages.scrollHeight;
}

// The summary card a utility agent would receive.
function handoffCard(summary) {
  const card = el("section", "alert-card");
  card.setAttribute("aria-label", "Summary for the utility agent");
  const facts = el("ul", "alert-facts");
  const rows = [
    ["Location", summary.location],
    ["Storm", summary.storm],
    ["Simulated power", summary.simulated_power],
    ["Restoration step", summary.restoration_step],
    ["Restoration range (hours)", summary.restoration_range_hours],
    ["Prediction confidence", summary.confidence],
    ["Why they're calling", summary.reasons.length ? summary.reasons.join("; ") : "customer asked for a person"],
  ];
  for (const [label, value] of rows) {
    if (value == null) continue;
    const item = el("li");
    item.append(el("strong", null, `${label}: `), String(value));
    facts.append(item);
  }
  card.append(el("strong", null, "What the agent sees"), facts);
  return card;
}

// "Talk to a person": show the handoff a real service would make. Nothing is sent.
function talkToPerson() {
  openChat();
  addMessage("🙋 Talk to a person", "user");
  const bubble = addMessage("Getting a person…", "bot typing");
  queue = queue.then(async () => {
    try {
      const summary = await handoffSummary({ declared_needs: declaredNeeds, safety_flags: [...safetyFlags] });
      bubble.classList.add("rich");
      bubble.replaceChildren(
        el("p", null, "In the real service, this connects you to an outage agent. They'd get this summary, so you don't have to repeat yourself:"),
        handoffCard(summary),
        el("p", "simulation-note", "Simulated: no one is contacted. If anyone is in danger, call 911 instead of waiting."),
      );
    } catch (err) {
      bubble.textContent = `Sorry, I couldn't prepare the handoff: ${err.message}`;
    } finally {
      bubble.classList.remove("typing");
      messages.scrollTop = messages.scrollHeight;
    }
  });
}

// Show the customer's message, get the reply, and fill in the bot bubble.
// shown: what appears in the chat; text: what is sent to the assistant.
// typed: the customer wrote it, so check it for safety topics first.
function ask(shown, text, typed = false) {
  openChat();
  addMessage(shown, "user");
  if (typed) checkSafety(text);
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

personButton.addEventListener("click", talkToPerson);

// The alert button shows the preview straight away, without asking the
// assistant: the messages come from the model, so no AI round trip is needed.
alertsButton.addEventListener("click", () => {
  addMessage("🔔 Preview my alerts", "user");
  const bubble = addMessage("Drafting your alert messages…", "bot typing");
  queue = queue.then(async () => {
    try {
      const alerts = await draftNotifications({ declared_needs: [] });
      if (alerts.error) throw new Error(alerts.error);
      bubble.classList.add("rich");
      bubble.replaceChildren(
        el("p", null, "These are the messages you'd get for this storm scenario. Change the storm slider and preview again to see them update."),
        alertCard(alerts),
      );
    } catch (err) {
      bubble.textContent = `Sorry, I couldn't draft your alerts: ${err.message}`;
    } finally {
      bubble.classList.remove("typing");
      messages.scrollTop = messages.scrollHeight;
    }
  });
});

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
  ask(text, text, true);
  input.focus();
});
