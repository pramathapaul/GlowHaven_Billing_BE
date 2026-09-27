import mongoose from 'mongoose';
import { jsonOptions } from './schemaOptions.js';

/**
 * Per-color stock breakdown. `Product.quantity` is always the TOTAL
 * (sum of these entries) so every existing stock rule keeps working
 * against the aggregate while deductions also hit the right color.
 */
const colorStockSchema = new mongoose.Schema(
  {
    color: { type: String, required: true, trim: true, maxlength: 40 },
    quantity: { type: Number, required: true, min: [0, 'Color quantity cannot be negative.'] },
  },
  { _id: false }
);

/**
 * Per-pack stock breakdown (e.g. "Small pack" / "Big pack") where each
 * pack carries its OWN price. Mutually exclusive with colors: a product
 * tracks either colors or packs, never both. `quantity` stays the TOTAL.
 */
const packStockSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true, maxlength: 40 },
    price: { type: Number, required: true, min: [0, 'Pack price cannot be negative.'] },
    quantity: { type: Number, required: true, min: [0, 'Pack quantity cannot be negative.'] },
  },
  { _id: false }
);

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Product name is required.'], trim: true, maxlength: 200 },
    sku: {
      type: String,
      required: [true, 'SKU is required.'],
      trim: true,
      uppercase: true,
      maxlength: 60,
      unique: true,
    },
    category: { type: String, required: [true, 'Category is required.'], trim: true, maxlength: 100 },
    quantity: { type: Number, required: true, min: [0, 'Quantity cannot be negative.'], default: 0 },
    unit: { type: String, required: [true, 'Unit is required.'], trim: true, maxlength: 30, default: 'pcs' },
    mrp: { type: Number, required: [true, 'MRP is required.'], min: [0, 'MRP cannot be negative.'] },
    // Selling price = the amount the customer actually pays (defaults to MRP for legacy docs).
    selling_price: { type: Number, min: [0, 'Selling price cannot be negative.'] },
    cost_price: {
      type: Number,
      required: [true, 'Cost price is required.'],
      min: [0, 'Cost price cannot be negative.'],
    },
    colors: { type: [colorStockSchema], default: [] },
    packs: { type: [packStockSchema], default: [] },
    // Soft-delete flag (kept out of the core spec fields but required for soft-delete).
    deleted_at: { type: Date, default: null },
  },
  jsonOptions({ createdAt: 'created_at', updatedAt: 'updated_at' })
);

productSchema.index({ name: 'text', category: 'text' });

productSchema.virtual('margin').get(function () {
  return Math.round((this.mrp - this.cost_price) * 100) / 100;
});

export const Product = mongoose.model('Product', productSchema);
