import mongoose from 'mongoose';
import { jsonOptions } from './schemaOptions.js';

const billSchema = new mongoose.Schema(
  {
    order_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    customer_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: [true, 'Customer is required.'],
    },
    subtotal: { type: Number, required: true, min: 0 },
    delivery_charge: { type: Number, default: 0, min: 0 },
    discount: { type: Number, required: true, min: 0 },
    total: { type: Number, required: true, min: 0 },
    discount_rate: { type: Number, default: 0, min: 0, max: 100 },
    created_at: { type: Date, default: Date.now },
  },
  jsonOptions()
);

export const Bill = mongoose.model('Bill', billSchema);
