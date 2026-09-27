import { Product } from '../models/Product.js';
import { badRequest, conflict, notFound } from './ApiError.js';
import { escapeRegex } from './serialize.js';

/**
 * Validates/normalises the `colors` payload of a product (create/update).
 * Returns [{ color, quantity }] with unique, trimmed names.
 */
export function normalizeColors(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw badRequest('colors must be an array of { color, quantity }.');
  if (raw.length > 50) throw badRequest('A product can track at most 50 colors.');

  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    const color = String(entry?.color ?? '').trim();
    const quantity = Number(entry?.quantity);
    if (!color) throw badRequest('Every color needs a name.');
    if (color.length > 40) throw badRequest(`Color name "${color.slice(0, 20)}…" is too long (max 40).`);
    if (!Number.isInteger(quantity) || quantity < 0) {
      throw badRequest(`Color "${color}" needs a whole-number quantity of 0 or more.`);
    }
    const key = color.toLowerCase();
    if (seen.has(key)) throw badRequest(`Duplicate color "${color}".`);
    seen.add(key);
    out.push({ color, quantity });
  }
  return out;
}

/**
 * Resolves the color a line item must draw from.
 * - product WITHOUT colors -> null (a passed color is an error)
 * - product WITH colors    -> the canonical stored name (required)
 * Returns the canonical color string.
 */
export function resolveColor(product, colorValue) {
  const raw = colorValue === undefined || colorValue === null ? null : String(colorValue).trim();
  const hasColors = Array.isArray(product.colors) && product.colors.length > 0;

  if (hasColors) {
    if (!raw) {
      throw badRequest(`"${product.name}" tracks stock by color — please choose a color.`);
    }
    const match = product.colors.find((c) => c.color.toLowerCase() === raw.toLowerCase());
    if (!match) {
      throw badRequest(
        `"${product.name}" has no color "${raw}". Available: ${product.colors.map((c) => c.color).join(', ')}.`
      );
    }
    return match.color;
  }

  if (raw) throw badRequest(`"${product.name}" does not track colors.`);
  return null;
}

/**
 * Validates/normalises the `packs` payload of a product (create/update).
 * Returns [{ label, price, mrp, cost_price, quantity }] with unique, trimmed labels.
 * `mrp`/`cost_price` are optional for backwards compatibility: a missing MRP
 * falls back to the pack's selling price, a missing cost price to 0.
 */
export function normalizePacks(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw badRequest('packs must be an array of { label, price, mrp, cost_price, quantity }.');
  }
  if (raw.length > 50) throw badRequest('A product can track at most 50 packs.');

  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    const label = String(entry?.label ?? '').trim();
    const price = Number(entry?.price);
    const quantity = Number(entry?.quantity);
    const mrp = entry?.mrp === undefined || entry?.mrp === null || entry?.mrp === '' ? price : Number(entry.mrp);
    const costPrice =
      entry?.cost_price === undefined || entry?.cost_price === null || entry?.cost_price === ''
        ? 0
        : Number(entry.cost_price);
    if (!label) throw badRequest('Every pack needs a label.');
    if (label.length > 40) throw badRequest(`Pack label "${label.slice(0, 20)}…" is too long (max 40).`);
    if (!Number.isFinite(price) || price < 0) {
      throw badRequest(`Pack "${label}" needs a price of 0 or more.`);
    }
    if (!Number.isFinite(mrp) || mrp < 0) {
      throw badRequest(`Pack "${label}" needs an MRP of 0 or more.`);
    }
    if (!Number.isFinite(costPrice) || costPrice < 0) {
      throw badRequest(`Pack "${label}" needs a cost price of 0 or more.`);
    }
    if (!Number.isInteger(quantity) || quantity < 0) {
      throw badRequest(`Pack "${label}" needs a whole-number quantity of 0 or more.`);
    }
    const key = label.toLowerCase();
    if (seen.has(key)) throw badRequest(`Duplicate pack "${label}".`);
    seen.add(key);
    out.push({ label, price, mrp, cost_price: costPrice, quantity });
  }
  return out;
}

/**
 * Resolves the pack a line item must draw from.
 * - product WITHOUT packs -> null (a passed pack is an error)
 * - product WITH packs    -> the chosen pack's label + price/MRP/cost, OR
 *                            the BIG/ORIGINAL size when no pack was chosen.
 * Returns { label, price, mrp, cost_price } (label=null + base=true for the
 * big size) or null. Legacy packs without stored mrp/cost fall back to the
 * pack price and 0.
 */
export function resolvePack(product, packValue) {
  const raw = packValue === undefined || packValue === null ? null : String(packValue).trim();
  const hasPacks = Array.isArray(product.packs) && product.packs.length > 0;

  if (hasPacks) {
    // No size chosen -> the product as it was originally added (the big size).
    if (!raw) {
      return {
        label: null,
        base: true,
        price: product.selling_price ?? product.mrp,
        mrp: product.mrp,
        cost_price: product.cost_price ?? 0,
      };
    }
    const match = product.packs.find((p) => p.label.toLowerCase() === raw.toLowerCase());
    if (!match) {
      throw badRequest(
        `"${product.name}" has no pack "${raw}". Available: ${product.packs.map((p) => p.label).join(', ')}.`
      );
    }
    return {
      label: match.label,
      price: match.price,
      mrp: match.mrp ?? match.price,
      cost_price: match.cost_price ?? 0,
    };
  }

  if (raw) throw badRequest(`"${product.name}" does not track packs.`);
  return null;
}

/**
 * Stock of the ORIGINAL / big size (the product as first created) when the
 * product also carries packs: whatever is left in the total after every pack
 * bucket. Products without packs have no split, so their whole quantity is
 * the sellable amount. Derived on purpose — it can never drift from `quantity`.
 */
export function baseStockOf(product) {
  const packs = Array.isArray(product.packs) ? product.packs : [];
  if (!packs.length) return product.quantity ?? 0;
  const packSum = packs.reduce((sum, x) => sum + (x.quantity || 0), 0);
  return Math.max(0, (product.quantity ?? 0) - packSum);
}

/** Which bucket a line draws from: packs (label) wins over colors (color). */
const bucketOf = (color, pack) =>
  pack ? { arr: 'packs', key: 'label', value: pack } : color ? { arr: 'colors', key: 'color', value: color } : null;

/**
 * Atomically deducts `quantity` (and, when set, the same amount from the
 * color/pack bucket) inside the caller's transaction session. A pack-tracked
 * product called WITHOUT a pack deducts the big/original size (base_quantity).
 * Throws a clear 409 when stock is short — nothing is written in that case.
 */
export async function deductStock(session, product, quantity, color = null, pack = null) {
  const bucket = bucketOf(color, pack);
  // No bucket on a pack-tracked product = the big/original size.
  const isBase = !bucket && Array.isArray(product.packs) && product.packs.length > 0;
  if (isBase) {
    // Big size = total − every pack bucket; verify it before touching the total.
    const current = await Product.findById(product._id).session(session);
    if (!current) throw notFound('Product no longer exists.');
    const availableBase = baseStockOf(current);
    if (availableBase < quantity) {
      throw conflict(
        `Insufficient stock for "${current.name}" (big size): requested ${quantity}, available ${availableBase}.`
      );
    }
  }
  const query = { _id: product._id, quantity: { $gte: quantity } };
  const inc = { quantity: -quantity };
  if (bucket) {
    query[bucket.arr] = { $elemMatch: { [bucket.key]: bucket.value, quantity: { $gte: quantity } } };
    inc[`${bucket.arr}.$.quantity`] = -quantity;
  }

  const updated = await Product.findOneAndUpdate(query, { $inc: inc }, { new: true, session });
  if (updated) return updated;

  const fresh = await Product.findById(product._id).session(session);
  if (!fresh) throw notFound('Product no longer exists.');
  const available = isBase
    ? baseStockOf(fresh)
    : bucket
      ? fresh[bucket.arr].find((e) => String(e[bucket.key]).toLowerCase() === String(bucket.value).toLowerCase())?.quantity ?? 0
      : fresh.quantity;
  const suffix = isBase ? ' (big size)' : bucket ? ` (${bucket.value})` : '';
  throw conflict(
    `Insufficient stock for "${fresh.name}"${suffix}: requested ${quantity}, available ${available}.`
  );
}

/**
 * Returns `quantity` to stock inside the caller's transaction session,
 * crediting the color/pack bucket the line drew from. If that entry no
 * longer exists on the product (e.g. it was renamed), the entry is
 * recreated so total and bucket sums never drift apart.
 */
export async function restoreStock(session, { productId, quantity, color = null, pack = null }) {
  const bucket = bucketOf(color, pack);
  // No bucket (incl. the big size of a pack-tracked product): only the total
  // changes, and the big size is derived from it — so nothing else to credit.
  if (!bucket) {
    await Product.updateOne({ _id: productId }, { $inc: { quantity } }, { session });
    return;
  }
  const exact = new RegExp(`^${escapeRegex(bucket.value)}$`, 'i');
  const res = await Product.updateOne(
    { _id: productId, [`${bucket.arr}.${bucket.key}`]: exact },
    { $inc: { quantity, [`${bucket.arr}.$.quantity`]: quantity } },
    { session }
  );
  if (res.matchedCount === 0) {
    const entry = pack
      ? { label: bucket.value, price: 0, quantity }
      : { color: bucket.value, quantity };
    await Product.updateOne(
      { _id: productId },
      { $inc: { quantity }, $push: { [bucket.arr]: entry } },
      { session }
    );
  }
}

export const colorTotal = (colors) => colors.reduce((sum, c) => sum + c.quantity, 0);

/**
 * Normalises a product's `packs` array for API responses: legacy packs (saved
 * before MRP/cost existed) get `mrp` = their selling price and `cost_price` = 0,
 * and every pack gains `margin` / `margin_percent`.
 */
export function decoratePacks(packs) {
  if (!Array.isArray(packs)) return [];
  return packs.map((x) => {
    const mrp = x.mrp ?? x.price;
    const cost_price = x.cost_price ?? 0;
    return {
      ...x,
      mrp,
      cost_price,
      margin: Math.round((mrp - cost_price) * 100) / 100,
      margin_percent: cost_price > 0 ? Math.round(((mrp - cost_price) / cost_price) * 10000) / 100 : null,
    };
  });
}

/**
 * Cheap variant decoration for products embedded in order/bill responses:
 * normalised packs + the derived big-size stock (`base_quantity`), so clients
 * never have to recompute `total − packs` themselves.
 */
export function decorateProductVariants(product) {
  if (!product) return product;
  product.packs = decoratePacks(product.packs);
  product.base_quantity = baseStockOf(product);
  return product;
}
