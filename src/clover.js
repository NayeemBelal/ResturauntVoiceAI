const menu = require('../data/lime_n_dime/menu.json');

// Default merchant ID for info lookups (business address/hours)
const DEFAULT_MERCHANT_ID = menu.merchant_id;
const BASE_URL = 'https://api.clover.com';

function cloverHeaders() {
  const { cloverApiKey } = require('./secrets').getSecrets();
  return {
    'Authorization': `Bearer ${cloverApiKey}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

// Verify each item and its modifiers exist in Clover, correct prices to Clover's values.
// Returns { valid: false, error: string } or { valid: true, verifiedItems: [...] }
async function verifyItems(items, merchantId) {
  const mid = merchantId ?? DEFAULT_MERCHANT_ID;
  const verifiedItems = [];

  for (const item of items) {
    let cloverItem;
    try {
      const res = await fetch(
        `${BASE_URL}/v3/merchants/${mid}/items/${item.item_id}?expand=modifierGroups.modifiers`,
        { headers: cloverHeaders() }
      );

      if (res.status === 404) {
        return { valid: false, error: `Sorry, "${item.name}" is no longer available. Please update your order.` };
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Clover item fetch error ${res.status}: ${text}`);
      }

      cloverItem = await res.json();
    } catch (err) {
      console.error('Clover verify error:', err.message);
      return { valid: false, error: 'Unable to verify your order right now. Please try again.' };
    }

    if (cloverItem.hidden || cloverItem.available === false) {
      return { valid: false, error: `Sorry, "${cloverItem.name || item.name}" is no longer available. Please update your order.` };
    }

    // Build a map of valid modifier IDs → Clover price
    const cloverModPrices = {};
    for (const mg of (cloverItem.modifierGroups?.elements ?? [])) {
      for (const mod of (mg.modifiers?.elements ?? [])) {
        cloverModPrices[mod.id] = mod.price ?? 0;
      }
    }

    // Verify modifiers and correct prices
    const verifiedModifiers = [];
    for (const mod of (item.modifiers ?? [])) {
      if (mod.mod_id && !(mod.mod_id in cloverModPrices)) {
        return { valid: false, error: `Sorry, the modifier "${mod.name}" is no longer available. Please update your order.` };
      }
      verifiedModifiers.push({
        ...mod,
        price_cents: mod.mod_id ? cloverModPrices[mod.mod_id] : mod.price_cents,
      });
    }

    verifiedItems.push({
      ...item,
      price_cents: cloverItem.price ?? item.price_cents,
      modifiers: verifiedModifiers,
    });
  }

  return { valid: true, verifiedItems };
}

// Create an order in Clover via atomic_order API. Returns the Clover order ID.
async function createOrder(items, merchantId) {
  const mid = merchantId ?? DEFAULT_MERCHANT_ID;

  const lineItems = items.map(item => {
    const modTotal = (item.modifiers ?? []).reduce((sum, m) => sum + m.price_cents, 0);
    const unitPrice = item.price_cents + modTotal;
    const note = (item.modifiers ?? []).map(m => m.name).filter(Boolean).join(', ');

    return {
      item: { id: item.item_id },
      name: item.name,
      unitQty: item.quantity,
      price: unitPrice,
      ...(note && { note }),
    };
  });

  const res = await fetch(
    `${BASE_URL}/v3/merchants/${mid}/atomic_order/orders`,
    {
      method: 'POST',
      headers: cloverHeaders(),
      body: JSON.stringify({ orderCart: { lineItems, note: 'Phone order' } }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Clover createOrder error ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.id;
}

// Find the external payment tender ID for this merchant.
async function getExternalTenderId(merchantId) {
  const mid = merchantId ?? DEFAULT_MERCHANT_ID;
  const res = await fetch(
    `${BASE_URL}/v3/merchants/${mid}/tenders`,
    { headers: cloverHeaders() }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Clover tenders error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const tender = (data.elements ?? []).find(t => t.labelKey === 'com.clover.tender.external_payment');
  if (!tender) throw new Error('External payment tender not found for this merchant');
  return tender.id;
}

// Record an external payment against a Clover order, closing it.
async function markOrderPaid(cloverOrderId, amountCents, merchantId) {
  const mid = merchantId ?? DEFAULT_MERCHANT_ID;
  const tenderId = await getExternalTenderId(mid);

  const res = await fetch(
    `${BASE_URL}/v3/merchants/${mid}/orders/${cloverOrderId}/payments`,
    {
      method: 'POST',
      headers: cloverHeaders(),
      body: JSON.stringify({ amount: amountCents, tender: { id: tenderId } }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Clover markOrderPaid error ${res.status}: ${text}`);
  }
}

// Send a print event to the kitchen printer for the given order.
async function printTicket(cloverOrderId, merchantId) {
  const mid = merchantId ?? DEFAULT_MERCHANT_ID;
  const res = await fetch(
    `${BASE_URL}/v3/merchants/${mid}/print_event`,
    {
      method: 'POST',
      headers: cloverHeaders(),
      body: JSON.stringify({ orderRef: { id: cloverOrderId } }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    console.warn(`Clover printTicket warning ${res.status}: ${text}`);
    return false;
  }

  return true;
}

// Convert minutes-from-midnight to a readable time string e.g. 540 → "9:00 AM"
function minsToTime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const period = h < 12 ? 'AM' : 'PM';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, '0')} ${period}`;
}

// Fetch the restaurant address from Clover.
async function getBusinessAddress(merchantId) {
  const mid = merchantId ?? DEFAULT_MERCHANT_ID;
  const [merchantRes, addressRes] = await Promise.all([
    fetch(`${BASE_URL}/v3/merchants/${mid}`, { headers: cloverHeaders() }),
    fetch(`${BASE_URL}/v3/merchants/${mid}/address`, { headers: cloverHeaders() }),
  ]);

  const merchant = merchantRes.ok ? await merchantRes.json() : {};
  const address = addressRes.ok ? await addressRes.json() : {};

  const addressParts = [
    address.address1,
    address.address2,
    address.city && address.state ? `${address.city}, ${address.state}` : address.city || address.state,
    address.zip,
  ].filter(Boolean);

  return {
    name: merchant.name ?? 'Lime N Dime',
    phone: merchant.phoneNumber ?? null,
    address: addressParts.join(', ') || null,
  };
}

// Fetch business hours from Clover.
async function getBusinessHours(merchantId) {
  const mid = merchantId ?? DEFAULT_MERCHANT_ID;
  const res = await fetch(
    `${BASE_URL}/v3/merchants/${mid}/opening_hours`,
    { headers: cloverHeaders() }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Clover opening hours error ${res.status}: ${text}`);
  }

  const hoursData = await res.json();
  const hourSets = Array.isArray(hoursData.elements) ? hoursData.elements : [];
  if (hourSets.length === 0) {
    return {
      hours: null,
      unavailable: true,
      message: 'Business hours are not configured in Clover right now.',
    };
  }

  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const hoursSet = hourSets[0] ?? {};
  const hours = {};
  for (const day of dayNames) {
    const slots = hoursSet[day] ?? [];
    hours[day] = slots.length === 0
      ? 'Closed'
      : slots.map(s => `${minsToTime(s.start)} - ${minsToTime(s.end)}`).join(', ');
  }

  return { hours, unavailable: false };
}

module.exports = { verifyItems, createOrder, markOrderPaid, printTicket, getBusinessAddress, getBusinessHours };
