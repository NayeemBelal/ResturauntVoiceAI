require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const Stripe = require('stripe');
const { loadSecrets, getSecrets } = require('./secrets');
const { loadRestaurantConfigs, getRestaurantConfig, getFirstRestaurantConfig } = require('./restaurant-configs');
const { createUltravoxCall, createDemoUltravoxCall, fetchCallTranscript } = require('./ultravox');
const { reloadMenu } = require('./prompt');
const { createCheckoutSession, sendSMS, pendingOrders } = require('./checkout');
const { createOrder: createCloverOrder, markOrderPaid, printTicket, getBusinessAddress } = require('./clover');
// google_places direct calls removed — hours now proxied through TextToOrder backend
const {
  getRestaurantByVoiceNumber,
  upsertCustomer,
  updateCustomerName,
  createConversation,
  getActiveConversation,
  completeStaleConversations,
  updateCart,
  updateOrderPlaced,
  getOrderByStripeSessionId,
  getOpenVoiceConversationByPhone,
  updateConversationOutcome,
  setNoOutcomeIfNull,
  completeConversation,
  getRestaurantFAQs,
  getUpsellRules,
  setConversationUltravoxCallId,
  saveCallTranscript,
} = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

async function fetchAndStoreTranscript(ultravoxCallId, conversationId) {
  // Wait for Ultravox to finalize the transcript before fetching
  await new Promise(resolve => setTimeout(resolve, 5000));
  const results = await fetchCallTranscript(ultravoxCallId);
  await saveCallTranscript(conversationId, results);
}


const MENU_PATH = path.join(__dirname, '..', 'data', 'lime_n_dime', 'menu.json');
const BACKEND_URL = (process.env.BACKEND_URL || 'http://localhost:8000').replace(/\/$/, '');

// Build a flat mod_id → { name, price_cents } lookup from the unified menu JSON.
// Iterates per-item modifier_groups (new format) rather than a top-level shared list.
let modifierLookup = {};

function buildModifierLookup(menuData) {
  const lookup = {};
  if (menuData.shared_modifier_groups) {
    // Compressed format — modifiers live in shared_modifier_groups
    for (const group of Object.values(menuData.shared_modifier_groups)) {
      for (const mod of (group.modifiers ?? [])) {
        lookup[mod.mod_id] = {
          name: mod.mod_name,
          price_cents: Math.round((mod.price ?? 0) * 100),
        };
      }
    }
  } else {
    // Raw format — modifiers are embedded per item
    for (const item of (menuData.items ?? [])) {
      for (const group of (item.modifier_groups ?? [])) {
        for (const mod of (group.modifiers ?? [])) {
          lookup[mod.mod_id] = {
            name: mod.mod_name,
            price_cents: mod.price_cents ?? Math.round((mod.price ?? 0) * 100),
          };
        }
      }
    }
  }
  return lookup;
}

async function getRestaurantId() {
  const config = getFirstRestaurantConfig();
  if (!config?.telnyx_phone_number) throw new Error('No restaurant config with telnyx_phone_number found');
  const restaurant = await getRestaurantByVoiceNumber(config.telnyx_phone_number);
  return restaurant.id;
}

async function refreshMenu() {
  try {
    const restaurantId = await getRestaurantId();
    const res = await fetch(`${BACKEND_URL}/api/menu-json?restaurant_id=${restaurantId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const menuData = await res.json();
    modifierLookup = buildModifierLookup(menuData);
    reloadMenu(menuData);
    const compressed = require('./menu-compress').compressMenu(menuData);
    fs.writeFileSync(MENU_PATH, JSON.stringify(compressed, null, 2), 'utf8');
    console.log(`[menu] Refreshed — ${menuData.items?.length ?? 0} available items`);
  } catch (err) {
    console.error('[menu] Refresh failed:', err.message);
  }
}

// Load menu from disk on startup (populated by refreshMenu or existing file)
if (fs.existsSync(MENU_PATH)) {
  try {
    const menuData = JSON.parse(fs.readFileSync(MENU_PATH, 'utf8'));
    modifierLookup = buildModifierLookup(menuData);
    console.log(`[menu] Loaded from disk — ${menuData.items?.length ?? 0} items`);
  } catch (err) {
    console.warn('[menu] Could not parse existing menu.json:', err.message);
  }
}

function getStripe() {
  return new Stripe(getSecrets().stripeSecretKey);
}

const DEMO_PHONE_NUMBER = '+18554852690';

const DEMO_MODIFIER_LOOKUP = {
  'combo-001': { name: 'Cajun Fries + Drink', price_cents: 399 },
};

// In-memory call state: callerPhone → { restaurantId, posMerchantId, conversationId, customerId, customerFirstName, customerLastName, callSid, calledNumber, cart, isDemo }
const activeCalls = new Map();

// Deduplication: callSids currently being processed. Set synchronously before the first await
// so concurrent duplicate webhooks from Telnyx can't both race through and create two sessions.
const processingCallSids = new Set();

// In-memory demo checkout sessions: sessionId → { items, subtotalCents }
const demoSessions = new Map();

function normalizeNamePart(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeModifiers(modifiers = []) {
  return modifiers
    .map(mod => {
      const resolved = modifierLookup[mod.mod_id] || DEMO_MODIFIER_LOOKUP[mod.mod_id];
      return {
        mod_id: mod.mod_id,
        name: resolved ? resolved.name : (mod.name && mod.name !== mod.mod_id ? mod.name : ''),
        price_cents: resolved ? resolved.price_cents : (mod.price_cents ?? 0),
      };
    })
    .sort((a, b) => a.mod_id.localeCompare(b.mod_id));
}

function normalizeCartItem(item) {
  return {
    item_id: item.item_id,
    name: item.name,
    quantity: item.quantity,
    price_cents: item.price_cents,
    modifiers: normalizeModifiers(item.modifiers ?? []),
    note: item.note ?? null,
  };
}

function getModifierKey(modifiers = [], note = '') {
  return normalizeModifiers(modifiers).map(mod => mod.mod_id).join('|') + '|note:' + (note || '');
}

function findCartLineIndex(cart, item) {
  const targetModifierKey = getModifierKey(item.modifiers ?? [], item.note ?? '');
  return cart.findIndex(line => (
    line.item_id === item.item_id &&
    getModifierKey(line.modifiers ?? [], line.note ?? '') === targetModifierKey
  ));
}

function parseResumeCart(currentCart) {
  if (!Array.isArray(currentCart)) return [];
  return currentCart.map(normalizeCartItem);
}

function formatCartLine(line) {
  const modifierNames = (line.modifiers ?? []).map(mod => mod.name).filter(Boolean);
  const notePart = line.note ? ` — ${line.note}` : '';
  const displayName = modifierNames.length > 0
    ? `${line.name} (${modifierNames.join(', ')})${notePart}`
    : `${line.name}${notePart}`;
  const unitPriceCents = line.price_cents + (line.modifiers ?? []).reduce((sum, mod) => sum + mod.price_cents, 0);
  return {
    itemName: line.name,
    displayName,
    quantity: line.quantity,
    modifiers: modifierNames,
    unitPriceCents: unitPriceCents,
    lineTotalCents: unitPriceCents * line.quantity,
  };
}

function buildCartSnapshot(cart = []) {
  const lines = cart.map(formatCartLine);
  const subtotalCents = lines.reduce((sum, line) => sum + line.lineTotalCents, 0);
  return {
    lineCount: lines.length,
    itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
    subtotalCents,
    subtotalDollars: (subtotalCents / 100).toFixed(2),
    lines,
  };
}

async function transferLiveCall(callSid, destinationNumber, fromNumber) {
  const { telnyxApiKey } = getSecrets();
  const to = decodeURIComponent(destinationNumber);
  const response = await fetch(`https://api.telnyx.com/v2/calls/${encodeURIComponent(callSid)}/actions/transfer`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${telnyxApiKey}`,
    },
    body: JSON.stringify({
      to,
      from: fromNumber,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Telnyx transfer failed ${response.status}: ${errorText}`);
  }

  return response.json();
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
    console.log('Stripe checkout.session.completed:', session.id);

    let pending = pendingOrders.get(session.id);
    pendingOrders.delete(session.id);

    // Bug C: if the server restarted and lost in-memory state, recover from the DB.
    if (!pending) {
      console.warn('pendingOrders miss for session:', session.id, '— recovering from DB');
      try {
        const dbOrder = await getOrderByStripeSessionId(session.id);
        if (!dbOrder) {
          console.error('No order found in DB for Stripe session:', session.id);
          return;
        }
        if (dbOrder.status === 'placed') {
          console.log('Order already placed (duplicate webhook?), skipping:', dbOrder.id);
          return;
        }
        // We have no items/callerPhone/posMerchantId — mark placed with Stripe session as reference.
        // Clover order creation requires the original items, so skip it here and just close the DB record.
        await updateOrderPlaced(dbOrder.id, `stripe_${session.id}`);
        await completeConversation(dbOrder.conversation_id);
        console.log('DB-recovered order marked placed:', dbOrder.id);
      } catch (err) {
        console.error('DB recovery error for session', session.id, ':', err.message);
      }
      return;
    }

    const { items, callerPhone, calledNumber, orderId, conversationId, posMerchantId } = pending;

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
      await updateConversationOutcome(conversationId, { callOutcome: 'order-intent' });
      await completeConversation(conversationId);
      console.log('DB order updated and conversation closed');

      await sendSMS(callerPhone, 'Your order has been received and printed at the restaurant. See you soon!', calledNumber);
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

// TeXML statusCallback — Telnyx POSTs here when the call completes.
// Receives CallSid, CallStatus, CallDuration (seconds), From, To.
app.post('/call-status', express.urlencoded({ extended: false }), express.json(), async (req, res) => {
  res.sendStatus(200);

  const body = req.body ?? {};
  const callStatus = body.CallStatus ?? body.call_status;
  const callerPhone = body.From ?? body.from;
  const durationSeconds = body.CallDuration != null ? parseInt(body.CallDuration, 10) : null;

  console.log('[call-status] received — CallStatus:', callStatus, '| From:', callerPhone, '| CallDuration:', durationSeconds, '| full body:', JSON.stringify(body));

  if (callStatus !== 'completed') return;

  const mapContext = activeCalls.get(callerPhone);
  const isDemo = mapContext?.isDemo ?? false;

  console.log('[call-status] map hit:', !!mapContext, '| isDemo:', isDemo);

  if (!isDemo) {
    try {
      let conversationId = mapContext?.conversationId;
      if (!conversationId) {
        console.log('[call-status] map miss — querying DB for open voice conversation, phone:', callerPhone);
        const conv = await getOpenVoiceConversationByPhone(callerPhone);
        console.log('[call-status] DB query result:', JSON.stringify(conv));
        conversationId = conv?.id ?? null;
      }

      console.log('[call-status] resolved conversationId:', conversationId);

      if (conversationId) {
        const updates = { callEndedAt: new Date().toISOString() };
        if (durationSeconds != null && !isNaN(durationSeconds)) updates.durationSeconds = durationSeconds;
        console.log('[call-status] writing updates:', JSON.stringify(updates));
        await updateConversationOutcome(conversationId, updates);
        await setNoOutcomeIfNull(conversationId);
        console.log('[call-status] DB update SUCCESS for conversationId:', conversationId);
        const uvCallId = mapContext?.ultravoxCallId;
        if (uvCallId) {
          fetchAndStoreTranscript(uvCallId, conversationId).catch(err =>
            console.error('[call-status] transcript fetch failed:', err.message)
          );
        }
      } else {
        console.warn('[call-status] WARN: no conversation found for caller:', callerPhone);
      }
    } catch (err) {
      console.error('[call-status] ERROR:', err.message, err.stack);
    }
  }

  if (mapContext) activeCalls.delete(callerPhone);
});

// Telnyx call-lifecycle events (call.hangup, etc.)
// Configure this URL in Telnyx Dashboard → Connections → Outbound Voice Profile → Webhooks
app.post('/telnyx/events', express.json(), async (req, res) => {
  res.sendStatus(200); // ack immediately

  const data = req.body?.data;
  if (!data) {
    console.log('[telnyx/events] WARN: received request with no data field. body keys:', Object.keys(req.body ?? {}));
    return;
  }

  const eventType = data.event_type;
  const payload = data.payload ?? {};
  console.log('[telnyx/events] event_type:', eventType, '| payload keys:', Object.keys(payload));

  if (eventType === 'call.hangup') {
    console.log('[telnyx/events] HANGUP full payload:', JSON.stringify(payload));

    const callerPhone = payload.from;
    const durationSeconds = payload.call_duration_secs ?? payload.call_duration ?? null;

    console.log('[telnyx/events] hangup — callerPhone:', callerPhone, '| durationSeconds:', durationSeconds, '| activeCalls keys:', [...activeCalls.keys()]);

    const mapContext = activeCalls.get(callerPhone);
    const isDemo = mapContext?.isDemo ?? false;

    console.log('[telnyx/events] map hit:', !!mapContext, '| isDemo:', isDemo, '| mapContext.conversationId:', mapContext?.conversationId ?? 'none');

    if (!isDemo) {
      try {
        let conversationId = mapContext?.conversationId;
        if (!conversationId) {
          console.log('[telnyx/events] map miss — querying DB for open voice conversation for phone:', callerPhone);
          const conv = await getOpenVoiceConversationByPhone(callerPhone);
          console.log('[telnyx/events] DB query result:', JSON.stringify(conv));
          conversationId = conv?.id ?? null;
        }

        console.log('[telnyx/events] resolved conversationId:', conversationId);

        if (conversationId) {
          const now = new Date().toISOString();
          const updates = { callEndedAt: now };
          if (durationSeconds != null) updates.durationSeconds = Math.round(durationSeconds);
          console.log('[telnyx/events] writing updates to DB:', JSON.stringify(updates));
          await updateConversationOutcome(conversationId, updates);
          await setNoOutcomeIfNull(conversationId);
          console.log('[telnyx/events] DB update SUCCESS for conversationId:', conversationId);
          const uvCallId = mapContext?.ultravoxCallId;
          if (uvCallId) {
            fetchAndStoreTranscript(uvCallId, conversationId).catch(err =>
              console.error('[telnyx/events] transcript fetch failed:', err.message)
            );
          }
        } else {
          console.warn('[telnyx/events] WARN: no conversation found for caller:', callerPhone, '— duration not recorded');
        }
      } catch (err) {
        console.error('[telnyx/events] ERROR during outcome update:', err.message, err.stack);
      }
    } else {
      console.log('[telnyx/events] demo call ended, skipping DB update');
    }

    if (mapContext) activeCalls.delete(callerPhone);
  }
});

async function handleDemoCall(res, callerPhone, calledNumber, callSid) {
  const conversationId = `demo_${Date.now()}_${callerPhone}`;

  activeCalls.set(callerPhone, {
    restaurantId: 'demo',
    posMerchantId: null,
    conversationId,
    customerId: null,
    customerFirstName: '',
    customerLastName: '',
    callSid,
    calledNumber,
    transferPhoneNumber: null,
    cart: [],
    isDemo: true,
  });

  console.log(`[demo] Call context set — caller: ${callerPhone}, conversationId: ${conversationId}`);

  try {
    const { joinUrl } = await createDemoUltravoxCall(callerPhone);
    console.log('[demo] Ultravox joinUrl obtained successfully');
    res.type('text/xml').send(buildTeXML(joinUrl));
  } catch (err) {
    console.error('[demo] Failed to create Ultravox call:', err.message, err.stack);
    activeCalls.delete(callerPhone);
    res.type('text/xml').send(errorTeXML());
  }
}

// Bounded by number of restaurants. Lazy expiry on read — no background timer.
const _hoursCache = new Map(); // restaurantId → { text: string, expiresAt: ms }
const HOURS_TTL_MS = 60 * 60 * 1000;

// Fetch and format business hours from the TextToOrder backend for prompt injection.
// Returns a plain-text string with full weekly hours and today's last-order cutoff.
async function fetchHoursText(restaurantId) {
  const cached = _hoursCache.get(restaurantId);
  if (cached && Date.now() < cached.expiresAt) return cached.text;

  try {
    const apiRes = await fetch(`${BACKEND_URL}/api/business-hours?restaurant_id=${restaurantId}`);
    if (!apiRes.ok) throw new Error(`HTTP ${apiRes.status}`);
    const data = await apiRes.json();

    const hours = data.hoursOverride ?? data.googleHours ?? {};
    const tz = data.timezone || 'UTC';

    if (!hours || !Object.keys(hours).length) {
      _hoursCache.set(restaurantId, { text: '', expiresAt: Date.now() + HOURS_TTL_MS });
      return '';
    }

    const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

    const lines = DAYS.map(day => {
      const h = hours[day];
      if (!h || h.toLowerCase() === 'closed') return `${day.charAt(0).toUpperCase() + day.slice(1)}: Closed`;
      return `${day.charAt(0).toUpperCase() + day.slice(1)}: ${h}`;
    });

    // Compute today's last-order cutoff (15 min before close)
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
    const todayDay = DAYS[now.getDay() === 0 ? 6 : now.getDay() - 1];
    const todayHours = hours[todayDay] || '';
    let cutoffNote = '';
    const match = todayHours.match(/[-–]\s*(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
    if (match) {
      const [hh, rest] = match[1].split(':');
      const [mm, period] = rest.trim().split(/\s+/);
      let h = parseInt(hh, 10);
      const m = parseInt(mm, 10);
      if (period?.toUpperCase() === 'PM' && h !== 12) h += 12;
      if (period?.toUpperCase() === 'AM' && h === 12) h = 0;
      // Handle midnight (0:00) — treat as 24:00 so subtraction doesn't go negative
      const closeMinutes = (h === 0 ? 24 * 60 : h * 60) + m;
      const cutoffMin = closeMinutes - 15;
      const ch = Math.floor(cutoffMin / 60) % 24;
      const cm = cutoffMin % 60;
      const cp = ch >= 12 ? 'PM' : 'AM';
      const ch12 = ch % 12 || 12;
      cutoffNote = `\nToday's last order cutoff: ${ch12}:${String(cm).padStart(2, '0')} ${cp} (15 minutes before closing). Do not accept new orders after this time.`;
    }

    const text = `Business hours (${tz}):\n${lines.join('\n')}${cutoffNote}`;
    _hoursCache.set(restaurantId, { text, expiresAt: Date.now() + HOURS_TTL_MS });
    return text;
  } catch (err) {
    // Don't cache errors — let the next call retry
    console.error('[fetchHoursText] error:', err.message);
    return '';
  }
}

// Telnyx TeXML webhook — fires when an inbound call arrives
app.post('/incoming', async (req, res) => {
  const callerPhone = req.body.From || req.body.from;
  const calledNumber = req.body.To || req.body.to;
  const callSid = req.body.CallSid || req.body.call_sid || req.body.callSid;
  console.log('[incoming] caller:', callerPhone, '| called:', calledNumber, '| demo:', calledNumber === DEMO_PHONE_NUMBER, '| body keys:', Object.keys(req.body || {}));

  if (calledNumber === DEMO_PHONE_NUMBER) {
    return handleDemoCall(res, callerPhone, calledNumber, callSid);
  }

  // Telnyx has at-least-once webhook delivery — guard against duplicate POSTs for the same call.
  // Use callSid as the dedup key (unique per call leg). This must be synchronous so two
  // concurrent requests can't both pass the check before either sets activeCalls.
  const dedupeKey = callSid || callerPhone;
  if (processingCallSids.has(dedupeKey) || activeCalls.has(callerPhone)) {
    console.log('[incoming] Duplicate webhook ignored — dedupeKey:', dedupeKey, '| callerPhone:', callerPhone);
    return res.sendStatus(200);
  }
  processingCallSids.add(dedupeKey);

  try {
    const t0 = Date.now();
    const restaurant = await getRestaurantByVoiceNumber(calledNumber);
    console.log(`[timing] getRestaurantByVoiceNumber: ${Date.now() - t0}ms`);

    const restaurantConfig = getRestaurantConfig(calledNumber);
    const rawTransferPhone = restaurant.forwarding_number || restaurantConfig?.transfer_phone_number || '';
    const transferPhoneNumber = rawTransferPhone ? decodeURIComponent(rawTransferPhone) : '';

    // Preload all context in parallel so the AI can speak immediately on connection
    const t1 = Date.now();
    const [customer, faqs, upsellRules, businessHours] = await Promise.all([
      upsertCustomer(callerPhone),
      getRestaurantFAQs(restaurant.id),
      getUpsellRules(restaurant.id),
      fetchHoursText(restaurant.id),
    ]);
    console.log(`[timing] context preload (parallel): ${Date.now() - t1}ms`);

    completeStaleConversations(restaurant.id, customer.id).catch(err =>
      console.error('[incoming] completeStaleConversations error:', err.message)
    );

    const existingConversation = await getActiveConversation(restaurant.id, customer.id);
    const conversation = existingConversation ?? await createConversation(restaurant.id, customer.id);
    const resumeCart = parseResumeCart(existingConversation?.current_cart);
    const resumedFromPrior = !!existingConversation && resumeCart.length > 0;

    // For resumed calls, fold the open-order notice into the greeting itself so the
    // AI says one continuous sentence instead of two separate turns (which causes a cutoff).
    const baseGreeting = restaurant.ai_greeting || `Hi, thanks for calling ${restaurant.name || 'us'}!`;
    const greeting = (resumedFromPrior && resumeCart.length > 0)
      ? `${baseGreeting.replace(/[?.!,]+$/, '')} — looks like you have an open order from earlier that hasn't been paid for yet. Want to continue it or start fresh?`
      : baseGreeting;

    const preloadedContext = {
      aiVoiceId: restaurant.ai_voice_id ?? null,
      greeting,
      customerFirstName: normalizeNamePart(customer.first_name),
      customerLastName: normalizeNamePart(customer.last_name),
      hasFullName: !!(customer.first_name?.trim() && customer.last_name?.trim()),
      businessHours: businessHours || null,
      faqs,
      upsellRules,
      resumeCart,
      resumedFromPrior,
    };

    const t2 = Date.now();
    const { joinUrl, callId: ultravoxCallId } = await createUltravoxCall(callerPhone, restaurant.pos_merchant_id, preloadedContext);
    console.log(`[timing] createUltravoxCall: ${Date.now() - t2}ms`);
    console.log(`[timing] total /incoming: ${Date.now() - t0}ms`);

    activeCalls.set(callerPhone, {
      restaurantId: restaurant.id,
      posMerchantId: restaurant.pos_merchant_id,
      aiGreeting: restaurant.ai_greeting ?? null,
      conversationId: conversation.id,
      customerId: customer.id,
      customerFirstName: normalizeNamePart(customer.first_name),
      customerLastName: normalizeNamePart(customer.last_name),
      callSid,
      calledNumber,
      transferPhoneNumber,
      cart: resumeCart,
      resumedFromPrior,
      ultravoxCallId,
    });

    if (ultravoxCallId && conversation?.id) {
      setConversationUltravoxCallId(conversation.id, ultravoxCallId).catch(err =>
        console.error('[incoming] failed to persist ultravox_call_id:', err.message)
      );
    }

    res.type('text/xml').send(buildTeXML(joinUrl));
    // activeCalls now covers deduplication for the rest of this call's lifecycle
    processingCallSids.delete(dedupeKey);
  } catch (err) {
    console.error('Failed to set up call:', err.message);
    processingCallSids.delete(dedupeKey); // allow Telnyx to retry on genuine failure
    res.type('text/xml').send(errorTeXML());
  }
});

// Mid-call refresh endpoint — context is now preloaded before the Ultravox session starts.
// Kept as a fallback in case the AI needs to refresh stale context during a call.
app.post('/tool/call-context/:callerPhone', async (req, res) => {
  const callerPhone = decodeURIComponent(req.params.callerPhone);
  const callContext = activeCalls.get(callerPhone);

  if (!callContext) {
    return res.status(500).json({ error: 'Call context not found.' });
  }

  try {
    const t0 = Date.now();
    const { restaurantId } = callContext;

    const [customer, faqs, upsellRules, businessHours] = await Promise.all([
      upsertCustomer(callerPhone),
      getRestaurantFAQs(restaurantId),
      getUpsellRules(restaurantId),
      fetchHoursText(restaurantId),
    ]);

    completeStaleConversations(restaurantId, customer.id).catch(err =>
      console.error('[call-context] completeStaleConversations error:', err.message)
    );

    const existingConversation = await getActiveConversation(restaurantId, customer.id);
    const conversation = existingConversation ?? await createConversation(restaurantId, customer.id);
    const resumeCart = parseResumeCart(existingConversation?.current_cart);

    callContext.customerId = customer.id;
    callContext.conversationId = conversation.id;
    callContext.customerFirstName = normalizeNamePart(customer.first_name);
    callContext.customerLastName = normalizeNamePart(customer.last_name);
    callContext.cart = resumeCart;
    callContext.resumedFromPrior = !!existingConversation && resumeCart.length > 0;

    console.log(`[call-context] resolved in ${Date.now() - t0}ms — customer: ${customer.id}, conversation: ${conversation.id}, resumeCart: ${resumeCart.length} items`);

    const hasFirstName = !!callContext.customerFirstName;
    const hasLastName = !!callContext.customerLastName;
    const { aiGreeting } = callContext;

    // Greeting is the restaurant's configured phrase, exactly as stored — no name injection.
    const greeting = aiGreeting || 'Hi, what can I get for you today?';

    res.json({
      greeting,
      customerFirstName: callContext.customerFirstName || null,
      customerLastName: callContext.customerLastName || null,
      hasFullName: hasFirstName && hasLastName,
      resumeCart,
      resumedFromPrior: callContext.resumedFromPrior,
      businessHours: businessHours || null,
      faqs,
      upsellRules,
    });
  } catch (err) {
    console.error('[call-context] error:', err.message);
    res.status(500).json({ error: 'Failed to load call context. Continue the call without personalization.' });
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
  console.log('[business-hours] tool called, body:', JSON.stringify(req.body));
  try {
    const callerPhone = req.body?.callerPhone;
    const callContext = callerPhone ? activeCalls.get(callerPhone) : null;
    const calledNumber = callContext?.calledNumber ?? process.env.TELNYX_PHONE_NUMBER;
    console.log('[business-hours] callerPhone:', callerPhone, '| calledNumber:', calledNumber);

    const config = getRestaurantConfig(calledNumber) ?? getFirstRestaurantConfig();
    console.log('[business-hours] restaurant config:', JSON.stringify(config));

    const restaurantId = config?.restaurant_id;
    if (!restaurantId) {
      console.error('[business-hours] no restaurant_id in config for calledNumber:', calledNumber);
      return res.status(500).json({ error: 'restaurant_id not configured for this restaurant.' });
    }

    console.log('[business-hours] fetching hours from backend for restaurant_id:', restaurantId);
    const apiRes = await fetch(`${BACKEND_URL}/api/business-hours?restaurant_id=${restaurantId}`);
    if (!apiRes.ok) throw new Error(`Backend returned HTTP ${apiRes.status}`);

    const data = await apiRes.json();
    console.log('[business-hours] result:', JSON.stringify(data));

    // Return in the same shape the AI prompt expects
    const hours = data.hoursOverride ?? data.googleHours ?? {};
    res.json({ hours, openNow: data.isOpen, unavailable: !Object.keys(hours).length });
  } catch (err) {
    console.error('[business-hours] error:', err.message, err.stack);
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

app.post('/tool/cart/get/:callerPhone', async (req, res) => {
  const callerPhone = decodeURIComponent(req.params.callerPhone);
  const callContext = activeCalls.get(callerPhone);

  if (!callContext) {
    return res.status(500).json({ result: 'Call context not found. Please try again.' });
  }

  const snapshot = buildCartSnapshot(callContext.cart);
  if (snapshot.lineCount === 0) {
    return res.json({
      result: 'The cart is currently empty.',
      cart: snapshot,
    });
  }

  return res.json({
    result: `Cart retrieved successfully. There are ${snapshot.lineCount} lines and ${snapshot.itemCount} total items.`,
    cart: snapshot,
  });
});

app.post('/tool/transfer-call/:callerPhone', async (req, res) => {
  const callerPhone = decodeURIComponent(req.params.callerPhone);
  const callContext = activeCalls.get(callerPhone);

  if (!callContext) {
    return res.status(500).json({ result: 'Call context not found. Please try again.' });
  }

  if (!callContext.transferPhoneNumber) {
    return res.status(500).json({ result: 'Transfer destination is not configured.' });
  }

  if (!callContext.callSid) {
    return res.status(500).json({ result: 'Live call identifier is missing, so transfer is unavailable.' });
  }

  try {
    await transferLiveCall(callContext.callSid, callContext.transferPhoneNumber, callContext.calledNumber);
    await updateConversationOutcome(callContext.conversationId, { callOutcome: 'forwarded' }).catch(() => {});
    res.json({ result: 'Transfer started successfully. Let the customer know they are being connected now.' });
  } catch (err) {
    console.error('transferCall error:', err.message);
    res.status(500).json({ result: 'Could not complete the transfer right now. Please apologize and offer to continue helping.' });
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
    if (!callContext.isDemo) await updateCart(callContext.conversationId, cart);
    const snapshot = buildCartSnapshot(cart);
    const addedLine = formatCartLine(normalizedItem);
    res.json({
      result: `Added ${addedLine.displayName}. Cart now has ${snapshot.lineCount} lines and ${snapshot.itemCount} total items.`,
      cart: snapshot,
    });
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
    if (!callContext.isDemo) await updateCart(callContext.conversationId, cart);
    const snapshot = buildCartSnapshot(cart);
    res.json({
      result: snapshot.lineCount === 0
        ? 'Updated cart. The cart is now empty.'
        : `Updated cart. Cart now has ${snapshot.lineCount} lines and ${snapshot.itemCount} total items.`,
      cart: snapshot,
    });
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

    if (!callContext.isDemo) {
      // If this conversation was resumed from a previous call (cart had items), clearing means
      // the user wants a fresh start — complete the old row and open a new conversation.
      if (callContext.resumedFromPrior) {
        console.log('[cart/clear] resumed conversation cleared — completing old row and creating new one:', callContext.conversationId);
        await completeConversation(callContext.conversationId);
        const newConv = await createConversation(callContext.restaurantId, callContext.customerId);
        callContext.conversationId = newConv.id;
        callContext.resumedFromPrior = false;
        console.log('[cart/clear] new conversation created:', newConv.id);
      } else {
        await updateCart(callContext.conversationId, []);
      }
    }

    res.json({
      result: 'Cart cleared. You can start a new order now.',
      cart: buildCartSnapshot([]),
    });
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
    await sendSMS(callerPhone, `Here's your checkout link to complete your order: ${checkoutUrl}`, callContext.calledNumber);
    console.log('Checkout SMS sent to', callerPhone);
    res.json({ result: 'Checkout link sent via SMS successfully.' });
  } catch (err) {
    console.error('Checkout tool error:', err.message);
    res.status(500).json({ result: err.message || 'Failed to send checkout link. Please try again.' });
  }
});

// Demo checkout tool — called by the AI for the demo restaurant
app.post('/tool/demo-send-checkout/:callerPhone', async (req, res) => {
  const callerPhone = decodeURIComponent(req.params.callerPhone);
  console.log('[demo] Checkout tool called for:', callerPhone);

  const callContext = activeCalls.get(callerPhone);
  if (!callContext?.isDemo) {
    return res.status(500).json({ result: 'Demo call context not found.' });
  }

  const cart = callContext.cart;
  if (!cart || cart.length === 0) {
    return res.status(400).json({ result: 'Your cart is empty. Please add items before checking out.' });
  }

  const subtotalCents = cart.reduce((sum, item) => {
    const modTotal = (item.modifiers ?? []).reduce((s, m) => s + m.price_cents, 0);
    return sum + (item.price_cents + modTotal) * item.quantity;
  }, 0);

  const sessionId = `demo_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  demoSessions.set(sessionId, { items: [...cart], subtotalCents });

  const { serverUrl } = getSecrets();
  const demoUrl = `${serverUrl}/demo/checkout/${sessionId}`;

  try {
    await sendSMS(callerPhone, `Here's your order summary from Stack & Smash Burgers: ${demoUrl}`, DEMO_PHONE_NUMBER);
    console.log('[demo] Checkout SMS sent to', callerPhone);
    res.json({ result: 'Demo checkout link sent via SMS successfully.' });
  } catch (err) {
    console.error('[demo] SMS error:', err.message);
    res.status(500).json({ result: 'Could not send the checkout link. Please try again.' });
  }
});

// Demo checkout page — renders a fake order summary with a disabled pay button
app.get('/demo/checkout/:sessionId', (req, res) => {
  const session = demoSessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).send('<h2>Order not found or expired.</h2>');
  }

  const { items, subtotalCents } = session;
  const subtotal = (subtotalCents / 100).toFixed(2);

  const rows = items.map(item => {
    const modTotal = (item.modifiers ?? []).reduce((s, m) => s + m.price_cents, 0);
    const lineTotal = ((item.price_cents + modTotal) * item.quantity / 100).toFixed(2);
    const modNames = (item.modifiers ?? []).map(m => m.name).filter(Boolean);
    const modLine = modNames.length > 0
      ? `<div class="mod-list">${modNames.map(n => escapeHtml(n)).join(', ')}</div>`
      : '';
    return `
      <div class="line-item">
        <div class="line-left">
          <span class="line-name">${escapeHtml(item.name)}</span>
          ${modLine}
          <span class="line-qty">Qty ${item.quantity}</span>
        </div>
        <div class="line-price">$${lineTotal}</div>
      </div>`;
  }).join('');

  res.type('text/html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Stack &amp; Smash Burgers — Pay</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, sans-serif; background: #f6f9fc; color: #1a1a2e; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: flex-start; }
    .header { width: 100%; background: #0a0a0a; padding: 20px 24px; display: flex; align-items: center; gap: 12px; }
    .logo-mark { width: 36px; height: 36px; background: #fff; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 18px; flex-shrink: 0; }
    .brand { color: #fff; font-size: 16px; font-weight: 600; letter-spacing: -0.2px; }
    .brand-sub { color: #888; font-size: 13px; font-weight: 400; margin-top: 1px; }
    .card { background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); max-width: 440px; width: calc(100% - 32px); margin: 28px auto; overflow: hidden; }
    .section-label { font-size: 11px; font-weight: 700; color: #8898aa; text-transform: uppercase; letter-spacing: 0.8px; padding: 20px 24px 10px; border-bottom: 1px solid #f0f4f8; }
    .line-item { display: flex; justify-content: space-between; align-items: flex-start; padding: 14px 24px; border-bottom: 1px solid #f0f4f8; }
    .line-left { display: flex; flex-direction: column; gap: 3px; flex: 1; padding-right: 16px; }
    .line-name { font-size: 15px; font-weight: 500; color: #1a1a2e; }
    .mod-list { font-size: 13px; color: #8898aa; }
    .line-qty { font-size: 12px; color: #aab4c4; margin-top: 2px; }
    .line-price { font-size: 15px; font-weight: 600; color: #1a1a2e; white-space: nowrap; }
    .total-row { display: flex; justify-content: space-between; align-items: center; padding: 16px 24px; }
    .total-label { font-size: 15px; font-weight: 600; color: #1a1a2e; }
    .total-amount { font-size: 20px; font-weight: 700; color: #1a1a2e; }
    .actions { padding: 8px 24px 24px; }
    .pay-btn { display: block; width: 100%; padding: 14px; border-radius: 6px; border: none; font-size: 16px; font-weight: 600; background: #c4c4c4; color: #fff; cursor: not-allowed; letter-spacing: 0.2px; }
    .powered { text-align: center; font-size: 12px; color: #aab4c4; margin-top: 16px; padding-bottom: 24px; }
    .powered span { font-weight: 600; color: #8898aa; }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo-mark">🍔</div>
    <div>
      <div class="brand">Stack &amp; Smash Burgers</div>
      <div class="brand-sub">Secure checkout</div>
    </div>
  </div>
  <div class="card">
    <div class="section-label">Your Order</div>
    ${rows}
    <div class="total-row">
      <div class="total-label">Total</div>
      <div class="total-amount">$${subtotal}</div>
    </div>
    <div class="actions">
      <button class="pay-btn" disabled>Pay $${subtotal}</button>
    </div>
  </div>
  <div class="powered">Powered by <span>Stripe</span></div>
</body>
</html>`);
});

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Stripe redirect pages
app.get('/payment/success', (req, res) => {
  res.send('Payment successful! Thank you for your order.');
});

app.get('/payment/cancel', (req, res) => {
  res.send('Payment cancelled. Please call us back if you need help.');
});

function buildTeXML(joinUrl) {
  const serverUrl = getSecrets().serverUrl;
  const statusCallbackAttr = serverUrl ? ` statusCallback="${serverUrl}/call-status" statusCallbackMethod="POST"` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response${statusCallbackAttr}>
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

loadSecrets().then(async () => {
  loadRestaurantConfigs();

  // Fetch latest menu from backend, then refresh every 2 hours
  await refreshMenu();
  setInterval(refreshMenu, 2 * 60 * 60 * 1000);

  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Webhook URL: http://localhost:${PORT}/incoming`);
  });
}).catch(err => {
  console.error('Failed to load secrets:', err.message);
  process.exit(1);
});
