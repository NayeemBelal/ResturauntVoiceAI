const { createClient } = require('@supabase/supabase-js');
const { getSecrets } = require('./secrets');

function getSupabase() {
  const { supabaseUrl, supabaseServiceRoleKey } = getSecrets();
  return createClient(supabaseUrl, supabaseServiceRoleKey);
}

async function getRestaurantByVoiceNumber(voiceNumber) {
  const { data, error } = await getSupabase()
    .from('restaurants')
    .select('id, name, pos_merchant_id')
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
  completeConversation,
};
