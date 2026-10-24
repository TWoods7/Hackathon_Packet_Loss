const root = document.getElementById("chatbot");
const toggle = root.querySelector(".chatbot-toggle");
const panel = root.querySelector(".chatbot-panel");
const closeButton = root.querySelector(".chatbot-close");
const messages = root.querySelector(".chatbot-messages");
const form = root.querySelector(".chatbot-form");
const input = root.querySelector(".chatbot-input");
const sendButton = form.querySelector("button");

const GREETING = "Hi! I can help you check on outages near your home. What would you like to know?";

// Placeholder until a real backend exists. Swap this for a fetch() to your
// server; never call an LLM API with a secret key straight from the browser.
async function getBotReply(text) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  return `You said: "${text}". The assistant isn't connected yet.`;
}

function addMessage(text, sender) {
  const bubble = document.createElement("div");
  bubble.className = `chatbot-message ${sender}`;
  // textContent, not innerHTML, so user input can't inject markup
  bubble.textContent = text;
  messages.appendChild(bubble);
  messages.scrollTop = messages.scrollHeight;
  return bubble;
}

function setOpen(open) {
  root.classList.toggle("open", open);
  toggle.setAttribute("aria-expanded", String(open));
  panel.setAttribute("aria-hidden", String(!open));
  if (open) {
    if (!messages.childElementCount) addMessage(GREETING, "bot");
    input.focus();
  } else {
    toggle.focus();
  }
}

toggle.addEventListener("click", () => setOpen(true));
closeButton.addEventListener("click", () => setOpen(false));

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && root.classList.contains("open")) setOpen(false);
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  addMessage(text, "user");
  input.value = "";
  sendButton.disabled = true;
  const typing = addMessage("…", "bot typing");

  try {
    typing.textContent = await getBotReply(text);
  } catch (err) {
    typing.textContent = `Sorry, something went wrong: ${err.message}`;
  } finally {
    typing.classList.remove("typing");
    sendButton.disabled = false;
    input.focus();
  }
});
