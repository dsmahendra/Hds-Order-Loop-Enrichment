#!/usr/bin/env node
// Manual verification tool for the note_attributes reorder.
// Usage: node src/scripts/reorder-check.js <shopifyOrderId>

const { getOrder } = require('../shopify');

const orderId = process.argv[2];
if (!orderId) {
  console.error('Usage: node src/scripts/reorder-check.js <shopifyOrderId>');
  process.exit(1);
}

const PRIORITY_KEYS = [
  'Delivery-Date',
  'Delivery-Time',
  'Pick-Pack-Date',
  'HDS Production Date',
  'HDS Delivery Date',
  'HDS Ship Date',
];

function normalizeAttributeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/-/g, '_');
}

async function main() {
  try {
    const response = await getOrder(orderId);
    const order = response?.order;

    if (!order) {
      console.error(`❌ Order ${orderId} not found`);
      process.exit(1);
    }

    const attrs = order.note_attributes || [];
    console.log(`\n📋 Order: ${order.name || orderId}`);
    console.log(`📊 Total attributes: ${attrs.length}\n`);

    const getPriority = (attrName) => {
      const idx = PRIORITY_KEYS.findIndex(
        (k) => normalizeAttributeName(k) === normalizeAttributeName(attrName)
      );
      return idx === -1 ? 999 : idx;
    };

    let currentPosition = 0;
    let allCorrect = true;

    console.log('Attribute Order:');
    console.log('─'.repeat(80));

    for (const attr of attrs) {
      const priority = getPriority(attr.name);
      const inPriority = priority !== 999;
      const position = PRIORITY_KEYS.indexOf(
        PRIORITY_KEYS.find((k) => normalizeAttributeName(k) === normalizeAttributeName(attr.name)) || null
      );

      if (inPriority) {
        const isCorrect = position === currentPosition;
        if (!isCorrect) allCorrect = false;

        const status = isCorrect ? '✅' : '❌';
        console.log(
          `${status} [${currentPosition}] ${attr.name.padEnd(25)} = ${String(attr.value).slice(0, 40)}`
        );
        currentPosition++;
      } else {
        console.log(
          `   [${currentPosition}] ${attr.name.padEnd(25)} = ${String(attr.value).slice(0, 40)}`
        );
        currentPosition++;
      }
    }

    console.log('─'.repeat(80));

    if (allCorrect) {
      console.log('\n✅ Attributes are in CORRECT order!\n');
      process.exit(0);
    } else {
      console.log('\n❌ Attributes are NOT in correct order.\n');
      process.exit(1);
    }
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}\n`);
    process.exit(1);
  }
}

main();
