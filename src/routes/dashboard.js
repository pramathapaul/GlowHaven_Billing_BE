import { Router } from 'express';
import { Product } from '../models/Product.js';
import { Customer } from '../models/Customer.js';
import { Order, ORDER_STATUSES } from '../models/Order.js';
import { Bill } from '../models/Bill.js';
import { LOW_STOCK_THRESHOLD } from '../config/db.js';
import { serialize } from '../utils/serialize.js';

const router = Router();

router.get('/stats', async (req, res, next) => {
  try {
    const [products, totalCustomers, bills] = await Promise.all([
      Product.find({ deleted_at: null }).lean(),
      Customer.countDocuments(),
      Bill.find().sort({ created_at: -1 }).limit(5).lean(),
    ]);

    const statusCounts = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0]));
    const recentOrders = await Order.find().sort({ created_at: -1 }).limit(5).lean();
    const allStatuses = await Order.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
    for (const row of allStatuses) {
      if (row._id in statusCounts) statusCounts[row._id] = row.count;
    }

    const revenueAgg = await Bill.aggregate([{ $group: { _id: null, total: { $sum: '$total' }, count: { $sum: 1 } } }]);
    const revenue = revenueAgg.length ? revenueAgg[0].total : 0;
    const billCount = revenueAgg.length ? revenueAgg[0].count : 0;

    const customerIds = recentOrders.map((o) => o.customer_id);
    const customers = customerIds.length
      ? await Customer.find({ _id: { $in: customerIds } }).lean()
      : [];
    const cmap = new Map(customers.map((c) => [String(c._id), c.name]));

    const billCustomerIds = bills.map((b) => b.customer_id);
    const billCustomers = billCustomerIds.length
      ? await Customer.find({ _id: { $in: billCustomerIds } }).lean()
      : [];
    const bcmap = new Map(billCustomers.map((c) => [String(c._id), c.name]));

    const stockValue = products.reduce((sum, p) => sum + p.quantity * p.cost_price, 0);
    const retailValue = products.reduce((sum, p) => sum + p.quantity * p.mrp, 0);

    res.json({
      stats: {
        products: products.length,
        lowStock: products.filter((p) => p.quantity <= LOW_STOCK_THRESHOLD).length,
        lowStockThreshold: LOW_STOCK_THRESHOLD,
        stockValue: Math.round(stockValue * 100) / 100,
        retailValue: Math.round(retailValue * 100) / 100,
        customers: totalCustomers,
        orders: statusCounts,
        openOrders: statusCounts.draft + statusCounts.confirmed,
        bills: billCount,
        revenue: Math.round(revenue * 100) / 100,
      },
      recentOrders: recentOrders.map((o) => ({
        ...serialize(o),
        customer_id: String(o.customer_id),
        customer_name: cmap.get(String(o.customer_id)) || '—',
      })),
      recentBills: bills.map((b) => ({
        ...serialize(b),
        customer_id: String(b.customer_id),
        order_id: b.order_id ? String(b.order_id) : null,
        customer_name: bcmap.get(String(b.customer_id)) || '—',
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
