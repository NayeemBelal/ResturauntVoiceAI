require('dotenv').config();

const express = require('express');
const Stripe = require('stripe');
const { loadSecrets, getSecrets } = require('./secrets');
const { createUltravoxCall } = require('./ultravox');
const { createCheckoutSession, sendSMS, pendingOrders } = require('./checkout');
const { createOrder: createCloverOrder, markOrderPaid, printTicket, getBusinessAddress, getBusinessHours } = require('./clover');
const {
  getRestaurantByVoiceNumber,
  upsertCustomer,
  updateCustomerName,
  createConversation,
  getActiveConversation,
  completeStaleConversations,
  updateCart,
  updateOrderPlaced,
  completeConversation,
} = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

function getStripe() {
  return new Stripe(getSecrets().stripeSecretKey);
}

// In-memory call state: callerPhone → { restaurantId, posMerchantId, conversationId, customerId, customerFirstName, customerLastName, cart }
const activeCalls = new Map();

function normalizeNamePart(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeModifiers(modifiers = []) {
  return modifiers
    .map(mod => ({
      mod_id: mod.mod_id,
      name: mod.name,
      price_cents: mod.price_cents,
    }))
    .sort((a, b) => a.mod_id.localeCompare(b.mod_id));
}

function normalizeCartItem(item) {
  return {
    item_id: item.item_id,
    name: item.name,
    quantity: item.quantity,
    price_cents: item.price_cents,
    modifiers: normalizeModifiers(item.modifiers ?? []),
  };
}

function getModifierKey(modifiers = []) {
  return normalizeModifiers(modifiers).map(mod => mod.mod_id).join('|');
}

function findCartLineIndex(cart, item) {
  const targetModifierKey = getModifierKey(item.modifiers ?? []);
  return cart.findIndex(line => (
    line.item_id === item.item_id &&
    getModifierKey(line.modifiers ?? []) === targetModifierKey
  ));
}

function parseResumeCart(currentCart) {
  if (!Array.isArray(currentCart)) return [];
  return currentCart.map(normalizeCartItem);
}

// Stripe webhook must receive the raw body — register BEFORE json/urlencoded parsers
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = getStripe().webhooks.constructEvent(req.body, sig, getSecrets().stripeWebhookSecret);
  } catch (err) {
    console.error('Stripe webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  res.sendStatus(200);

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const pending = pendingOrders.get(session.id);

    if (!pending) {
      console.warn('No pending order found for session:', session.id);
      return;
    }

    const { items, callerPhone, orderId, conversationId, posMerchantId } = pending;
    pendingOrders.delete(session.id);

    const amountCents = items.reduce((sum, item) => {
      const modTotal = (item.modifiers ?? []).reduce((s, m) => s + m.price_cents, 0);
      return sum + (item.price_cents + modTotal) * item.quantity;
    }, 0);

    try {
      console.log('Payment received, creating Clover order...');
      const cloverOrderId = await createCloverOrder(items, posMerchantId);
      console.log('Clover order created:', cloverOrderId);

      await markOrderPaid(cloverOrderId, amountCents, posMerchantId);
      console.log('Order marked as paid:', cloverOrderId);

      await printTicket(cloverOrderId, posMerchantId);
      console.log('Ticket print sent for:', cloverOrderId);

      await updateOrderPlaced(orderId, cloverOrderId);
      await completeConversation(conversationId);
      console.log('DB order updated and conversation closed');

      await sendSMS(callerPhone, 'Your order has been received and printed at the restaurant. See you soon!');
      console.log('Confirmation SMS sent to', callerPhone);
    } catch (err) {
      console.error('Post-payment fulfillment error:', err.message);
    }
  }
});

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.send('Restaurant Voice AI server is running.');
});

// Telnyx TeXML webhook — fires when an inbound call arrives
app.post('/incoming', async (req, res) => {
  const callerPhone = req.body.From || req.body.from;
  const calledNumber = req.body.To || req.body.to;
  console.log('Incoming call from:', callerPhone, 'to:', calledNumber);

  try {
    const restaurant = await getRestaurantByVoiceNumber(calledNumber);
    const customer = await upsertCustomer(callerPhone);
    await completeStaleConversations(restaurant.id, customer.id);

    const existingConversation = await getActiveConversation(restaurant.id, customer.id);
    const resumeCart = parseResumeCart(existingConversation?.current_cart);
    const conversation = existingConversation ?? await createConversation(restaurant.id, customer.id);

    activeCalls.set(callerPhone, {
      restaurantId: restaurant.id,
      posMerchantId: restaurant.pos_merchant_id,
      conversationId: conversation.id,
      customerId: customer.id,
      customerFirstName: normalizeNamePart(customer.first_name),
      customerLastName: normalizeNamePart(customer.last_name),
      cart: resumeCart,
    });

    console.log(`Call context set — restaurant: ${restaurant.name}, conversation: ${conversation.id}, resumed cart items: ${resumeCart.length}`);

    const joinUrl = await createUltravoxCall(callerPhone, restaurant.pos_merchant_id, {
      resumeCart,
      customerFirstName: normalizeNamePart(customer.first_name),
      customerLastName: normalizeNamePart(customer.last_name),
    });
    console.log('Ultravox joinUrl:', joinUrl);

    res.type('text/xml').send(buildTeXML(joinUrl));
  } catch (err) {
    console.error('Failed to set up call:', err.message);
    res.type('text/xml').send(errorTeXML());
  }
});

app.post('/tool/business-address', async (req, res) => {
  try {
    res.json(await getBusinessAddress());
  } catch (err) {
    console.error('getBusinessAddress error:', err.message);
    res.status(500).json({ error: 'Could not retrieve address.' });
  }
});

app.post('/tool/business-hours', async (req, res) => {
  try {
    res.json(await getBusinessHours());
  } catch (err) {
    console.error('getBusinessHours error:', err.message);
    res.status(500).json({ error: 'Could not retrieve hours.' });
  }
});

app.post('/tool/customer-name/:callerPhone', async (req, res) => {
  const callerPhone = decodeURIComponent(req.params.callerPhone);
  const callContext = activeCalls.get(callerPhone);

  if (!callContext) {
    return res.status(500).json({ result: 'Call context not found. Please try again.' });
  }

  const firstName = normalizeNamePart(req.body.firstName);
  const lastName = normalizeNamePart(req.body.lastName);

  if (!firstName || !lastName) {
    return res.status(400).json({ result: 'Both first and last name are required.' });
  }

  try {
    const customer = await updateCustomerName(callContext.customerId, firstName, lastName);
    callContext.customerFirstName = normalizeNamePart(customer.first_name);
    callContext.customerLastName = normalizeNamePart(customer.last_name);
    res.json({ result: `Saved customer name as ${callContext.customerFirstName} ${callContext.customerLastName}.` });
  } catch (err) {
    console.error('saveCustomerName error:', err.message);
    res.status(500).json({ result: 'Could not save the customer name. Please try again.' });
  }
});

app.post('/tool/cart/add/:callerPhone', async (req, res) => {
  const callerPhone = decodeURIComponent(req.params.callerPhone);
  const { item } = req.body;
  const callContext = activeCalls.get(callerPhone);

  if (!callContext) {
    return res.status(500).json({ result: 'Call context not found. Please try again.' });
  }

  if (!item || !item.item_id || !item.name || !Number.isInteger(item.quantity) || item.quantity <= 0 || !Number.isInteger(item.price_cents)) {
    return res.status(400).json({ result: 'Invalid cart item payload.' });
  }

  try {
    const normalizedItem = normalizeCartItem(item);
    const cart = [...callContext.cart];
    const existingIndex = findCartLineIndex(cart, normalizedItem);

    if (existingIndex >= 0) {
      cart[existingIndex] = {
        ...cart[existingIndex],
        quantity: cart[existingIndex].quantity + normalizedItem.quantity,
      };
    } else {
      cart.push(normalizedItem);
    }

    callContext.cart = cart;
    await updateCart(callContext.conversationId, cart);

    res.json({ result: `Added to cart. Current items: ${cart.length}.` });
  } catch (err) {
    console.error('addToCart error:', err.message);
    res.status(500).json({ result: 'Could not update the cart. Please try again.' });
  }
});

app.post('/tool/cart/remove/:callerPhone', async (req, res) => {
  const callerPhone = decodeURIComponent(req.params.callerPhone);
  const { item } = req.body;
  const callContext = activeCalls.get(callerPhone);

  if (!callContext) {
    return res.status(500).json({ result: 'Call context not found. Please try again.' });
  }

  if (!item || !item.item_id || !Number.isInteger(item.quantity) || item.quantity <= 0 || !Array.isArray(item.modifiers)) {
    return res.status(400).json({ result: 'Invalid cart item payload.' });
  }

  try {
    const cart = [...callContext.cart];
    const lineIndex = findCartLineIndex(cart, item);

    if (lineIndex === -1) {
      return res.status(404).json({ result: 'That item is not in the cart.' });
    }

    const line = cart[lineIndex];
    if (item.quantity >= line.quantity) {
      cart.splice(lineIndex, 1);
    } else {
      cart[lineIndex] = { ...line, quantity: line.quantity - item.quantity };
    }

    callContext.cart = cart;
    await updateCart(callContext.conversationId, cart);

    res.json({ result: 'Updated cart.' });
  } catch (err) {
    console.error('removeFromCart error:', err.message);
    res.status(500).json({ result: 'Could not update the cart. Please try again.' });
  }
});

app.post('/tool/cart/clear/:callerPhone', async (req, res) => {
  const callerPhone = decodeURIComponent(req.params.callerPhone);
  const callContext = activeCalls.get(callerPhone);

  if (!callContext) {
    return res.status(500).json({ result: 'Call context not found. Please try again.' });
  }

  try {
    callContext.cart = [];
    await updateCart(callContext.conversationId, []);
    res.json({ result: 'Cart cleared. You can start a new order now.' });
  } catch (err) {
    console.error('clearCart error:', err.message);
    res.status(500).json({ result: 'Could not clear the cart. Please try again.' });
  }
});

// Ultravox tool callback — fires when the AI invokes sendCheckoutLink
app.post('/tool/send-checkout/:callerPhone', async (req, res) => {
  const callerPhone = decodeURIComponent(req.params.callerPhone);
  console.log('Checkout tool called for:', callerPhone);

  const callContext = activeCalls.get(callerPhone);
  if (!callContext) {
    console.error('No active call context for:', callerPhone);
    return res.status(500).json({ result: 'Call context not found. Please try again.' });
  }

  try {
    const checkoutUrl = await createCheckoutSession(callContext.cart, callerPhone, callContext);
    await sendSMS(callerPhone, `Here's your checkout link to complete your order: ${checkoutUrl}`);
    console.log('Checkout SMS sent to', callerPhone);
    res.json({ result: 'Checkout link sent via SMS successfully.' });
  } catch (err) {
    console.error('Checkout tool error:', err.message);
    res.status(500).json({ result: err.message || 'Failed to send checkout link. Please try again.' });
  }
});

// Stripe redirect pages
app.get('/payment/success', (req, res) => {
  res.send('Payment successful! Thank you for your order.');
});

app.get('/payment/cancel', (req, res) => {
  res.send('Payment cancelled. Please call us back if you need help.');
});

function buildTeXML(joinUrl) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream
      url="${joinUrl}"
      bidirectionalMode="rtp"
      codec="L16"
      bidirectionalCodec="L16"
      bidirectionalSamplingRate="16000"
    />
  </Connect>
</Response>`;
}

function errorTeXML() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Sorry, we are having technical difficulties. Please call back shortly.</Say>
  <Hangup/>
</Response>`;
}

loadSecrets().then(() => {
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Webhook URL: http://localhost:${PORT}/incoming`);
  });
}).catch(err => {
  console.error('Failed to load secrets:', err.message);
  process.exit(1);
});
