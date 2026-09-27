import { Router } from 'express';
import { body } from 'express-validator';
import { Customer } from '../models/Customer.js';
import { Order } from '../models/Order.js';
import { OrderItem } from '../models/OrderItem.js';
import { Bill } from '../models/Bill.js';
import { BillItem } from '../models/BillItem.js';
import { validate } from '../middleware/validate.js';
import { conflict, notFound } from '../utils/ApiError.js';
import { serialize, escapeRegex } from '../utils/serialize.js';

const router = Router();

const customerRules = [
  body('name').trim().notEmpty().withMessage('Customer name is required.')
    .isLength({ max: 200 }).withMessage('Name must be 200 characters or fewer.'),
  body('phone').trim().notEmpty().withMessage('Phone is required.')
    .matches(/^[\d+\-().\s]{7,30}$/).withMessage('Phone number looks invalid (digits, +, - and spaces only).'),
  body('phone2').optional({ nullable: true, checkFalsy: true })
    .trim().matches(/^[\d+\-().\s]{7,30}$/).withMessage('Second phone number looks invalid (digits, +, - and spaces only).'),
  body('email').optional({ nullable: true, checkFalsy: true })
    .trim().isEmail().withMessage('Enter a valid email address or leave it empty.')
    .isLength({ max: 200 }),
  body('address').optional({ nullable: true }).trim().isLength({ max: 500 }),
];

const clean = (value) =>
  value === undefined || value === null || String(value).trim() === '' ? null : String(value).trim();

function decorate(customer) {
  const c = serialize(customer);
  c.email = c.email || null;
  c.address = c.address || null;
  c.phone2 = c.phone2 || null;
  return c;
}

// List + search (name / phone / email)
router.get('/', async (req, res, next) => {
  try {
    const { search } = req.query;
    const q = {};
    if (search && String(search).trim()) {
      const rx = new RegExp(escapeRegex(String(search).trim()), 'i');
      q.$or = [{ name: rx }, { phone: rx }, { phone2: rx }, { email: rx }];
    }
    const customers = await Customer.find(q).sort({ name: 1 }).exec();
    res.json({ customers: customers.map(decorate) });
  } catch (err) {
    next(err);
  }
});

// Detail + order/bill history
router.get('/:id', async (req, res, next) => {
  try {
    const customer = await Customer.findById(req.params.id);
    if (!customer) throw notFound('Customer not found.');

    const orders = await Order.find({ customer_id: customer._id })
      .sort({ created_at: -1 })
      .lean();
    const bills = await Bill.find({ customer_id: customer._id })
      .sort({ created_at: -1 })
      .lean();

    const orderItems = orders.length
      ? await OrderItem.find({ order_id: { $in: orders.map((o) => o._id) } }).lean()
      : [];
    const billItems = bills.length
      ? await BillItem.find({ bill_id: { $in: bills.map((b) => b._id) } }).lean()
      : [];

    const itemsByOrder = new Map();
    for (const item of orderItems) {
      const key = String(item.order_id);
      if (!itemsByOrder.has(key)) itemsByOrder.set(key, []);
      itemsByOrder.get(key).push(item);
    }
    const itemsByBill = new Map();
    for (const item of billItems) {
      const key = String(item.bill_id);
      if (!itemsByBill.has(key)) itemsByBill.set(key, []);
      itemsByBill.get(key).push(item);
    }

    const orderHistory = orders.map((o) => {
      const its = itemsByOrder.get(String(o._id)) || [];
      const active = its.filter((i) => !i.excluded_from_bill);
      return {
        ...serialize(o),
        customer_id: String(o.customer_id),
        items_count: active.length,
        total: Math.round(active.reduce((sum, i) => sum + i.quantity * i.price_at_order, 0) * 100) / 100,
      };
    });

    const billHistory = bills.map((b) => ({
      ...serialize(b),
      customer_id: String(b.customer_id),
      order_id: b.order_id ? String(b.order_id) : null,
      items_count: (itemsByBill.get(String(b._id)) || []).length,
    }));

    res.json({
      customer: decorate(customer),
      orders: orderHistory,
      bills: billHistory,
    });
  } catch (err) {
    next(err);
  }
});

// Create
router.post('/', customerRules, validate, async (req, res, next) => {
  try {
    const customer = await Customer.create({
      name: String(req.body.name).trim(),
      phone: String(req.body.phone).trim(),
      phone2: clean(req.body.phone2),
      email: clean(req.body.email),
      address: clean(req.body.address),
    });
    res.status(201).json({ customer: decorate(customer) });
  } catch (err) {
    next(err);
  }
});

// Update
router.put('/:id', customerRules, validate, async (req, res, next) => {
  try {
    const customer = await Customer.findById(req.params.id);
    if (!customer) throw notFound('Customer not found.');
    customer.name = String(req.body.name).trim();
    customer.phone = String(req.body.phone).trim();
    customer.phone2 = clean(req.body.phone2);
    customer.email = clean(req.body.email);
    customer.address = clean(req.body.address);
    await customer.save();
    res.json({ customer: decorate(customer) });
  } catch (err) {
    next(err);
  }
});

// Delete (blocked while active orders or bills reference the customer;
// cancelled orders do not block)
router.delete('/:id', async (req, res, next) => {
  try {
    const customer = await Customer.findById(req.params.id);
    if (!customer) throw notFound('Customer not found.');
    const [activeOrderCount, billCount] = await Promise.all([
      Order.countDocuments({ customer_id: customer._id, status: { $ne: 'cancelled' } }),
      Bill.countDocuments({ customer_id: customer._id }),
    ]);
    if (activeOrderCount > 0 || billCount > 0) {
      const parts = [];
      if (activeOrderCount) parts.push(`${activeOrderCount} active order(s)`);
      if (billCount) parts.push(`${billCount} bill(s)`);
      throw conflict(`Cannot delete "${customer.name}": linked to ${parts.join(' and ')}.`);
    }
    await customer.deleteOne();
    res.json({ message: `Customer "${customer.name}" deleted.`, id: String(customer._id) });
  } catch (err) {
    next(err);
  }
});

export default router;
