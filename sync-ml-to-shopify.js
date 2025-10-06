// sync-ml-to-shopify.js
// Node 18+, ES module
import fetch from 'node-fetch';
import PQueue from 'p-queue';
import fs from 'fs';
import path from 'path';

const SHOP = process.env.SHOP_DOMAIN;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_API = `https://${SHOP}.myshopify.com/admin/api/2025-07`;

const ML_BASE = 'https://api.mercadolibre.com';
const ML_TOKEN = process.env.ML_TOKEN || null;

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '200', 10);
const TEST_SKU = (process.env.TEST_SKU || '').trim();
const FULL_SYNC = (process.env.FULL_SYNC || 'false').toLowerCase() === 'true';

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
    } else {
      console.log('No change for variant', v.id, 'sku', sku);
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

function readSkuListFile() {
  const p = path.join(process.cwd(), 'sku_list.txt');
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf8');
  return raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean).filter(s => !s.startsWith('#'));
}

(async () => {
  if (!SHOP || !SHOPIFY_TOKEN) {
    console.error('Missing SHOP_DOMAIN or SHOPIFY_ADMIN_TOKEN in env. Aborting.');
    process.exit(1);
  }
  try {
    // Determine SKU list source: repo file > SKU_LIST env secret > none
    let skuList = [];
    const fileSkus = readSkuListFile();
    if (fileSkus.length > 0) {
      console.log('Detected sku_list.txt in repo with', fileSkus.length, 'SKUs — processing ONLY these SKUs (unless FULL_SYNC=true).');
      skuList = fileSkus;
    } else if (process.env.SKU_LIST) {
      skuList = process.env.SKU_LIST.split(',').map(s => s.trim()).filter(Boolean);
      if (skuList.length > 0) console.log('Detected SKU_LIST secret with', skuList.length, 'SKUs — processing these.');
    }

    // If TEST_SKU provided, ensure it's first in list (and not duplicated)
    if (TEST_SKU) {
      skuList = skuList.filter(s => s !== TEST_SKU);
      skuList.unshift(TEST_SKU);
    }

    if (FULL_SYNC) {
      console.log('FULL_SYNC=true → processing entire catalog.');
      const limit = 0;
      const batch = await listVariantsBatch(limit);
      for (const entry of batch) {
        await processVariantEntry(entry);
      }
    } else if (skuList.length > 0) {
      console.log('Processing SKU list with', skuList.length, 'items (from file or secret).');
      for (const sku of skuList) {
        console.log('Processing SKU:', sku);
        const matches = await findVariantsBySku(sku);
        if (matches.length === 0) {
          console.warn('No variants found with SKU:', sku);
          continue;
        }
        for (const entry of matches) {
          await processVariantEntry(entry);
        }
      }
    } else {
      const limit = BATCH_SIZE;
      const batch = await listVariantsBatch(limit);
      console.log('Processing batch size', batch.length);
      for (const entry of batch) {
        await processVariantEntry(entry);
      }
    }

    await mlQueue.onIdle();
    await shopifyQueue.onIdle();
    console.log('Sync finished.');
  } catch (err) {
    console.error('Fatal', err);
    process.exit(1);
  }
})();
