const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const DATA_DIR = path.join(__dirname, '..', 'data');

// Keyed by telnyx_phone_number
const configsByPhone = new Map();

function loadRestaurantConfigs() {
  const entries = fs.readdirSync(DATA_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const configPath = path.join(DATA_DIR, entry.name, 'config.yaml');
    if (!fs.existsSync(configPath)) continue;
    const config = yaml.load(fs.readFileSync(configPath, 'utf8'));
    if (!config.telnyx_phone_number) {
      console.warn(`[restaurant-configs] ${entry.name}/config.yaml missing telnyx_phone_number — skipped`);
      continue;
    }
    configsByPhone.set(config.telnyx_phone_number, { slug: entry.name, ...config });
    console.log(`[restaurant-configs] Loaded config for ${entry.name} (${config.telnyx_phone_number})`);
  }
}

function getRestaurantConfig(telnyxPhoneNumber) {
  return configsByPhone.get(telnyxPhoneNumber) ?? null;
}

function getFirstRestaurantConfig() {
  const [first] = configsByPhone.values();
  return first ?? null;
}

module.exports = { loadRestaurantConfigs, getRestaurantConfig, getFirstRestaurantConfig };
