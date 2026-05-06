const { createClient } = require('@supabase/supabase-js');
const { getSecrets } = require('./secrets');

function getSupabase() {
  const { supabaseUrl, supabaseServiceRoleKey } = getSecrets();
  return createClient(supabaseUrl, supabaseServiceRoleKey);
}

async function getRestaurantByVoiceNumber(voiceNumber) {
  const { data, error } = await getSupabase()
    .from('restaurants')
    .select('id, name, pos_merchant_id, ai_greeting, ai_voice_id, forwarding_number, description, address, website')
    .eq('voice_call_number', voiceNumber)
    .single();

  if (error) throw new Error(`Restaurant lookup failed: ${error.message}`);
  return data;
}

async function upsertCustomer(phone) {
  const { data, error } = await getSupabase()
    .from('customers')
    .upsert({ phone_number: phone }, { onConflict: 'phone_number' })
    .select('id, first_name, last_name')
    .single();

  if (error) throw new Error(`Customer upsert failed: ${error.message}`);
  return data;
}

async function updateCustomerName(customerId, firstName, lastName) {
  const { data, error } = await getSupabase()
    .from('customers')
    .update({
      first_name: firstName,
      last_name: lastName,
      updated_at: new Date().toISOString(),
    })
    .eq('id', customerId)
    .select('id, first_name, last_name')
    .single();

  if (error) throw new Error(`Customer name update failed: ${error.message}`);
  return data;
}

async function createConversation(restaurantId, customerId) {
  const { data, error } = await getSupabase()
    .from('conversations')
    .insert({ restaurant_id: restaurantId, customer_id: customerId, channel: 'voice' })
    .select('id')
    .single();

  if (error) throw new Error(`Conversation create failed: ${error.message}`);
  return data;
}

async function getActiveConversation(restaurantId, customerId) {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data, error } = await getSupabase()
    .from('conversations')
    .select('id, current_cart')
    .eq('restaurant_id', restaurantId)
    .eq('customer_id', customerId)
    .eq('channel', 'voice')
    .is('completed_at', null)
    .gt('updated_at', cutoff)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Active conversation lookup failed: ${error.message}`);
  return data;
}

async function completeStaleConversations(restaurantId, customerId) {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { error } = await getSupabase()
    .from('conversations')
    .update({ completed_at: new Date().toISOString() })
    .eq('restaurant_id', restaurantId)
    .eq('customer_id', customerId)
    .eq('channel', 'voice')
    .is('completed_at', null)
    .lt('updated_at', cutoff);

  if (error) throw new Error(`Stale conversation cleanup failed: ${error.message}`);
}

async function updateCart(conversationId, cart) {
  const { error } = await getSupabase()
    .from('conversations')
    .update({ current_cart: cart, updated_at: new Date().toISOString() })
    .eq('id', conversationId);

  if (error) throw new Error(`Cart update failed: ${error.message}`);
}

async function createOrder(restaurantId, customerId, conversationId, stripeSessionId, items) {
  const supabase = getSupabase();

  const orderItems = items.map(item => {
    const modsTotalDollars = (item.modifiers ?? []).reduce((s, m) => s + m.price_cents / 100, 0);
    const basePriceDollars = item.price_cents / 100;
    const itemTotal = (basePriceDollars + modsTotalDollars) * item.quantity;

    return {
      menu_item_id: item.item_id,
      menu_item_name: item.name,
      quantity: item.quantity,
      base_price: basePriceDollars,
      modifications: (item.modifiers ?? []).map(m => ({ id: m.mod_id, name: m.name, price_cents: m.price_cents })),
      modifiers_total: modsTotalDollars,
      item_total: parseFloat(itemTotal.toFixed(2)),
      special_notes: item.note ?? null,
    };
  });

  const subtotal = orderItems.reduce((s, i) => s + i.item_total, 0);

  const { data: order, error: orderErr } = await supabase
    .from('orders')
    .insert({
      restaurant_id: restaurantId,
      customer_id: customerId,
      conversation_id: conversationId,
      stripe_session_id: stripeSessionId,
      subtotal: parseFloat(subtotal.toFixed(2)),
      tax: 0,
      total: parseFloat(subtotal.toFixed(2)),
      status: 'open',
      channel: 'voice',
    })
    .select('id')
    .single();

  if (orderErr) throw new Error(`Order create failed: ${orderErr.message}`);

  const itemRows = orderItems.map(i => ({ ...i, order_id: order.id }));
  const { error: itemsErr } = await supabase.from('order_items').insert(itemRows);
  if (itemsErr) throw new Error(`Order items insert failed: ${itemsErr.message}`);

  return order;
}

async function updateOrderPlaced(orderId, posOrderId) {
  const { error } = await getSupabase()
    .from('orders')
    .update({ status: 'placed', pos_order_id: posOrderId })
    .eq('id', orderId);

  if (error) throw new Error(`Order update failed: ${error.message}`);
}

// Bug B — cancel any prior open orders within the same conversation before creating a new checkout session.
// Scoped strictly to conversation_id so other calls are never affected.
async function cancelOpenOrdersForConversation(conversationId) {
  const { error } = await getSupabase()
    .from('orders')
    .update({ status: 'failed' })
    .eq('conversation_id', conversationId)
    .eq('status', 'open');

  if (error) throw new Error(`Cancel open orders failed: ${error.message}`);
}

// Bug C — recover order from DB when in-memory pendingOrders map is gone (e.g. server restart).
async function getOrderByStripeSessionId(stripeSessionId) {
  const { data, error } = await getSupabase()
    .from('orders')
    .select('id, conversation_id, restaurant_id, customer_id, status')
    .eq('stripe_session_id', stripeSessionId)
    .maybeSingle();

  if (error) throw new Error(`Order lookup by session failed: ${error.message}`);
  return data;
}

// Bug A + call_outcome — write duration and outcome to conversations table.
async function updateConversationOutcome(conversationId, { durationSeconds, callOutcome, completedAt, callEndedAt } = {}) {
  const updates = {};
  if (durationSeconds != null) updates.duration_seconds = durationSeconds;
  if (callOutcome != null) updates.call_outcome = callOutcome;
  if (completedAt != null) updates.completed_at = completedAt;
  if (callEndedAt != null) updates.call_ended_at = callEndedAt;
  if (Object.keys(updates).length === 0) return;

  const { error } = await getSupabase()
    .from('conversations')
    .update(updates)
    .eq('id', conversationId);

  if (error) throw new Error(`Conversation outcome update failed: ${error.message}`);
}

// Looks up the most recent open voice conversation for a caller by phone number.
// Used by the hangup handler so it doesn't depend on the in-memory activeCalls Map.
async function getOpenVoiceConversationByPhone(callerPhone) {
  const cutoff = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  console.log('[db] getOpenVoiceConversationByPhone — phone:', callerPhone, '| cutoff:', cutoff);
  const { data, error } = await getSupabase()
    .from('conversations')
    .select('id, customers!inner(phone_number)')
    .eq('channel', 'voice')
    .is('call_ended_at', null)
    .eq('customers.phone_number', callerPhone)
    .gt('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  console.log('[db] getOpenVoiceConversationByPhone result — data:', JSON.stringify(data), '| error:', error?.message ?? null);
  if (error) throw new Error(`Open voice conversation lookup failed: ${error.message}`);
  return data;
}

// Bug A — on hangup, set call_outcome to 'no-outcome' only if not already set by a more specific event.
async function setNoOutcomeIfNull(conversationId) {
  const { error } = await getSupabase()
    .from('conversations')
    .update({ call_outcome: 'no-outcome' })
    .eq('id', conversationId)
    .is('call_outcome', null);

  if (error) throw new Error(`setNoOutcomeIfNull failed: ${error.message}`);
}

async function getRestaurantFAQs(restaurantId) {
  const { data, error } = await getSupabase()
    .from('faqs')
    .select('question, answer, category')
    .eq('restaurant_id', restaurantId)
    .eq('active', true)
    .order('sort_order', { ascending: true });

  if (error) throw new Error(`FAQ fetch failed: ${error.message}`);
  return data ?? [];
}

async function getUpsellRules(restaurantId) {
  const { data, error } = await getSupabase()
    .from('upsell_rules')
    .select('trigger_item_name, suggested_item_name, message')
    .eq('restaurant_id', restaurantId)
    .eq('active', true);

  if (error) throw new Error(`Upsell rules fetch failed: ${error.message}`);
  return data ?? [];
}

async function completeConversation(conversationId) {
  const { error } = await getSupabase()
    .from('conversations')
    .update({ completed_at: new Date().toISOString() })
    .eq('id', conversationId);

  if (error) throw new Error(`Conversation complete failed: ${error.message}`);
}

module.exports = {
  getRestaurantByVoiceNumber,
  upsertCustomer,
  updateCustomerName,
  createConversation,
  getActiveConversation,
  completeStaleConversations,
  updateCart,
  createOrder,
  updateOrderPlaced,
  cancelOpenOrdersForConversation,
  getOrderByStripeSessionId,
  getOpenVoiceConversationByPhone,
  updateConversationOutcome,
  setNoOutcomeIfNull,
  completeConversation,
  getRestaurantFAQs,
  getUpsellRules,
};
