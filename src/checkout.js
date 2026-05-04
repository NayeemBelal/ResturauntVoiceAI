const Stripe = require('stripe');
const { verifyItems } = require('./clover');
const { createOrder: createDbOrder, cancelOpenOrdersForConversation } = require('./db');
const { getSecrets } = require('./secrets');

function getStripe() {
  return new Stripe(getSecrets().stripeSecretKey);
}

// In-memory store: stripeSessionId → { items, callerPhone, orderId, conversationId, posMerchantId }
const pendingOrders = new Map();

async function createCheckoutSession(items, callerPhone, callContext) {
  const { restaurantId, customerId, conversationId, posMerchantId } = callContext;
  const { serverUrl } = getSecrets();

  if (!items || items.length === 0) {
    throw new Error('Your cart is empty. Please add items before checking out.');
  }

  // Bug B: cancel any prior open orders for this conversation before creating a new session.
  // Scoped to conversation_id only — never touches orders from other calls.
  await cancelOpenOrdersForConversation(conversationId);
  console.log(`Cancelled prior open orders for conversation ${conversationId}`);

  // Step 1: Verify items/modifiers against Clover
  const { valid, error, verifiedItems } = await verifyItems(items, posMerchantId);
  if (!valid) throw new Error(error);

  // Step 2: Build Stripe line items using verified (Clover-corrected) prices
  const lineItems = verifiedItems.map(item => {
    const modTotal = (item.modifiers ?? []).reduce((sum, m) => sum + m.price_cents, 0);
    const unitAmount = item.price_cents + modTotal;

    const modNames = (item.modifiers ?? []).map(m => m.name).filter(Boolean);
    const notePart = item.note ? ` — ${item.note}` : '';
    const displayName = modNames.length > 0
      ? `${item.name} (${modNames.join(', ')})${notePart}`
      : `${item.name}${notePart}`;

    return {
      price_data: {
        currency: 'usd',
        product_data: { name: displayName },
        unit_amount: unitAmount,
      },
      quantity: item.quantity,
    };
  });

  const session = await getStripe().checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: lineItems,
    mode: 'payment',
    success_url: `${serverUrl}/payment/success`,
    cancel_url: `${serverUrl}/payment/cancel`,
  });

  // Step 3: Persist the order to the database (status='open')
  const order = await createDbOrder(restaurantId, customerId, conversationId, session.id, verifiedItems);

  // Step 4: Store everything the Stripe webhook needs to fulfill the order
  pendingOrders.set(session.id, {
    items: verifiedItems,
    callerPhone,
    calledNumber: callContext.calledNumber,
    orderId: order.id,
    conversationId,
    posMerchantId,
  });

  return session.url;
}

async function sendSMS(to, body, fromNumber) {
  const { telnyxApiKey } = getSecrets();

  const response = await fetch('https://api.telnyx.com/v2/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${telnyxApiKey}`,
    },
    body: JSON.stringify({ from: fromNumber, to, text: body }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Telnyx SMS error ${response.status}: ${error}`);
  }

  return response.json();
}

module.exports = { createCheckoutSession, sendSMS, pendingOrders };
