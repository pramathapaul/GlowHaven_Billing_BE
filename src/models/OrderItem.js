import mongoose from 'mongoose';
import { jsonOptions } from './schemaOptions.js';

const orderItemSchema = new mongoose.Schema(
  {
    order_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    product_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    quantity: { type: Number, required: true, min: [1, 'Quantity must be at least 1.'] },
    price_at_order: { type: Number, required: true, min: 0 },
    // Which color/pack bucket this line draws from (null when untracked).
    color: { type: String, default: null, maxlength: 40 },
    pack: { type: String, default: null, maxlength: 40 },
    // Set when the line item is unchecked during billing (stock already restored).
    excluded_from_bill: { type: Boolean, default: false },
  },
  jsonOptions()
);

export const OrderItem = mongoose.model('OrderItem', orderItemSchema);
