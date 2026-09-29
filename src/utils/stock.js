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
 * Atomically deducts `quantity` (and, when set, the same amount from the
 * color bucket) inside the caller's transaction session.
 * Throws a clear 409 when stock is short — nothing is written in that case.
 */
export async function deductStock(session, product, quantity, color = null) {
  const bucket = color ? { arr: 'colors', key: 'color', value: color } : null;

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
 * crediting the color bucket the line drew from. If that entry no longer
 * exists on the product (e.g. it was renamed), the entry is recreated so
 * total and bucket sums never drift apart.
 */
export async function restoreStock(session, { productId, quantity, color = null }) {
  if (!color) {
    await Product.updateOne({ _id: productId }, { $inc: { quantity } }, { session });
    return;
  }
  const exact = new RegExp(`^${escapeRegex(color)}$`, 'i');
  const res = await Product.updateOne(
    { _id: productId, 'colors.color': exact },
    { $inc: { quantity, 'colors.$.quantity': quantity } },
    { session }
  );
  if (res.matchedCount === 0) {
    await Product.updateOne(
      { _id: productId },
      { $inc: { quantity }, $push: { colors: { color, quantity } } },
      { session }
    );
  }
}

export const colorTotal = (colors) => colors.reduce((sum, c) => sum + c.quantity, 0);
