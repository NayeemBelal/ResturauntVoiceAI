const { buildSystemPrompt } = require('./prompt');
const { getSecrets } = require('./secrets');

const ULTRAVOX_API_URL = 'https://api.ultravox.ai/api/calls';

function buildCallConfig(callerPhone, merchantId, callContext = {}) {
  const { serverUrl } = getSecrets();

  return {
    systemPrompt: buildSystemPrompt(callContext),
    model: 'ultravox-v0.7',
    voice: 'Mark',
    medium: { telnyx: {} },
    firstSpeakerSettings: { agent: {} },
    selectedTools: [
      { toolName: 'hangUp' },
      {
        temporaryTool: {
          modelToolName: 'getBusinessAddress',
          description: 'Get the restaurant address and phone number. Call this when the customer asks where the restaurant is located, what the address is, or how to contact the restaurant.',
          http: {
            baseUrlPattern: `${serverUrl}/tool/business-address`,
            httpMethod: 'POST',
          },
        },
      },
      {
        temporaryTool: {
          modelToolName: 'getBusinessHours',
          description: 'Get the restaurant opening hours. Call this when the customer asks about hours, what time you open or close, whether you are open on a specific day, or anything related to business hours.',
          http: {
            baseUrlPattern: `${serverUrl}/tool/business-hours`,
            httpMethod: 'POST',
          },
        },
      },
      {
        temporaryTool: {
          modelToolName: 'transferCall',
          description: 'Transfer the live call to a human staff member. Use this if the customer asks to speak to a person or if you cannot help them. Tell the customer you are connecting them, then call this tool.',
          http: {
            baseUrlPattern: `${serverUrl}/tool/transfer-call/${encodeURIComponent(callerPhone)}`,
            httpMethod: 'POST',
          },
        },
      },
      {
        temporaryTool: {
          modelToolName: 'getCart',
          description: 'Get the current saved cart from the server. Use this when the customer asks for a recap, when you need to confirm what is already in the order, and always right before the final checkout recap and sendCheckoutLink.',
          http: {
            baseUrlPattern: `${serverUrl}/tool/cart/get/${encodeURIComponent(callerPhone)}`,
            httpMethod: 'POST',
          },
        },
      },
      {
        temporaryTool: {
          modelToolName: 'addToCart',
          description: 'Add an item to the cart or increase its quantity. Call this every time the customer confirms they want an item, after required modifiers are finalized.',
          dynamicParameters: [
            {
              name: 'item',
              location: 'PARAMETER_LOCATION_BODY',
              schema: {
                type: 'object',
                properties: {
                  item_id: { type: 'string' },
                  name: { type: 'string' },
                  quantity: { type: 'integer' },
                  price_cents: { type: 'integer', description: 'Base price only, no modifiers' },
                  modifiers: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        mod_id: { type: 'string' },
                        name: { type: 'string' },
                        price_cents: { type: 'integer' },
                      },
                      required: ['mod_id', 'name', 'price_cents'],
                    },
                  },
                },
                required: ['item_id', 'name', 'quantity', 'price_cents'],
              },
              required: true,
            },
          ],
          http: {
            baseUrlPattern: `${serverUrl}/tool/cart/add/${encodeURIComponent(callerPhone)}`,
            httpMethod: 'POST',
          },
        },
      },
      {
        temporaryTool: {
          modelToolName: 'removeFromCart',
          description: 'Remove an item from the cart or reduce its quantity. Use the exact modifier IDs for the cart line you want to change.',
          dynamicParameters: [
            {
              name: 'item',
              location: 'PARAMETER_LOCATION_BODY',
              schema: {
                type: 'object',
                properties: {
                  item_id: { type: 'string' },
                  quantity: { type: 'integer', description: 'How many to remove from this exact cart line' },
                  modifiers: {
                    type: 'array',
                    description: 'The modifiers on the exact cart line to update. Use an empty array when there are no modifiers.',
                    items: {
                      type: 'object',
                      properties: {
                        mod_id: { type: 'string' },
                      },
                      required: ['mod_id'],
                    },
                  },
                },
                required: ['item_id', 'quantity', 'modifiers'],
              },
              required: true,
            },
          ],
          http: {
            baseUrlPattern: `${serverUrl}/tool/cart/remove/${encodeURIComponent(callerPhone)}`,
            httpMethod: 'POST',
          },
        },
      },
      {
        temporaryTool: {
          modelToolName: 'clearCart',
          description: 'Clear the entire saved cart. Use this if a resumed caller wants to start over from scratch.',
          http: {
            baseUrlPattern: `${serverUrl}/tool/cart/clear/${encodeURIComponent(callerPhone)}`,
            httpMethod: 'POST',
          },
        },
      },
      {
        temporaryTool: {
          modelToolName: 'saveCustomerName',
          description: 'Save the customer first and last name after they spell it during checkout. Call this after you have both names and before you send the checkout link.',
          dynamicParameters: [
            {
              name: 'firstName',
              location: 'PARAMETER_LOCATION_BODY',
              schema: {
                type: 'string',
                description: 'The customer first name exactly as confirmed on the call.',
              },
              required: true,
            },
            {
              name: 'lastName',
              location: 'PARAMETER_LOCATION_BODY',
              schema: {
                type: 'string',
                description: 'The customer last name exactly as confirmed on the call.',
              },
              required: true,
            },
          ],
          http: {
            baseUrlPattern: `${serverUrl}/tool/customer-name/${encodeURIComponent(callerPhone)}`,
            httpMethod: 'POST',
          },
        },
      },
      {
        temporaryTool: {
          modelToolName: 'sendCheckoutLink',
          description:
            'Send the customer a checkout link via SMS so they can pay. Call this when the customer confirms they are done ordering and ready to pay. If you ask whether they want anything else and they say no, that means they are done ordering and this tool should be used once any required checkout details are collected. The cart is already saved server-side, so no items are needed. This tool only sends the link and returns whether it succeeded or failed. Do not treat this tool as ending the call. After it returns successfully, acknowledge once, briefly, that the link was sent. Do not repeat that confirmation multiple times unless the customer asks. Then, if appropriate, make a separate hangUp call.',
          http: {
            baseUrlPattern: `${serverUrl}/tool/send-checkout/${encodeURIComponent(callerPhone)}`,
            httpMethod: 'POST',
          },
        },
      },
    ],
  };
}

async function createUltravoxCall(callerPhone, merchantId, callContext = {}) {
  const { ultravoxApiKey } = getSecrets();

  const response = await fetch(ULTRAVOX_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': ultravoxApiKey,
    },
    body: JSON.stringify(buildCallConfig(callerPhone, merchantId, callContext)),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Ultravox API error ${response.status}: ${error}`);
  }

  const data = await response.json();
  return data.joinUrl;
}

module.exports = { createUltravoxCall };
