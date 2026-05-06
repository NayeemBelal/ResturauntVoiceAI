const ONES = [
  'zero','one','two','three','four','five','six','seven','eight','nine','ten',
  'eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen',
];
const TENS = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];

function _numToWords(n) {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return TENS[t] + (o ? '-' + ONES[o] : '');
}

function toPriceEnglish(dollars) {
  const whole = Math.floor(dollars);
  const cents = Math.round((dollars - whole) * 100);
  let result = _numToWords(whole) + (whole === 1 ? ' dollar' : ' dollars');
  if (cents > 0) {
    result += ' and ' + _numToWords(cents) + (cents === 1 ? ' cent' : ' cents');
  }
  return result;
}

function _groupNameToSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function compressMenu(rawMenu) {
  // Already compressed — return as-is
  if (rawMenu.shared_modifier_groups) return rawMenu;

  const sharedModifierGroups = {};

  // Collect unique modifier groups (keyed by slug, defined once)
  for (const item of (rawMenu.items ?? [])) {
    for (const group of (item.modifier_groups ?? [])) {
      const slug = _groupNameToSlug(group.name);
      if (sharedModifierGroups[slug]) continue;
      sharedModifierGroups[slug] = {
        group_name: group.name,
        modifiers: (group.modifiers ?? []).map(m => ({
          mod_id: m.mod_id,
          mod_name: m.mod_name,
          price: m.price,
          price_english: m.price_english ?? toPriceEnglish(m.price),
        })),
      };
    }
  }

  const items = (rawMenu.items ?? []).map(item => ({
    item_id: item.item_id,
    item_name: item.item_name,
    modifier_groups: (item.modifier_groups ?? []).map(g => _groupNameToSlug(g.name)),
    price: item.price,
    price_english: item.price_english ?? toPriceEnglish(item.price),
  }));

  return {
    restaurant_slug: rawMenu.restaurant_slug,
    restaurant_name: rawMenu.restaurant_name,
    restaurant_id: rawMenu.restaurant_id,
    shared_modifier_groups: sharedModifierGroups,
    items,
  };
}

module.exports = { toPriceEnglish, compressMenu };
