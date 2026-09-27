import { Router } from 'express';
import { body } from 'express-validator';
import { Product } from '../models/Product.js';
import { validate } from '../middleware/validate.js';
import { badRequest, conflict, notFound } from '../utils/ApiError.js';
import { serialize, escapeRegex } from '../utils/serialize.js';
import { normalizeColors, normalizePacks } from '../utils/stock.js';
import { LOW_STOCK_THRESHOLD } from '../config/db.js';

const router = Router();

const productRules = [
  body('name').trim().notEmpty().withMessage('Product name is required.')
    .isLength({ max: 200 }).withMessage('Name must be 200 characters or fewer.'),
  body('sku').trim().notEmpty().withMessage('SKU is required.')
    .isLength({ max: 60 }).withMessage('SKU must be 60 characters or fewer.'),
  body('category').trim().notEmpty().withMessage('Category is required.'),
  body('unit').trim().notEmpty().withMessage('Unit is required.'),
  // Optional: when the product tracks colors/packs the total is derived from them.
  body('quantity').optional().isFloat({ min: 0 }).withMessage('Quantity must be 0 or more.').toFloat(),
  body('mrp').isFloat({ min: 0 }).withMessage('MRP must be 0 or more.').toFloat(),
  body('selling_price').optional({ nullable: true }).isFloat({ min: 0 }).withMessage('Selling price must be 0 or more.').toFloat(),
  body('cost_price').isFloat({ min: 0 }).withMessage('Cost price must be 0 or more.').toFloat(),
];

/** Total = sum of color/pack buckets when tracked, else the given quantity.
 *  Colors and packs are mutually exclusive (a product tracks one or the other). */
function resolveVariants(body) {
  const colors = normalizeColors(body.colors);
  const packs = normalizePacks(body.packs);
  if (colors.length > 0 && packs.length > 0) {
    throw badRequest('A product can track stock by colors OR packs, not both.');
  }
  if (packs.length > 0) {
    return {
      colors: [],
      packs,
      quantity: packs.reduce((sum, p) => sum + p.quantity, 0),
    };
  }
  if (colors.length > 0) {
    return {
      colors,
      packs: [],
      quantity: colors.reduce((sum, c) => sum + c.quantity, 0),
    };
  }
  const quantity = Number(body.quantity);
  if (body.quantity === undefined || body.quantity === null || body.quantity === '') {
    throw badRequest('Quantity is required when the product has no colors or packs.');
  }
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw badRequest('Quantity must be a whole number of 0 or more.');
  }
  return { colors: [], packs: [], quantity };
}

function decorate(product) {
  const p = serialize(product);
  p.selling_price = p.selling_price ?? p.mrp;
  p.margin = Math.round((p.mrp - p.cost_price) * 100) / 100;
  p.margin_percent = p.cost_price > 0 ? Math.round(((p.mrp - p.cost_price) / p.cost_price) * 10000) / 100 : null;
  p.is_deleted = Boolean(p.deleted_at);
  p.low_stock = p.quantity <= LOW_STOCK_THRESHOLD;
  p.colors = Array.isArray(p.colors) ? p.colors : [];
  p.tracks_colors = p.colors.length > 0;
  p.packs = Array.isArray(p.packs) ? p.packs : [];
  p.tracks_packs = p.packs.length > 0;
  return p;
}

// List + search (name / sku / category), low-stock filter, soft-delete filter
router.get('/', async (req, res, next) => {
  try {
    const { search, category, lowStock, includeDeleted } = req.query;
    const threshold = req.query.threshold !== undefined ? Number(req.query.threshold) : LOW_STOCK_THRESHOLD;
    const q = {};
    if (includeDeleted !== 'true') q.deleted_at = null;
    if (category) q.category = String(category);
    if (search && String(search).trim()) {
      const rx = new RegExp(escapeRegex(String(search).trim()), 'i');
      q.$or = [{ name: rx }, { sku: rx }, { category: rx }];
    }
    if (lowStock === 'true' || lowStock === '1') {
      q.quantity = { $lte: Number.isFinite(threshold) ? threshold : LOW_STOCK_THRESHOLD };
    }
    const products = await Product.find(q).sort({ name: 1 }).exec();
    res.json({ products: products.map(decorate), threshold: LOW_STOCK_THRESHOLD });
  } catch (err) {
    next(err);
  }
});

// Distinct categories (for filter dropdowns)
router.get('/categories', async (req, res, next) => {
  try {
    const categories = await Product.distinct('category', { deleted_at: null });
    res.json({ categories: categories.sort() });
  } catch (err) {
    next(err);
  }
});

// Detail: quantity, MRP, cost price, margin
router.get('/:id', async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) throw notFound('Product not found.');
    res.json({ product: decorate(product) });
  } catch (err) {
    next(err);
  }
});

// Create
router.post('/', productRules, validate, async (req, res, next) => {
  try {
    const { colors, packs, quantity } = resolveVariants(req.body);
    const normalisedSku = String(req.body.sku).trim().toUpperCase();
    const existing = await Product.findOne({ sku: normalisedSku });
    if (existing) throw conflict(`SKU "${normalisedSku}" already exists${existing.deleted_at ? ' (soft-deleted)' : ''}.`);
    const product = await Product.create({
      name: String(req.body.name).trim(),
      sku: normalisedSku,
      category: String(req.body.category).trim(),
      unit: String(req.body.unit).trim(),
      quantity,
      colors,
      packs,
      mrp: req.body.mrp,
      selling_price: req.body.selling_price ?? req.body.mrp,
      cost_price: req.body.cost_price,
    });
    res.status(201).json({ product: decorate(product) });
  } catch (err) {
    next(err);
  }
});

// Update
router.put('/:id', productRules, validate, async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) throw notFound('Product not found.');
    if (product.deleted_at) throw conflict('This product is deleted. Restore it before editing.');
    const { colors, packs, quantity } = resolveVariants(req.body);
    const normalisedSku = String(req.body.sku).trim().toUpperCase();
    const clash = await Product.findOne({ sku: normalisedSku, _id: { $ne: product._id } });
    if (clash) throw conflict(`SKU "${normalisedSku}" already exists.`);
    product.name = String(req.body.name).trim();
    product.sku = normalisedSku;
    product.category = String(req.body.category).trim();
    product.unit = String(req.body.unit).trim();
    product.quantity = quantity;
    product.colors = colors;
    product.packs = packs;
    product.mrp = req.body.mrp;
    product.selling_price = req.body.selling_price ?? req.body.mrp;
    product.cost_price = req.body.cost_price;
    await product.save();
    res.json({ product: decorate(product) });
  } catch (err) {
    next(err);
  }
});

// Soft-delete
router.delete('/:id', async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) throw notFound('Product not found.');
    if (!product.deleted_at) {
      product.deleted_at = new Date();
      await product.save();
    }
    res.json({ product: decorate(product), message: `"${product.name}" was deleted (soft).` });
  } catch (err) {
    next(err);
  }
});

// Undo soft-delete
router.post('/:id/restore', async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) throw notFound('Product not found.');
    product.deleted_at = null;
    await product.save();
    res.json({ product: decorate(product), message: `"${product.name}" was restored.` });
  } catch (err) {
    next(err);
  }
});

export default router;
