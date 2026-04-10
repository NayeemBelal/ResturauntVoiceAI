const fs = require('fs');
const path = require('path');

const menuPath = path.join(__dirname, '..', 'data', 'lime_n_dime', 'menu.json');
const menu = JSON.parse(fs.readFileSync(menuPath, 'utf8'));

const ones = ['zero','one','two','three','four','five','six','seven','eight','nine',
               'ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen',
               'seventeen','eighteen','nineteen'];
const tens = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];

function numToWords(n) {
  if (n < 20) return ones[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return o === 0 ? tens[t] : `${tens[t]}-${ones[o]}`;
}

function priceToEnglish(dollars, cents) {
  const dollarWord = dollars === 1 ? 'dollar' : 'dollars';
  if (cents === 0) return `${numToWords(dollars)} ${dollarWord}`;
  const centWord = cents === 1 ? 'cent' : 'cents';
  return `${numToWords(dollars)} ${dollarWord} and ${numToWords(cents)} ${centWord}`;
}

function toEnglish(price) {
  const dollars = Math.floor(price);
  const cents = Math.round((price - dollars) * 100);
  return priceToEnglish(dollars, cents);
}

// Convert items
let itemCount = 0;
for (const item of menu.items) {
  item.price = parseFloat(item.price_display.replace(/[^0-9.]/g, ''));
  item.price_english = toEnglish(item.price);
  delete item.price_display;
  itemCount++;
}

// Convert modifiers
let modCount = 0;
for (const group of Object.values(menu.shared_modifier_groups)) {
  for (const mod of group.modifiers) {
    mod.price = mod.mod_price_cents / 100;
    mod.price_english = toEnglish(mod.price);
    delete mod.mod_price_cents;
    delete mod.mod_price_display;
    modCount++;
  }
}

fs.writeFileSync(menuPath, JSON.stringify(menu, null, 2));
console.log(`Done. Converted ${itemCount} items and ${modCount} modifiers.`);

// Preview a few examples
console.log('\nSample items:');
menu.items.slice(0, 3).forEach(i => console.log(` ${i.item_name}: ${i.price} → "${i.price_english}"`));
console.log('\nSample modifiers:');
Object.values(menu.shared_modifier_groups)[0].modifiers.slice(0, 3)
  .forEach(m => console.log(` ${m.mod_name}: ${m.price} → "${m.price_english}"`));
