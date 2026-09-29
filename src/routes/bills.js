import { Router } from 'express';
import { body } from 'express-validator';
import { Bill } from '../models/Bill.js';
import { BillItem } from '../models/BillItem.js';
import { Order } from '../models/Order.js';
import { OrderItem } from '../models/OrderItem.js';
import { Product } from '../models/Product.js';
import { Customer } from '../models/Customer.js';
import { validate } from '../middleware/validate.js';
import { badRequest, conflict, notFound } from '../utils/ApiError.js';
import { withTransaction } from '../utils/withTransaction.js';
import { serialize } from '../utils/serialize.js';
import { calcBillTotals, toPaise } from '../utils/money.js';
import { resolveColor, deductStock, restoreStock } from '../utils/stock.js';

const router = Router();
const BILLABLE_ORDER_STATUSES = ['draft', 'confirmed'];

const standaloneRules = [
  body('customerId').isMongoId().withMessage('Select a customer.'),
  body('items').isArray({ min: 1, max: 100 }).withMessage('Add at least one item to the bill.'),
  body('items.*.productId').isMongoId().withMessage('Each item needs a valid product.'),
  body('items.*.quantity').isInt({ min: 1 }).withMessage('Each item quantity must be at least 1.').toInt(),
  body('items.*.price').optional({ nullable: true }).isFloat({ min: 0 }).withMessage('Price cannot be negative.').toFloat(),
  body('items.*.color').optional({ nullable: true }).trim()
    .isLength({ max: 40 }).withMessage('Color name must be 40 characters or fewer.'),
];

function parseRate(value, name) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw badRequest(`${name} must be a percentage between 0 and 100.`);
  }
  return n;
}

function parseAmount(value, name) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw badRequest(`${name} must be a positive amount.`);
  }
  return n;
}

async function billView(bill) {
  const [items, customer] = await Promise.all([
    BillItem.find({ bill_id: bill._id })
      .populate('product_id', 'name sku unit mrp selling_price')
      .lean(),
    Customer.findById(bill.customer_id).lean(),
  ]);
  const order = bill.order_id ? await Order.findById(bill.order_id).lean() : null;

  return {
    ...serialize(bill),
    customer_id: String(bill.customer_id),
    order_id: bill.order_id ? String(bill.order_id) : null,
    delivery_charge: bill.delivery_charge || 0,
    customer: customer
      ? {
          id: String(customer._id),
          name: customer.name,
          phone: customer.phone,
          phone2: customer.phone2 || null,
          email: customer.email || null,
          address: customer.address || null,
        }
      : null,
    order: order
      ? { id: String(order._id), status: order.status, created_at: order.created_at }
      : null,
    items: items.map((i) => {
      const product = i.product_id ? serialize(i.product_id) : null;
      return {
        ...serialize(i),
        bill_id: String(bill._id),
        product_id: product ? product.id : String(i.product_id),
        product,
        mrp: product?.mrp ?? null,
        line_total: Math.round(i.quantity * i.price * 100) / 100,
      };
    }),
  };
}

// List bills (optionally by customer)
router.get('/', async (req, res, next) => {
  try {
    const q = {};
    if (req.query.customerId) q.customer_id = req.query.customerId;
    const bills = await Bill.find(q).sort({ created_at: -1 }).lean();

    const customerIds = bills.map((b) => b.customer_id);
    const customers = customerIds.length
      ? await Customer.find({ _id: { $in: customerIds } }).lean()
      : [];
    const cmap = new Map(customers.map((c) => [String(c._id), { id: String(c._id), name: c.name, phone: c.phone, phone2: c.phone2 || null }]));

    res.json({
      bills: bills.map((b) => ({
        ...serialize(b),
        customer_id: String(b.customer_id),
        order_id: b.order_id ? String(b.order_id) : null,
        customer: cmap.get(String(b.customer_id)) || null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Bill detail (printable/exportable)
router.get('/:id', async (req, res, next) => {
  try {
    const bill = await Bill.findById(req.params.id);
    if (!bill) throw notFound('Bill not found.');
    res.json({ bill: await billView(bill) });
  } catch (err) {
    next(err);
  }
});

// CSV export of a bill
router.get('/:id/csv', async (req, res, next) => {
  try {
    const bill = await Bill.findById(req.params.id);
    if (!bill) throw notFound('Bill not found.');
    const view = await billView(bill);

    const esc = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = [
      ['Bill ID', view.id],
      ['Date', new Date(view.created_at).toISOString()],
      ['Customer', view.customer ? view.customer.name : ''],
      ['Phone', view.customer ? view.customer.phone : ''],
      ['Phone 2', view.customer ? view.customer.phone2 || '' : ''],
      ['Email', view.customer ? view.customer.email || '' : ''],
      ['Address', view.customer ? view.customer.address || '' : ''],
      ['Order', view.order_id || 'Standalone'],
      [],
      ['Product', 'SKU', 'MRP', 'Color', 'Quantity', 'Discounted Price', 'Line Total'],
      ...view.items.map((i) => [
        i.product ? i.product.name : '',
        i.product ? i.product.sku : '',
        i.mrp ?? '',
        i.color || '',
        i.quantity,
        i.price,
        i.line_total,
      ]),
      [],
      ['Subtotal', view.subtotal],
      ['Delivery charge', view.delivery_charge],
      [`Discount (${view.discount_rate}%)`, view.discount],
      ['Total', view.total],
    ];
    const csv = rows.map((r) => r.map(esc).join(',')).join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bill-${view.id}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

// Delete a bill.
// Standalone bill  -> its stock was deducted at bill time, so give it back.
// Order bill       -> stock still belongs to the order; the order is reopened
//                     as "confirmed" so it can be billed again.
router.delete('/:id', async (req, res, next) => {
  try {
    const result = await withTransaction(async (session) => {
      const bill = await Bill.findById(req.params.id).session(session);
      if (!bill) throw notFound('Bill not found.');

      const items = await BillItem.find({ bill_id: bill._id }).session(session);
      let order = null;
      let restored = 0;

      if (bill.order_id) {
        order = await Order.findById(bill.order_id).session(session);
        if (order && order.status === 'billed') {
          order.status = 'confirmed';
          await order.save({ session });
        }
      } else {
        for (const item of items) {
          await restoreStock(session, {
            productId: item.product_id,
            quantity: item.quantity,
            color: item.color,
          });
          restored += item.quantity;
        }
      }

      await BillItem.deleteMany({ bill_id: bill._id }).session(session);
      await Bill.deleteOne({ _id: bill._id }).session(session);

      return { id: String(bill._id), order, restored };
    });

    const suffix = result.id.slice(-8);
    const message = result.order
      ? `Bill #${suffix} deleted. Order #${String(result.order._id).slice(-8)} is confirmed again and can be re-billed.`
      : `Bill #${suffix} deleted. ${result.restored} unit(s) returned to stock.`;

    res.json({
      message,
      id: result.id,
      order: result.order
        ? { ...serialize(result.order), customer_id: String(result.order.customer_id) }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Billing checkbox toggle (order billing preview).
// include=false -> restore stock & exclude the line from the bill
// include=true  -> validate stock & deduct it again
// ---------------------------------------------------------------------------
router.post('/toggle-item', async (req, res, next) => {
  try {
    const { orderId, itemId, include } = req.body || {};
    if (!orderId || !itemId || typeof include !== 'boolean') {
      throw badRequest('orderId, itemId and include (boolean) are required.');
    }

    const outcome = await withTransaction(async (session) => {
      const order = await Order.findById(orderId).session(session);
      if (!order) throw notFound('Order not found.');
      if (!BILLABLE_ORDER_STATUSES.includes(order.status)) {
        throw conflict(`Cannot change billing selection on a ${order.status} order.`);
      }

      const item = await OrderItem.findOne({ _id: itemId, order_id: order._id }).session(session);
      if (!item) throw notFound('Order item not found.');

      if (include && item.excluded_from_bill) {
        const product = await Product.findById(item.product_id).session(session);
        if (!product) throw notFound('The product for this line no longer exists.');
        if (product.deleted_at) {
          throw conflict(`"${product.name}" was deleted and cannot be re-included in the bill.`);
        }
        if (item.color) {
          const hasColor = (product.colors || []).some(
            (c) => c.color.toLowerCase() === item.color.toLowerCase()
          );
          if (!hasColor) {
            throw conflict(
              `"${product.name}" no longer offers the color "${item.color}". Re-add the line item instead.`
            );
          }
        }

        const updated = await deductStock(session, product, item.quantity, item.color);
        item.excluded_from_bill = false;
        await item.save({ session });
        return {
          item,
          product: updated,
          message: `Included — ${item.quantity} unit(s)${item.color ? ` (${item.color})` : ''} deducted again (stock: ${updated.quantity}).`,
        };
      }

      if (!include && !item.excluded_from_bill) {
        await restoreStock(session, {
          productId: item.product_id,
          quantity: item.quantity,
          color: item.color,
        });
        item.excluded_from_bill = true;
        await item.save({ session });
        const product = await Product.findById(item.product_id).session(session);
        return {
          item,
          product,
          message: `Excluded — ${item.quantity} unit(s)${item.color ? ` (${item.color})` : ''} restored to stock (now ${product ? product.quantity : '?'}).`,
        };
      }

      const product = await Product.findById(item.product_id).session(session);
      return { item, product, message: 'No change.' };
    });

    const product = outcome.product ? serialize(outcome.product) : null;
    res.json({
      item: {
        ...serialize(outcome.item),
        order_id: String(outcome.item.order_id),
        product_id: String(outcome.item.product_id),
      },
      product,
      message: outcome.message,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// (a) Create a bill from an existing order (checked = non-excluded items)
// ---------------------------------------------------------------------------
router.post('/from-order/:orderId', async (req, res, next) => {
  try {
    const discountRate = parseRate(req.body?.discountRate, 'Discount rate');
    const deliveryCharge = parseAmount(req.body?.deliveryCharge, 'Delivery charge');
    const requestedIds = req.body?.itemIds;

    if (requestedIds !== undefined && !Array.isArray(requestedIds)) {
      throw badRequest('itemIds must be an array of order item ids.');
    }

    const bill = await withTransaction(async (session) => {
      const order = await Order.findById(req.params.orderId).session(session);
      if (!order) throw notFound('Order not found.');
      if (!BILLABLE_ORDER_STATUSES.includes(order.status)) {
        throw conflict(`Order is already ${order.status}; a bill cannot be created.`);
      }

      const billable = await OrderItem.find({ order_id: order._id, excluded_from_bill: false })
        .session(session);
      if (billable.length === 0) {
        throw badRequest('This order has no billable items left (all were excluded).');
      }

      let selected = billable;
      if (Array.isArray(requestedIds)) {
        const billableIds = new Set(billable.map((i) => String(i._id)));
        const unknown = requestedIds.filter((id) => !billableIds.has(String(id)));
        if (unknown.length) {
          throw conflict('One or more selected items are excluded from this bill or not part of the order.');
        }
        selected = billable.filter((i) => requestedIds.includes(String(i._id)));
        if (selected.length === 0) throw badRequest('Select at least one item to bill.');
      }

      const subtotalPaise = selected.reduce(
        (sum, i) => sum + toPaise(i.price_at_order) * i.quantity,
        0
      );
      const totals = calcBillTotals({ subtotalPaise, deliveryPaise: toPaise(deliveryCharge), discountRate });

      const billDoc = new Bill({
        order_id: order._id,
        customer_id: order.customer_id,
        ...totals,
        discount_rate: discountRate,
      });
      await billDoc.save({ session });

      await BillItem.insertMany(
        selected.map((i) => ({
          bill_id: billDoc._id,
          product_id: i.product_id,
          quantity: i.quantity,
          price: i.price_at_order,
          color: i.color || null,
        })),
        { session }
      );

      order.status = 'billed';
      await order.save({ session });

      return billDoc;
    });

    res.status(201).json({ bill: await billView(bill) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// (b) Standalone bill — same stock-deduction + validation rules as orders,
//     all deducted and persisted inside one transaction.
// ---------------------------------------------------------------------------
router.post('/standalone', standaloneRules, validate, async (req, res, next) => {
  try {
    const discountRate = parseRate(req.body.discountRate, 'Discount rate');
    const deliveryCharge = parseAmount(req.body.deliveryCharge, 'Delivery charge');
    const entries = req.body.items;

    const bill = await withTransaction(async (session) => {
      const customer = await Customer.findById(req.body.customerId).session(session);
      if (!customer) throw notFound('Customer not found.');

      // ---- pass 1: validate every line (collect all problems at once) ----
      const lines = [];
      const errors = [];
      const pendingTotal = new Map(); // productId -> qty
      const pendingColor = new Map(); // productId|color -> qty

      for (const entry of entries) {
        const product = await Product.findOne({ _id: entry.productId, deleted_at: null }).session(session);
        if (!product) {
          errors.push('A selected product no longer exists or has been deleted.');
          continue;
        }

        let color;
        try {
          color = resolveColor(product, entry.color);
        } catch (err) {
          errors.push(err.message);
          continue;
        }

        const totalKey = String(product._id);
        const colorKey = `${product._id}|${(color || '').toLowerCase()}`;

        const availableTotal = product.quantity - (pendingTotal.get(totalKey) || 0);
        const colorEntry = color
          ? product.colors.find((c) => c.color.toLowerCase() === color.toLowerCase())
          : null;
        const availableVariant = colorEntry
          ? colorEntry.quantity - (pendingColor.get(colorKey) || 0)
          : availableTotal;

        if (entry.quantity > availableVariant) {
          const suffix = color ? ` (${color})` : '';
          errors.push(
            `Insufficient stock for "${product.name}"${suffix}: requested ${entry.quantity}, available ${availableVariant}.`
          );
          continue;
        }

        pendingTotal.set(totalKey, (pendingTotal.get(totalKey) || 0) + entry.quantity);
        if (color) pendingColor.set(colorKey, (pendingColor.get(colorKey) || 0) + entry.quantity);

        lines.push({
          product,
          quantity: entry.quantity,
          color,
          price: entry.price ?? (product.selling_price ?? product.mrp),
        });
      }

      if (errors.length) throw badRequest([...new Set(errors)].join(' '));
      if (!lines.length) throw badRequest('Add at least one item to the bill.');

      // ---- pass 2: atomic stock deduction (guards re-check inside txn) ----
      for (const line of lines) {
        await deductStock(session, line.product, line.quantity, line.color);
      }

      const subtotalPaise = lines.reduce(
        (sum, l) => sum + toPaise(l.price) * l.quantity,
        0
      );
      const totals = calcBillTotals({ subtotalPaise, deliveryPaise: toPaise(deliveryCharge), discountRate });

      const billDoc = new Bill({
        order_id: null,
        customer_id: customer._id,
        ...totals,
        discount_rate: discountRate,
      });
      await billDoc.save({ session });

      await BillItem.insertMany(
        lines.map((l) => ({
          bill_id: billDoc._id,
          product_id: l.product._id,
          quantity: l.quantity,
          price: l.price,
          color: l.color || null,
        })),
        { session }
      );

      return billDoc;
    });

    res.status(201).json({ bill: await billView(bill) });
  } catch (err) {
    next(err);
  }
});

export default router;
