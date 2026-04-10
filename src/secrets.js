/**
 * Secrets management — mirrors the pattern in TextToOrderCoffee/src/config/settings.py
 *
 * Resolution order:
 *   1. Environment variable (works locally via .env AND in Cloud Run via --set-secrets)
 *   2. GCP Secret Manager SDK (fetched if env var missing and GCP project detected)
 *
 * Call loadSecrets() once at startup. All other modules call getSecrets().
 */

const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

let smClient = null;
let projectId = null;
const valueCache = new Map(); // secretName → { value, cachedAt }

async function initSecretManager() {
  projectId = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;

  if (!projectId) {
    try {
      const res = await fetch(
        'http://metadata.google.internal/computeMetadata/v1/project/project-id',
        { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(2000) }
      );
      if (res.ok) projectId = await res.text();
    } catch {
      // Not on GCP — expected in local dev
    }
  }

  if (!projectId) {
    console.log('[secrets] No GCP project ID found — using env vars');
    return;
  }

  try {
    smClient = new SecretManagerServiceClient();
    console.log(`[secrets] Secret Manager ready (project: ${projectId})`);
  } catch (err) {
    console.warn('[secrets] Secret Manager unavailable, falling back to env vars:', err.message);
  }
}

async function resolveSecret(secretName, envVarName, defaultValue = '') {
  // 1. Check cache
  const cached = valueCache.get(secretName);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.value;

  // 2. Env var (local .env or Cloud Run --set-secrets)
  const envValue = process.env[envVarName];
  if (envValue) {
    valueCache.set(secretName, { value: envValue, cachedAt: Date.now() });
    return envValue;
  }

  // 3. Secret Manager SDK
  if (smClient && projectId) {
    try {
      const name = `projects/${projectId}/secrets/${secretName}/versions/latest`;
      const [version] = await smClient.accessSecretVersion({ name });
      const value = version.payload.data.toString('utf8');
      console.log(`[secrets] Loaded '${secretName}' from Secret Manager`);
      valueCache.set(secretName, { value, cachedAt: Date.now() });
      return value;
    } catch (err) {
      console.debug(`[secrets] '${secretName}' not in Secret Manager: ${err.message}`);
    }
  }

  return defaultValue;
}

// Loaded once at startup, then available synchronously via getSecrets()
let _secrets = null;

async function loadSecrets() {
  await initSecretManager();

  // Secret Manager names match the TextToOrderCoffee project exactly.
  // Ultravox, Supabase URL, phone numbers, and SERVER_URL are env-var-only (no SM secret).
  const [
    ultravoxApiKey,
    telnyxApiKey,
    stripeSecretKey,
    stripeWebhookSecret,
    cloverApiKey,
    supabaseServiceRoleKey,
  ] = await Promise.all([
    resolveSecret('ultravox-api-key',                      'ULTRAVOX_API_KEY'),
    resolveSecret('telnyx-api-key',                        'TELNYX_API_KEY'),
    resolveSecret('stripe-lime_n_dime-secret-key',         'STRIPE_SECRET_KEY'),
    resolveSecret('stripe-lime_n_dime-webhook-secret',     'STRIPE_WEBHOOK_SECRET'),
    resolveSecret('clover-lime_n_dime-api-key',            'CLOVER_API_KEY'),
    resolveSecret('supabase-service-role-key',             'SUPABASE_SERVICE_ROLE_KEY'),
  ]);

  _secrets = {
    // From Secret Manager (with env var fallback)
    ultravoxApiKey,
    telnyxApiKey,
    stripeSecretKey,
    stripeWebhookSecret,
    cloverApiKey,
    supabaseServiceRoleKey,
    // Env var only
    supabaseUrl:         process.env.SUPABASE_URL          ?? '',
    telnyxPhoneNumber:   process.env.TELNYX_PHONE_NUMBER   ?? '',
    transferPhoneNumber: process.env.TRANSFER_PHONE_NUMBER ?? '',
    serverUrl:           process.env.SERVER_URL            ?? '',
  };

  return _secrets;
}

function getSecrets() {
  if (!_secrets) throw new Error('Secrets not initialised — await loadSecrets() before starting the server');
  return _secrets;
}

module.exports = { loadSecrets, getSecrets };
