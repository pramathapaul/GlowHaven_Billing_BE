/**
 * Seeds the database with sample data.
 *   npm run seed              (drops the database first)
 *   npm run seed -- --no-drop (keeps existing data, adds samples)
 */
import mongoose from 'mongoose';
import { connectDB } from './config/db.js';
import { Product } from './models/Product.js';
import { Customer } from './models/Customer.js';
import { Order } from './models/Order.js';
import { OrderItem } from './models/OrderItem.js';
import { Bill } from './models/Bill.js';
import { BillItem } from './models/BillItem.js';
import { withTransaction } from './utils/withTransaction.js';
import { calcBillTotals, toPaise } from './utils/money.js';
import { deductStock, restoreStock } from './utils/stock.js';

const DROP = !process.argv.includes('--no-drop');

const products = [
  { name: 'Wireless Mouse', sku: 'ELEC-MSE-01', category: 'Electronics', unit: 'pcs', mrp: 799, selling_price: 749, cost_price: 420,
    colors: [{ color: 'Black', quantity: 25 }, { color: 'White', quantity: 15 }] },
  { name: 'Mechanical Keyboard', sku: 'ELEC-KBD-02', category: 'Electronics', quantity: 18, unit: 'pcs', mrp: 3499, selling_price: 3299, cost_price: 2100 },
  { name: 'USB-C Hub 4-in-1', sku: 'ELEC-HUB-03', category: 'Electronics', quantity: 4, unit: 'pcs', mrp: 1499, selling_price: 1399, cost_price: 900 },
  { name: 'HDMI Cable 2m', sku: 'ELEC-CBL-04', category: 'Electronics', quantity: 120, unit: 'pcs', mrp: 349, selling_price: 319, cost_price: 150 },
  { name: 'Basmati Rice 5kg', sku: 'GROC-RIC-05', category: 'Grocery', quantity: 60, unit: 'bag', mrp: 550, selling_price: 530, cost_price: 430 },
  { name: 'Sunflower Oil 1L', sku: 'GROC-OIL-06', category: 'Grocery', quantity: 3, unit: 'bottle', mrp: 165, selling_price: 155, cost_price: 135 },
  { name: 'Green Tea 100g', sku: 'GROC-TEA-07', category: 'Grocery', quantity: 25, unit: 'pack', mrp: 299, selling_price: 279, cost_price: 210 },
  { name: 'Cotton T-Shirt', sku: 'APRL-TSH-08', category: 'Apparel', unit: 'pcs', mrp: 699, selling_price: 649, cost_price: 320,
    colors: [{ color: 'Red', quantity: 10 }, { color: 'Blue', quantity: 12 }, { color: 'Green', quantity: 13 }] },
  { name: 'Notebook A5', sku: 'STAT-NBK-09', category: 'Stationery', quantity: 200, unit: 'pcs', mrp: 149, selling_price: 139, cost_price: 70 },
  { name: 'Ball Pen (Blue)', sku: 'STAT-PEN-10', category: 'Stationery', quantity: 500, unit: 'pcs', mrp: 20, selling_price: 18, cost_price: 8 },
  { name: 'Assorted Cookies', sku: 'GROC-CKE-11', category: 'Grocery', unit: 'pack', mrp: 150, selling_price: 140, cost_price: 90,
    packs: [{ label: 'Small pack', price: 50, quantity: 30 }, { label: 'Big pack', price: 150, quantity: 12 }] },
];

// Products with a `colors`/`packs` breakdown get their total derived from the buckets.
const withTotal = (p) =>
  p.colors
    ? { ...p, quantity: p.colors.reduce((s, c) => s + c.quantity, 0) }
    : p.packs
      ? { ...p, quantity: p.packs.reduce((s, x) => s + x.quantity, 0) }
      : p;

const customers = [
  { name: 'Aarav Sharma', phone: '+91 98765 43210', email: 'aarav@example.com', address: '12 MG Road, Bengaluru 560001' },
  { name: 'Priya Patel', phone: '+91 98123 45670', email: 'priya@example.com', address: '44 Linking Road, Mumbai 400050' },
  { name: 'Rohan Mehta', phone: '+91 99001 12233', email: null, address: null },
  { name: 'Sneha Iyer', phone: '+91 90000 55667', email: 'sneha@example.com', address: '7 Park Street, Kolkata 700016' },
];

async function addItem(orderId, product, quantity, session, color = null) {
  await deductStock(session, product, quantity, color);
  const [item] = await OrderItem.create(
    [{ order_id: orderId, product_id: product._id, quantity, price_at_order: product.mrp, color }],
    { session }
  );
  return item;
}

async function createBillFromOrder(order, session) {
  const items = await OrderItem.find({ order_id: order._id, excluded_from_bill: false }).session(session);
  const subtotalPaise = items.reduce((sum, i) => sum + toPaise(i.price_at_order) * i.quantity, 0);
  const totals = calcBillTotals({ subtotalPaise, discountRate: 2 });
  const bill = new Bill({
    order_id: order._id,
    customer_id: order.customer_id,
    ...totals,
    discount_rate: 2,
  });
  await bill.save({ session });
  await BillItem.insertMany(
    items.map((i) => ({
      bill_id: bill._id,
      product_id: i.product_id,
      quantity: i.quantity,
      price: i.price_at_order,
      color: i.color || null,
    })),
    { session }
  );
  order.status = 'billed';
  await order.save({ session });
  return bill;
}

async function seed() {
  await connectDB();

  if (DROP) {
    await mongoose.connection.dropDatabase();
    console.log('[seed] database dropped');
  }

  const productDocs = await Product.create(products.map(withTotal));
  const customerDocs = await Customer.create(customers);
  const bySku = new Map(productDocs.map((p) => [p.sku, p]));
  console.log(`[seed] ${productDocs.length} products, ${customerDocs.length} customers`);

  const summary = [];

  // 1) A draft order (stock deducted, still open)
  await withTransaction(async (session) => {
    const order = new Order({ customer_id: customerDocs[0]._id, status: 'draft' });
    await order.save({ session });
    await addItem(order._id, bySku.get('ELEC-MSE-01'), 2, session, 'Black');
    await addItem(order._id, bySku.get('ELEC-KBD-02'), 1, session);
    summary.push({ type: 'order', id: String(order._id), status: 'draft', customer: customerDocs[0].name });
  });

  // 2) A confirmed order that is immediately billed (discount 2%)
  await withTransaction(async (session) => {
    const order = new Order({ customer_id: customerDocs[1]._id, status: 'confirmed' });
    await order.save({ session });
    await addItem(order._id, bySku.get('GROC-RIC-05'), 5, session);
    await addItem(order._id, bySku.get('APRL-TSH-08'), 2, session, 'Red');
    const bill = await createBillFromOrder(order, session);
    summary.push({ type: 'bill(from order)', id: String(bill._id), status: 'billed', customer: customerDocs[1].name });
  });

  // 3) A cancelled order (stock added back, so net effect is zero)
  await withTransaction(async (session) => {
    const order = new Order({ customer_id: customerDocs[3]._id, status: 'draft' });
    await order.save({ session });
    await addItem(order._id, bySku.get('STAT-NBK-09'), 10, session);
    const items = await OrderItem.find({ order_id: order._id, excluded_from_bill: false }).session(session);
    for (const item of items) {
      await restoreStock(session, {
        productId: item.product_id,
        quantity: item.quantity,
        color: item.color,
      });
    }
    order.status = 'cancelled';
    await order.save({ session });
    summary.push({ type: 'order', id: String(order._id), status: 'cancelled', customer: customerDocs[3].name });
  });

  // 4) A standalone bill (stock deducted)
  await withTransaction(async (session) => {
    const lines = [
      { product: bySku.get('STAT-NBK-09'), quantity: 4 },
      { product: bySku.get('STAT-PEN-10'), quantity: 10 },
      { product: bySku.get('GROC-TEA-07'), quantity: 2 },
    ];
    for (const line of lines) {
      await deductStock(session, line.product, line.quantity, line.color || null);
    }
    const subtotalPaise = lines.reduce((sum, l) => sum + toPaise(l.product.mrp) * l.quantity, 0);
    const totals = calcBillTotals({ subtotalPaise, deliveryPaise: toPaise(40), discountRate: 0 });
    const bill = new Bill({
      order_id: null,
      customer_id: customerDocs[2]._id,
      ...totals,
      discount_rate: 0,
    });
    await bill.save({ session });
    await BillItem.insertMany(
      lines.map((l) => ({
        bill_id: bill._id,
        product_id: l.product._id,
        quantity: l.quantity,
        price: l.product.mrp,
      })),
      { session }
    );
    summary.push({ type: 'bill(standalone)', id: String(bill._id), status: '—', customer: customerDocs[2].name });
  });

  console.log('\n[seed] sample orders/bills:');
  console.table(summary);

  const updated = await Product.find().sort({ name: 1 }).select('sku quantity colors').lean();
  console.log('\n[seed] final stock levels:');
  console.table(
    updated.map((p) => ({
      sku: p.sku,
      quantity: p.quantity,
      colors: (p.colors || []).map((c) => `${c.color}:${c.quantity}`).join(' · ') || '—',
    }))
  );

  await mongoose.disconnect();
  console.log('\n[seed] done.');
}

seed().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
