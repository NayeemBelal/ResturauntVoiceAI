const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data', 'lime_n_dime');

const template = fs.readFileSync(path.join(DATA_DIR, 'oneflow.txt'), 'utf8');
const businessLogic = fs.readFileSync(path.join(DATA_DIR, 'business_logic.txt'), 'utf8');
const menu = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'menu.json'), 'utf8'));

function buildSystemPrompt(callContext = {}) {
  const {
    resumeCart = [],
    customerFirstName = '',
    customerLastName = '',
  } = callContext;
  let prompt = template
    .replace('{business_logic}', businessLogic.trim())
    .replace('{menu}', JSON.stringify(menu, null, 2));

  const hasFirstName = typeof customerFirstName === 'string' && customerFirstName.trim().length > 0;
  const hasLastName = typeof customerLastName === 'string' && customerLastName.trim().length > 0;

  if (hasFirstName) {
    prompt += `\n\nRETURNING CALLER:\nThis caller already has a saved first name: ${customerFirstName.trim()}.\nAt the very start of the call, greet them once by first name in a natural way, like a familiar restaurant regular, then move straight into helping them. Do not repeat the personalized welcome later in the call.`;
  }

  if (!hasFirstName || !hasLastName) {
    const missingParts = [];
    if (!hasFirstName) missingParts.push('first name');
    if (!hasLastName) missingParts.push('last name');
    prompt += `\n\nCUSTOMER NAME CAPTURE:\nBefore sending the checkout link, collect the customer's ${missingParts.join(' and ')} and have them spell it clearly. After you have both first and last name, call saveCustomerName before calling sendCheckoutLink. If saveCustomerName fails, correct the name and retry before sending checkout.`;
  } else {
    prompt += `\n\nCUSTOMER NAME CAPTURE:\nThis caller already has a saved full name. Do not ask them to re-spell it unless they explicitly ask to correct it. If they volunteer a correction, call saveCustomerName with the updated first and last name before checkout.`;
  }

  if (resumeCart.length > 0) {
    const lines = resumeCart.map(item => {
      const modifiers = item.modifiers ?? [];
      const modNames = modifiers.map(mod => mod.name).join(', ');
      const unitTotal = (item.price_cents + modifiers.reduce((sum, mod) => sum + mod.price_cents, 0)) / 100;
      const displayName = modNames ? `${item.name} (${modNames})` : item.name;
      return `- ${displayName} x${item.quantity} - $${(unitTotal * item.quantity).toFixed(2)}`;
    }).join('\n');

    prompt += `\n\nRESUMED CALL - EXISTING CART:\nThis customer's call was dropped and they already have items in their cart. Their saved cart:\n${lines}\n\nAt the start of the call, you must tell them they already have an order in progress and briefly mention that you still have their saved cart. Then ask whether they want to continue that order or clear it and start over. Do this before taking any new items. If they want to start over, call clearCart immediately before taking the new order. Do not tell them the cart is cleared unless clearCart succeeds. If clearCart fails, say there was a problem clearing it and retry. Do not ignore the existing cart or act like this is a brand new order.`;
  }

  return prompt;
}

module.exports = { buildSystemPrompt };
