import { Router } from 'express';
import { body } from 'express-validator';
import { Order, ORDER_STATUSES } from '../models/Order.js';
import { OrderItem } from '../models/OrderItem.js';
import { Product } from '../models/Product.js';
import { Customer } from '../models/Customer.js';
import { validate } from '../middleware/validate.js';
import { conflict, notFound } from '../utils/ApiError.js';
import { withTransaction } from '../utils/withTransaction.js';
import { serialize } from '../utils/serialize.js';
import { resolveColor, resolvePack, deductStock, restoreStock, decoratePacks } from '../utils/stock.js';

const router = Router();

const EDITABLE_STATUSES = ['draft', 'confirmed'];

function assertEditable(order) {
  if (!EDITABLE_STATUSES.includes(order.status)) {
    throw conflict(`Cannot modify items of a ${order.status} order.`);
  }
}

async function loadCustomerMap(customerIds) {
  const unique = [...new Set(customerIds.filter(Boolean).map(String))];
  if (!unique.length) return new Map();
  const customers = await Customer.find({ _id: { $in: unique } }).lean();
  return new Map(customers.map((c) => [String(c._id), { id: String(c._id), name: c.name, phone: c.phone }]));
}

function orderSummary(order, items, customerMap) {
  const active = items.filter((i) => !i.excluded_from_bill);
  return {
    ...serialize(order),
    customer_id: String(order.customer_id),
    customer: customerMap.get(String(order.customer_id)) || null,
    items_count: active.length,
    total: Math.round(active.reduce((sum, i) => sum + i.quantity * i.price_at_order, 0) * 100) / 100,
  };
}

// List orders (filter by status / customer)
router.get('/', async (req, res, next) => {
  try {
    const { status, customerId } = req.query;
    const q = {};
    if (status && ORDER_STATUSES.includes(status)) q.status = status;
    if (customerId) q.customer_id = customerId;

    const orders = await Order.find(q).sort({ created_at: -1 }).lean();
    const items = orders.length
      ? await OrderItem.find({ order_id: { $in: orders.map((o) => o._id) } }).lean()
      : [];
    const customerMap = await loadCustomerMap(orders.map((o) => o.customer_id));

    const itemsByOrder = new Map();
    for (const item of items) {
      const key = String(item.order_id);
      if (!itemsByOrder.has(key)) itemsByOrder.set(key, []);
      itemsByOrder.get(key).push(item);
    }

    res.json({
      orders: orders.map((o) => orderSummary(o, itemsByOrder.get(String(o._id)) || [], customerMap)),
    });
  } catch (err) {
    next(err);
  }
});

// Order detail (items + product availability + customer)
router.get('/:id', async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id).lean();
    if (!order) throw notFound('Order not found.');

    const items = await OrderItem.find({ order_id: order._id })
      .populate('product_id', 'name sku unit mrp selling_price quantity colors packs deleted_at')
      .lean();
    const customer = await Customer.findById(order.customer_id).lean();

    res.json({
      order: {
        ...serialize(order),
        customer_id: String(order.customer_id),
        customer: customer
          ? { id: String(customer._id), name: customer.name, phone: customer.phone, email: customer.email }
          : null,
        items: items.map((i) => {
          const product = i.product_id ? serialize(i.product_id) : null;
          if (product) product.packs = decoratePacks(product.packs);
          return {
            ...serialize(i),
            order_id: String(order._id),
            product_id: product ? product.id : String(i.product_id),
            product,
          };
        }),
        total: Math.round(
          items
            .filter((i) => !i.excluded_from_bill)
            .reduce((sum, i) => sum + i.quantity * i.price_at_order, 0) * 100
        ) / 100,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Create an empty draft order for a customer
router.post(
  '/',
  [body('customerId').isMongoId().withMessage('Select a valid customer.')],
  validate,
  async (req, res, next) => {
    try {
      const customer = await Customer.findById(req.body.customerId);
      if (!customer) throw notFound('Customer not found.');
      const order = await Order.create({ customer_id: customer._id, status: 'draft' });
      res.status(201).json({
        order: { ...serialize(order), customer_id: String(order.customer_id), items: [] },
      });
    } catch (err) {
      next(err);
    }
  }
);

// Add a line item — deducts stock atomically in the same transaction
router.post(
  '/:id/items',
  [
    body('productId').isMongoId().withMessage('Select a valid product.'),
    body('quantity').isInt({ min: 1 }).withMessage('Quantity must be at least 1.').toInt(),
    body('color').optional({ nullable: true }).trim()
      .isLength({ max: 40 }).withMessage('Color name must be 40 characters or fewer.'),
    body('pack').optional({ nullable: true }).trim()
      .isLength({ max: 40 }).withMessage('Pack label must be 40 characters or fewer.'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { productId, quantity } = req.body;

      const result = await withTransaction(async (session) => {
        const order = await Order.findById(req.params.id).session(session);
        if (!order) throw notFound('Order not found.');
        assertEditable(order);

        const product = await Product.findOne({ _id: productId, deleted_at: null }).session(session);
        if (!product) throw notFound('Product not found or has been deleted.');

        // Color is mandatory when the product tracks colors, forbidden otherwise.
        const color = resolveColor(product, req.body.color);
        // Pack is mandatory when the product tracks packs, forbidden otherwise.
        const pack = resolvePack(product, req.body.pack);

        // Atomic guard: only deduct when enough stock (total + bucket) is still there.
        const deducted = await deductStock(session, product, quantity, color, pack ? pack.label : null);

        const [item] = await OrderItem.create(
          [
            {
              order_id: order._id,
              product_id: product._id,
              quantity,
              // Pack products bill at the pack's own price; everything else at the selling price.
              price_at_order: pack ? pack.price : (product.selling_price ?? product.mrp),
              color,
              pack: pack ? pack.label : null,
            },
          ],
          { session }
        );

        return { item, product: deducted };
      });

      const item = serialize(result.item);
      const product = serialize(result.product);
      product.packs = decoratePacks(product.packs);
      const suffix = item.color || item.pack ? ` (${item.color || item.pack})` : '';
      res.status(201).json({
        item: {
          ...item,
          order_id: String(result.item.order_id),
          product_id: product.id,
          product,
        },
        message: `Added ${quantity} × ${product.name}${suffix}. Stock is now ${product.quantity}.`,
      });
    } catch (err) {
      next(err);
    }
  }
);

// Remove a line item — restores the deducted stock (pre-bill only)
router.delete('/:id/items/:itemId', async (req, res, next) => {
  try {
    const result = await withTransaction(async (session) => {
      const order = await Order.findById(req.params.id).session(session);
      if (!order) throw notFound('Order not found.');
      assertEditable(order);

      const item = await OrderItem.findOne({ _id: req.params.itemId, order_id: order._id }).session(session);
      if (!item) throw notFound('Order item not found.');

      let product = null;
      if (!item.excluded_from_bill) {
        // Stock was deducted when this item was added → give it back
        // (to the right color/pack bucket when one was used).
        await restoreStock(session, {
          productId: item.product_id,
          quantity: item.quantity,
          color: item.color,
          pack: item.pack,
        });
        product = await Product.findById(item.product_id).session(session);
      }
      await OrderItem.deleteOne({ _id: item._id }).session(session);
      return { item, product };
    });

    const product = result.product ? serialize(result.product) : null;
    if (product) product.packs = decoratePacks(product.packs);
    const suffix = result.item.color || result.item.pack ? ` (${result.item.color || result.item.pack})` : '';
    res.json({
      message: product
        ? `Item removed. ${quantityWord(result.item.quantity)}${suffix} returned to stock (now ${product.quantity}).`
        : 'Item removed.',
      product,
    });
  } catch (err) {
    next(err);
  }
});

function quantityWord(qty) {
  return `${qty} unit${qty === 1 ? '' : 's'}`;
}

// Status transitions: draft -> confirmed -> billed (via billing) / cancelled
router.patch(
  '/:id/status',
  [body('status').isIn(ORDER_STATUSES).withMessage('Invalid order status.')],
  validate,
  async (req, res, next) => {
    try {
      const nextStatus = req.body.status;

      const updated = await withTransaction(async (session) => {
        const order = await Order.findById(req.params.id).session(session);
        if (!order) throw notFound('Order not found.');
        if (order.status === nextStatus) {
          throw conflict(`Order is already ${nextStatus}.`);
        }

        const allowed = { draft: ['confirmed', 'cancelled'], confirmed: ['cancelled'], billed: [], cancelled: [] };
        if (!allowed[order.status].includes(nextStatus)) {
          if (nextStatus === 'billed') {
            throw conflict('Orders become "billed" automatically when a bill is created from them.');
          }
          throw conflict(`Invalid status change: ${order.status} → ${nextStatus}.`);
        }

        if (nextStatus === 'cancelled') {
          // Restore stock for every item that still holds deducted stock
          // (items excluded during billing already had their stock restored).
          const items = await OrderItem.find({ order_id: order._id, excluded_from_bill: false }).session(session);
          for (const item of items) {
            await restoreStock(session, {
              productId: item.product_id,
              quantity: item.quantity,
              color: item.color,
              pack: item.pack,
            });
          }
        }

        order.status = nextStatus;
        await order.save({ session });
        return order;
      });

      res.json({ order: { ...serialize(updated), customer_id: String(updated.customer_id) } });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
