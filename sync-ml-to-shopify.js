// sync-ml-to-shopify.js
// Node 18+, ES module
import fetch from 'node-fetch';
import PQueue from 'p-queue';

const SHOP = process.env.SHOP_DOMAIN; // ejemplo: mi-tienda
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_API = `https://${SHOP}.myshopify.com/admin/api/2025-07`;

const ML_BASE = 'https://api.mercadolibre.com';
const ML_TOKEN = process.env.ML_TOKEN || null; // opcional

// Control de batch
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '200', 10);
const TEST_SKU = (process.env.TEST_SKU || '').trim(); // sku para priorizar (opcional)
const FULL_SYNC = (process.env.FULL_SYNC || 'false').toLowerCase() === 'true'; // si true procesa todo el catálogo

// ML rate limit: 40 requests / minuto
const mlQueue = new PQueue({ interval: 60_000, intervalCap: 40 });
const shopifyQueue = new PQueue({ concurrency: 2 });

async function shopifyGet(url) {
  const res = await fetch(url, {
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
  });
  if (!res.ok) throw new Error(`Shopify GET ${res.status} ${await res.text()}`);
  return res.json();
}

async function shopifyPut(path, body) {
  const res = await fetch(`${SHOPIFY_API}${path}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_TOKEN
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify PUT ${res.status} ${text}`);
  }
  return res.json();
}

async function fetchMlItem(itemId) {
  const url = `${ML_BASE}/items/${itemId}`;
  const headers = ML_TOKEN ? { Authorization: `Bearer ${ML_TOKEN}` } : {};
  const res = await fetch(url, { headers });
  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after') || 5;
    const err = new Error('ML rate limit');
    err.code = 429;
    err.retryAfter = parseInt(retryAfter, 10);
    throw err;
  }
  if (res.status === 404) {
    const err = new Error('ML not found');
    err.code = 404;
    throw err;
  }
  if (res.status === 403) {
    const err = new Error('ML forbidden');
    err.code = 403;
    throw err;
  }
  if (!res.ok) throw new Error(`ML error ${res.status}`);
  return res.json();
}

// Lista variantes usando products.json, pero procesa solo hasta limit por ejecución
async function listVariantsBatch(limit) {
  const results = [];
  let since_id = 0;
  while ((limit <= 0) || (results.length < limit)) {
    const url = `${SHOPIFY_API}/products.json?limit=250&since_id=${since_id}`;
    const data = await shopifyGet(url);
    const products = data.products || [];
    if (products.length === 0) break;
    for (const p of products) {
      for (const v of p.variants) {
        results.push({ product: p, variant: v });
        if ((limit > 0) && (results.length >= limit)) break;
      }
      if ((limit > 0) && (results.length >= limit)) break;
    }
    since_id = products[products.length - 1].id;
    if (products.length < 250) break;
  }
  return results;
}

function needsUpdate(shopPrice, mlPrice) {
  const s = parseFloat(shopPrice);
  const m = parseFloat(mlPrice);
  if (isNaN(m) || isNaN(s)) return false;
  const diff = Math.abs(m - s) / (s || 1);
  return diff > 0.01;
}

async function processVariantEntry(entry) {
  const v = entry.variant;
  const sku = (v.sku || '').trim();
  if (!sku) return;
  try {
    const mlItem = await mlQueue.add(() => fetchMlItem(sku));
    const mlPrice = mlItem.price;
    if (mlPrice == null) return;
    if (needsUpdate(v.price, mlPrice)) {
      await shopifyQueue.add(async () => {
        const body = { variant: { id: v.id, price: mlPrice.toString() } };
        try {
          await shopifyPut(`/variants/${v.id}.json`, body);
          console.log('Updated variant', v.id, 'sku', sku, '->', mlPrice);
        } catch (err) {
          console.error('Shopify update error', v.id, err.message);
        }
      });
    }
  } catch (err) {
    if (err.code === 429) {
      const wait = (err.retryAfter || 5) * 1000;
      console.warn('ML 429 — waiting', wait, 'ms');
      await new Promise(r => setTimeout(r, wait));
    } else if (err.code === 404) {
      console.warn('ML item not found for sku', sku);
    } else if (err.code === 403) {
      console.warn('ML forbidden for sku', sku);
    } else {
      console.error('Error processing sku', sku, err.message || err);
    }
  }
}

async function findVariantsBySku(targetSku) {
  const matches = [];
  let since_id = 0;
  while (true) {
    const url = `${SHOPIFY_API}/products.json?limit=250&since_id=${since_id}`;
    const data = await shopifyGet(url);
    const products = data.products || [];
    if (products.length === 0) break;
    for (const p of products) {
      for (const v of p.variants) {
        if ((v.sku || '').trim() === targetSku) {
          matches.push({ product: p, variant: v });
        }
      }
    }
    since_id = products[products.length - 1].id;
    if (products.length < 250) break;
  }
  return matches;
}

(async () => {
  if (!SHOP || !SHOPIFY_TOKEN) {
    console.error('Missing SHOP_DOMAIN or SHOPIFY_ADMIN_TOKEN in env. Aborting.');
    process.exit(1);
  }
  try {
    // If TEST_SKU is set, process it first and log separately
    if (TEST_SKU) {
      console.log('TEST_SKU detected:', TEST_SKU, '- searching and processing it first...');
      const found = await findVariantsBySku(TEST_SKU);
      if (found.length === 0) {
        console.warn('No variants found with TEST_SKU', TEST_SKU);
      } else {
        console.log('Found', found.length, 'variant(s) with TEST_SKU. Processing them now.');
        for (const entry of found) {
          await processVariantEntry(entry);
        }
        console.log('Finished processing TEST_SKU variants. Continuing with batch...');
      }
    }

    // Decide limit: if FULL_SYNC true, use limit = 0 (meaning unlimited in our function)
    const limit = FULL_SYNC ? 0 : BATCH_SIZE;
    const batch = await listVariantsBatch(limit);
    // If TEST_SKU was processed, remove any variant with that sku from the batch to avoid duplication
    const filteredBatch = TEST_SKU ? batch.filter(e => (e.variant.sku || '').trim() !== TEST_SKU) : batch;

    console.log('Processing batch size', filteredBatch.length, '(BATCH_SIZE', BATCH_SIZE, 'FULL_SYNC', FULL_SYNC, ')');
    for (const entry of filteredBatch) {
      await processVariantEntry(entry);
    }
    await mlQueue.onIdle();
    await shopifyQueue.onIdle();
    console.log('Batch finished');
  } catch (err) {
    console.error('Fatal', err);
    process.exit(1);
  }
})();
