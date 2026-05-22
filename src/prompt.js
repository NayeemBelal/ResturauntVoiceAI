const fs = require('fs');
const path = require('path');
const { compressMenu } = require('./menu-compress');

const DATA_DIR = path.join(__dirname, '..', 'data', 'lime_n_dime');
const MENU_PATH = path.join(DATA_DIR, 'menu.json');

const template = fs.readFileSync(path.join(DATA_DIR, 'oneflow.txt'), 'utf8');
const businessLogic = fs.readFileSync(path.join(DATA_DIR, 'business_logic.txt'), 'utf8');
let menu = fs.existsSync(MENU_PATH) ? compressMenu(JSON.parse(fs.readFileSync(MENU_PATH, 'utf8'))) : {};

function reloadMenu(menuData) {
  if (menuData) {
    menu = compressMenu(menuData);
    return;
  }
  try {
    menu = compressMenu(JSON.parse(fs.readFileSync(MENU_PATH, 'utf8')));
  } catch (err) {
    console.error('[prompt] Failed to reload menu.json:', err.message);
  }
}

function buildSystemPrompt(callContext = {}) {
  let prompt = template
    .replace('{business_logic}', businessLogic.trim())
    .replace('{menu}', JSON.stringify(menu, null, 2));

  const {
    greeting = 'Hi, what can I get for you today?',
    customerFirstName = '',
    customerLastName = '',
    hasFullName = false,
    businessHours = null,
    faqs = [],
    upsellRules = [],
    resumeCart = [],
    resumedFromPrior = false,
  } = callContext;

  prompt += `\n\nCALL START:\nYour very first words must be exactly: "${greeting}"\nDo not say anything before this. Do not call any tool before speaking. Speak the greeting the moment the call connects.`;

  if (resumedFromPrior && resumeCart.length > 0) {
    prompt += `\n\nRESUMED CART: The customer was already told in the greeting that they have an open order. Wait for their response. If they want to continue, proceed with the existing cart — do not re-add any of these items. If they want to start fresh, call clearCart immediately before taking any new items. Do not say the cart is cleared until clearCart returns. Items in the resumed cart: ${JSON.stringify(resumeCart)}`;
  }

  prompt += `\n\nCUSTOMER ON FILE:\n- First name: ${customerFirstName || 'unknown'}\n- Last name: ${customerLastName || 'unknown'}\n- Full name on file: ${hasFullName}`;

  if (businessHours) {
    prompt += `\n\nBUSINESS HOURS (enforce cutoff — do not accept orders after closing):\n${businessHours}`;
  }

  if (faqs.length > 0) {
    const faqText = faqs.map(f => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n');
    prompt += `\n\nFREQUENTLY ASKED QUESTIONS:\n${faqText}`;
  }

  if (upsellRules.length > 0) {
    const upsellText = upsellRules.map(r => `When customer orders "${r.trigger_item_name}", suggest: "${r.suggested_item_name}" — ${r.message}`).join('\n');
    prompt += `\n\nUPSELL RULES (mention once, naturally, do not be pushy):\n${upsellText}`;
  }

  prompt += `\n\nCUSTOMER NAME CAPTURE:\nBefore calling sendCheckoutLink, you need both first and last name. If hasFullName is true in your context above, their name is already saved — do not ask again unless they volunteer a correction. If hasFullName is false, ask the customer to spell their name clearly before checkout. Once you have both names, call saveCustomerName before sendCheckoutLink. If saveCustomerName fails, correct the name and retry.`;

  prompt += `\n\nCART TOOL CALL RULE — NON-NEGOTIABLE:\nEvery time the customer confirms an item, call addToCart in that same turn. Before calling, say a short natural bridge phrase to keep the customer engaged during the brief processing moment — for example: "Let me get that added for you," or "One sec, getting that in now — how's your evening going?" or any light conversational filler or question. Do not confirm the item was added until addToCart returns successfully. Never defer. Never batch. Never hold items in memory. The cart on the server is the only truth. getCart at checkout must match what the customer ordered — if it does not, something failed during ordering, not at checkout.`;

  return prompt;
}

const DEMO_DATA_DIR = path.join(__dirname, '..', 'data', 'stack_and_smash');
const demoTemplate = fs.readFileSync(path.join(DEMO_DATA_DIR, 'oneflow.txt'), 'utf8');

function buildDemoSystemPrompt() {
  return demoTemplate.trim();
}

module.exports = { buildSystemPrompt, reloadMenu, buildDemoSystemPrompt };
