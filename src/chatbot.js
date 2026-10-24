const root = document.getElementById("chatbot");
const toggle = root.querySelector(".chatbot-toggle");
const panel = root.querySelector(".chatbot-panel");
const closeButton = root.querySelector(".chatbot-close");
const messages = root.querySelector(".chatbot-messages");
const form = root.querySelector(".chatbot-form");
const input = root.querySelector(".chatbot-input");
const sendButton = form.querySelector("button");

const GREETING = "Hi! I can help you check on outages near your home. What would you like to know?";

// Return a temporary reply until the assistant has a backend connection.
async function getBotReply(text) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  return `You said: "${text}". The assistant isn't connected yet.`;
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

// Show or hide the chat panel and move keyboard focus to the right control.
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

// Open the assistant when its chat button is clicked.
toggle.addEventListener("click", () => setOpen(true));
// Close the assistant when its close button is clicked.
closeButton.addEventListener("click", () => setOpen(false));

// Let the Escape key close an open chat panel.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && root.classList.contains("open")) setOpen(false);
});

// Send the message and replace the typing bubble with the reply or an error.
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
