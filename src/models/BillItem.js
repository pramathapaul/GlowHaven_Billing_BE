import mongoose from 'mongoose';
import { jsonOptions } from './schemaOptions.js';

const billItemSchema = new mongoose.Schema(
  {
    bill_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Bill', required: true },
    product_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    quantity: { type: Number, required: true, min: [1, 'Quantity must be at least 1.'] },
    price: { type: Number, required: true, min: 0 },
    color: { type: String, default: null, maxlength: 40 },
    pack: { type: String, default: null, maxlength: 40 },
  },
  jsonOptions()
);

export const BillItem = mongoose.model('BillItem', billItemSchema);
