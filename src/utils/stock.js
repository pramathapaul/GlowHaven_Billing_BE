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
 * Returns [{ label, price, quantity }] with unique, trimmed labels.
 */
export function normalizePacks(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw badRequest('packs must be an array of { label, price, quantity }.');
  if (raw.length > 50) throw badRequest('A product can track at most 50 packs.');

  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    const label = String(entry?.label ?? '').trim();
    const price = Number(entry?.price);
    const quantity = Number(entry?.quantity);
    if (!label) throw badRequest('Every pack needs a label.');
    if (label.length > 40) throw badRequest(`Pack label "${label.slice(0, 20)}…" is too long (max 40).`);
    if (!Number.isFinite(price) || price < 0) {
      throw badRequest(`Pack "${label}" needs a price of 0 or more.`);
    }
    if (!Number.isInteger(quantity) || quantity < 0) {
      throw badRequest(`Pack "${label}" needs a whole-number quantity of 0 or more.`);
    }
    const key = label.toLowerCase();
    if (seen.has(key)) throw badRequest(`Duplicate pack "${label}".`);
    seen.add(key);
    out.push({ label, price, quantity });
  }
  return out;
}

/**
 * Resolves the pack a line item must draw from.
 * - product WITHOUT packs -> null (a passed pack is an error)
 * - product WITH packs    -> the canonical stored label + its price (required)
 * Returns { label, price } or null.
 */
export function resolvePack(product, packValue) {
  const raw = packValue === undefined || packValue === null ? null : String(packValue).trim();
  const hasPacks = Array.isArray(product.packs) && product.packs.length > 0;

  if (hasPacks) {
    if (!raw) {
      throw badRequest(`"${product.name}" tracks stock by pack — please choose a pack.`);
    }
    const match = product.packs.find((p) => p.label.toLowerCase() === raw.toLowerCase());
    if (!match) {
      throw badRequest(
        `"${product.name}" has no pack "${raw}". Available: ${product.packs.map((p) => p.label).join(', ')}.`
      );
    }
    return { label: match.label, price: match.price };
  }

  if (raw) throw badRequest(`"${product.name}" does not track packs.`);
  return null;
}

/** Which bucket a line draws from: packs (label) wins over colors (color). */
const bucketOf = (color, pack) =>
  pack ? { arr: 'packs', key: 'label', value: pack } : color ? { arr: 'colors', key: 'color', value: color } : null;

/**
 * Atomically deducts `quantity` (and, when set, the same amount from the
 * color/pack bucket) inside the caller's transaction session. Throws a clear
 * 409 when stock is short — nothing is written in that case.
 */
export async function deductStock(session, product, quantity, color = null, pack = null) {
  const bucket = bucketOf(color, pack);
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
  const available = bucket
    ? fresh[bucket.arr].find((e) => String(e[bucket.key]).toLowerCase() === String(bucket.value).toLowerCase())?.quantity ?? 0
    : fresh.quantity;
  const suffix = bucket ? ` (${bucket.value})` : '';
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
