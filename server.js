require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { createServer } = require('http');
const { Server } = require('socket.io');
const moment = require('moment');
const fs = require('fs');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { 
  cors: { 
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
  } 
});

// Middleware
app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads'));

// Shop Details from .env
const SHOP_NAME = process.env.SHOP_NAME || 'GlowHaven';
const SHOP_ADDRESS = process.env.SHOP_ADDRESS || '123 Beauty Boulevard, Cosmetics City';
const SHOP_PHONE = process.env.SHOP_PHONE || '+91 98765 43210';
const SHOP_EMAIL = process.env.SHOP_EMAIL || 'glowhaven@beauty.com';
const SHOP_GST = process.env.SHOP_GST || '27ABCDE1234F1Z5';
const SHOP_TAGLINE = process.env.SHOP_TAGLINE || 'Your Beauty Destination';

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/cosmetic_shop_advanced';
mongoose.connect(MONGODB_URI)
.then(() => console.log('MongoDB Connected Successfully'))
.catch(err => console.log('MongoDB Connection Error:', err));

// ==================== SCHEMAS ====================
const customerSchema = new mongoose.Schema({
  customerId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  email: { type: String },
  phone: { type: String, required: true },
  address: { type: String },
  loyaltyPoints: { type: Number, default: 0 },
  totalSpent: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  lastPurchase: { type: Date }
});

const productVariantSchema = new mongoose.Schema({
  sku: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  colorCode: { type: String, default: '#000000' },
  stock: { type: Number, required: true, default: 0 },
  price: { type: Number },
  attributes: { type: Map, of: String }
});

const productSchema = new mongoose.Schema({
  productId: { type: String, required: true, unique: true },
  barcode: { type: String, unique: true, sparse: true },
  name: { type: String, required: true },
  category: { type: String, required: true },
  brand: { type: String },
  description: { type: String },
  hasVariants: { type: Boolean, default: false },
  variants: [productVariantSchema],
  basePrice: { type: Number, required: true, default: 0 },
  defaultStock: { type: Number, default: 0 },
  minStockLevel: { type: Number, default: 10 },
  image: { type: String },
  createdAt: { type: Date, default: Date.now }
});

productSchema.virtual('price').get(function() {
  return this.basePrice;
});

productSchema.set('toJSON', { virtuals: true });
productSchema.set('toObject', { virtuals: true });

// Updated Bill Schema 
const billSchema = new mongoose.Schema({
  billId: { type: String, required: true, unique: true },
  customerId: { type: String },
  customerName: { type: String, required: true },
  customerEmail: { type: String },
  customerPhone: { type: String },
  items: [{
    productId: { type: String, required: true },
    productName: { type: String, required: true },
    variantSku: { type: String },
    variantName: { type: String },
    colorCode: { type: String },
    quantity: { type: Number, required: true },
    price: { type: Number, required: true },
    total: { type: Number, required: true }
  }],
  subtotal: { type: Number, required: true },
  discount: { type: Number, default: 0 },
  total: { type: Number, required: true },
  loyaltyPointsEarned: { type: Number, default: 0 },
  loyaltyPointsRedeemed: { type: Number, default: 0 },
  paymentMethod: { type: String, default: 'Cash' },
  date: { type: Date, default: Date.now },
  status: { type: String, default: 'completed' }
});

const returnSchema = new mongoose.Schema({
  returnId: { type: String, required: true, unique: true },
  originalBillId: { type: String, required: true },
  customerId: { type: String },
  customerName: { type: String },
  items: [{
    productId: { type: String, required: true },
    productName: { type: String, required: true },
    variantSku: { type: String },
    variantName: { type: String },
    quantity: { type: Number, required: true },
    refundAmount: { type: Number, required: true }
  }],
  totalRefund: { type: Number, required: true },
  reason: { type: String },
  date: { type: Date, default: Date.now },
  status: { type: String, default: 'approved' }
});

const Customer = mongoose.model('Customer', customerSchema);
const Product = mongoose.model('Product', productSchema);
const Bill = mongoose.model('Bill', billSchema);
const Return = mongoose.model('Return', returnSchema);

// ==================== CUSTOMER API ====================
app.get('/api/customers', async (req, res) => {
  try {
    const { search, page = 1, limit = 10 } = req.query;
    let query = {};
    if (search) {
      query = { $or: [{ name: { $regex: search, $options: 'i' } }, { phone: { $regex: search, $options: 'i' } }, { email: { $regex: search, $options: 'i' } }] };
    }
    const customers = await Customer.find(query).sort({ totalSpent: -1 }).limit(limit * 1).skip((page - 1) * limit);
    const total = await Customer.countDocuments(query);
    res.json({ customers, total, page, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/customers', async (req, res) => {
  try {
    const customer = new Customer(req.body);
    await customer.save();
    res.status(201).json(customer);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.put('/api/customers/:id', async (req, res) => {
  try {
    const customer = await Customer.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!customer) return res.status(404).json({ message: 'Customer not found' });
    res.json(customer);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.delete('/api/customers/:id', async (req, res) => {
  try {
    const customer = await Customer.findByIdAndDelete(req.params.id);
    if (!customer) return res.status(404).json({ message: 'Customer not found' });
    res.json({ message: 'Customer deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/customers/bulk', async (req, res) => {
  try {
    const customers = await Customer.insertMany(req.body.customers);
    res.json({ message: `${customers.length} customers added`, customers });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// ==================== PRODUCT API ====================
app.get('/api/products', async (req, res) => {
  try {
    const { search, category, page = 1, limit = 10 } = req.query;
    let query = {};
    if (search) query.name = { $regex: search, $options: 'i' };
    if (category) query.category = category;
    
    const products = await Product.find(query).sort({ createdAt: -1 }).limit(limit * 1).skip((page - 1) * limit);
    const total = await Product.countDocuments(query);
    const categories = await Product.distinct('category');
    res.json({ products, total, page, totalPages: Math.ceil(total / limit), categories });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });
    res.json(product);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/products', async (req, res) => {
  try {
    const productData = { ...req.body };
    if (!productData.basePrice && productData.price) {
      productData.basePrice = productData.price;
    }
    if (!productData.basePrice) {
      productData.basePrice = 0;
    }
    
    const product = new Product(productData);
    await product.save();
    io.emit('product-updated', product);
    res.status(201).json(product);
  } catch (error) {
    console.error('Product creation error:', error);
    res.status(400).json({ message: error.message });
  }
});

app.put('/api/products/:id', async (req, res) => {
  try {
    const productData = { ...req.body };
    if (!productData.basePrice && productData.price) {
      productData.basePrice = productData.price;
    }
    
    const product = await Product.findByIdAndUpdate(req.params.id, productData, { new: true, runValidators: true });
    if (!product) return res.status(404).json({ message: 'Product not found' });
    io.emit('product-updated', product);
    res.json(product);
  } catch (error) {
    console.error('Product update error:', error);
    res.status(400).json({ message: error.message });
  }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });
    io.emit('product-updated', null);
    res.json({ message: 'Product deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/products/bulk', async (req, res) => {
  try {
    const products = req.body.products.map(p => {
      if (!p.basePrice && p.price) p.basePrice = p.price;
      if (!p.basePrice) p.basePrice = 0;
      return p;
    });
    const insertedProducts = await Product.insertMany(products);
    io.emit('products-bulk-updated');
    res.json({ message: `${insertedProducts.length} products added`, products: insertedProducts });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// ==================== BILL API ====================
app.get('/api/bills', async (req, res) => {
  try {
    const { startDate, endDate, search, page = 1, limit = 10 } = req.query;
    let query = {};
    if (startDate && endDate) {
      query.date = { $gte: new Date(startDate), $lte: new Date(endDate) };
    }
    if (search) {
      query.$or = [
        { billId: { $regex: search, $options: 'i' } }, 
        { customerName: { $regex: search, $options: 'i' } }
      ];
    }
    const bills = await Bill.find(query).sort({ date: -1 }).limit(limit * 1).skip((page - 1) * limit);
    const total = await Bill.countDocuments(query);
    res.json({ bills, total, page, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/bills', async (req, res) => {
  try {
    for (const item of req.body.items) {
      if (item.variantSku) {
        const product = await Product.findOne({ productId: item.productId });
        if (product) {
          const variant = product.variants.find(v => v.sku === item.variantSku);
          if (variant) {
            if (variant.stock < item.quantity) {
              return res.status(400).json({ message: `Insufficient stock for ${item.productName} - ${item.variantName}` });
            }
            variant.stock -= item.quantity;
            await product.save();
          }
        }
      } else {
        const product = await Product.findOne({ productId: item.productId });
        if (product && !product.hasVariants) {
          if (product.defaultStock < item.quantity) {
            return res.status(400).json({ message: `Insufficient stock for ${product.name}` });
          }
          product.defaultStock -= item.quantity;
          await product.save();
        }
      }
    }
    
    if (req.body.customerId && !req.body.customerId.startsWith('WALK-')) {
      const customer = await Customer.findOne({ customerId: req.body.customerId });
      if (customer) {
        customer.totalSpent = (customer.totalSpent || 0) + req.body.total;
        customer.loyaltyPoints = (customer.loyaltyPoints || 0) + req.body.loyaltyPointsEarned;
        if (req.body.loyaltyPointsRedeemed > 0) {
          customer.loyaltyPoints -= req.body.loyaltyPointsRedeemed;
        }
        customer.lastPurchase = new Date();
        await customer.save();
      }
    }
    
    const bill = new Bill(req.body);
    await bill.save();
    
    io.emit('new-bill', bill);
    res.status(201).json(bill);
  } catch (error) {
    console.error('Bill creation error:', error);
    res.status(400).json({ message: error.message });
  }
});

app.put('/api/bills/:id', async (req, res) => {
  try {
    const oldBill = await Bill.findById(req.params.id);
    if (!oldBill) return res.status(404).json({ message: 'Bill not found' });
    
    for (const item of oldBill.items) {
      if (item.variantSku) {
        const product = await Product.findOne({ productId: item.productId });
        if (product) {
          const variant = product.variants.find(v => v.sku === item.variantSku);
          if (variant) {
            variant.stock += item.quantity;
            await product.save();
          }
        }
      } else {
        const product = await Product.findOne({ productId: item.productId });
        if (product && !product.hasVariants) {
          product.defaultStock += item.quantity;
          await product.save();
        }
      }
    }
    
    for (const item of req.body.items) {
      if (item.variantSku) {
        const product = await Product.findOne({ productId: item.productId });
        if (product) {
          const variant = product.variants.find(v => v.sku === item.variantSku);
          if (variant) {
            if (variant.stock < item.quantity) {
              return res.status(400).json({ message: `Insufficient stock for ${item.productName} - ${item.variantName}` });
            }
            variant.stock -= item.quantity;
            await product.save();
          }
        }
      } else {
        const product = await Product.findOne({ productId: item.productId });
        if (product && !product.hasVariants) {
          if (product.defaultStock < item.quantity) {
            return res.status(400).json({ message: `Insufficient stock for ${product.name}` });
          }
          product.defaultStock -= item.quantity;
          await product.save();
        }
      }
    }
    
    const bill = await Bill.findByIdAndUpdate(req.params.id, req.body, { new: true });
    io.emit('bill-updated', bill);
    res.json(bill);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.delete('/api/bills/:id', async (req, res) => {
  try {
    const bill = await Bill.findById(req.params.id);
    if (!bill) return res.status(404).json({ message: 'Bill not found' });
    
    for (const item of bill.items) {
      if (item.variantSku) {
        const product = await Product.findOne({ productId: item.productId });
        if (product) {
          const variant = product.variants.find(v => v.sku === item.variantSku);
          if (variant) {
            variant.stock += item.quantity;
            await product.save();
          }
        }
      } else {
        const product = await Product.findOne({ productId: item.productId });
        if (product) {
          product.defaultStock += item.quantity;
          await product.save();
        }
      }
    }
    
    await Bill.findByIdAndDelete(req.params.id);
    io.emit('bill-deleted', bill.billId);
    res.json({ message: 'Bill deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/bills/:id/pdf', async (req, res) => {
  try {
    const bill = await Bill.findById(req.params.id);
    if (!bill) return res.status(404).json({ message: 'Bill not found' });
    
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=bill_${bill.billId}.pdf`);
    doc.pipe(res);
    
    // Header Border
    doc.rect(30, 30, 545, 780).stroke();
    
    // Shop Name
    doc.fontSize(28).font('Helvetica-Bold').fillColor('#8B0000').text(SHOP_NAME, { align: 'center' });
    doc.fontSize(12).font('Helvetica').fillColor('#666666').text(SHOP_TAGLINE, { align: 'center' });
    doc.moveDown(0.5);
    
    // Shop Details
    doc.fontSize(9).fillColor('#333333');
    doc.text(SHOP_ADDRESS, { align: 'center' });
    doc.text(`Phone: ${SHOP_PHONE} | Email: ${SHOP_EMAIL}`, { align: 'center' });
    doc.text(`GST: ${SHOP_GST}`, { align: 'center' });
    doc.moveDown(1);
    
    // Decorative Line
    doc.strokeColor('#8B0000').lineWidth(1).moveTo(50, doc.y).lineTo(555, doc.y).stroke();
    doc.moveDown(0.5);
    
    // Bill Title
    doc.fontSize(18).font('Helvetica-Bold').fillColor('#8B0000').text('INVOICE', { align: 'center' });
    doc.moveDown(0.5);
    
    // Bill Details Box
    doc.rect(50, doc.y, 200, 50).stroke();
    doc.rect(255, doc.y, 200, 50).stroke();
    doc.rect(460, doc.y, 100, 50).stroke();
    
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#333333');
    doc.text('Bill Number:', 55, doc.y + 5);
    doc.font('Helvetica').text(bill.billId, 55, doc.y + 20);
    
    doc.font('Helvetica-Bold').text('Date:', 260, doc.y + 5);
    doc.font('Helvetica').text(new Date(bill.date).toLocaleDateString(), 260, doc.y + 20);
    
    doc.font('Helvetica-Bold').text('Time:', 465, doc.y + 5);
    doc.font('Helvetica').text(new Date(bill.date).toLocaleTimeString(), 465, doc.y + 20);
    
    doc.moveDown(4);
    
    // Customer Details Box
    doc.rect(50, doc.y, 505, 50).stroke();
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#8B0000').text('Customer Details', 55, doc.y + 5);
    doc.fontSize(9).font('Helvetica').fillColor('#333333');
    doc.text(`Name: ${bill.customerName}`, 55, doc.y + 22);
    if (bill.customerPhone) doc.text(`Phone: ${bill.customerPhone}`, 300, doc.y + 22);
    if (bill.customerEmail) doc.text(`Email: ${bill.customerEmail}`, 55, doc.y + 37);
    doc.moveDown(4);
    
    // Products Table Header
    const tableTop = doc.y;
    doc.rect(50, tableTop, 505, 20).fill('#8B0000');
    doc.fillColor('#FFFFFF').fontSize(9).font('Helvetica-Bold');
    doc.text('Sl No', 55, tableTop + 5);
    doc.text('Product', 90, tableTop + 5);
    doc.text('Shade', 250, tableTop + 5);
    doc.text('Qty', 320, tableTop + 5);
    doc.text('Price', 380, tableTop + 5);
    doc.text('Total', 460, tableTop + 5);
    
    doc.fillColor('#333333');
    let currentY = tableTop + 20;
    
    // Table Rows
    bill.items.forEach((item, index) => {
      const rowHeight = 20;
      doc.rect(50, currentY, 505, rowHeight).stroke();
      doc.fontSize(9).font('Helvetica');
      doc.text((index + 1).toString(), 55, currentY + 5);
      doc.text(item.productName.substring(0, 25), 90, currentY + 5);
      doc.text(item.variantName ? item.variantName.substring(0, 15) : '-', 250, currentY + 5);
      doc.text(item.quantity.toString(), 320, currentY + 5);
      doc.text(`Rs.${item.price.toFixed(2)}`, 380, currentY + 5);
      doc.text(`Rs.${item.total.toFixed(2)}`, 460, currentY + 5);
      currentY += rowHeight;
    });
    
    // Summary Box
    const summaryTop = currentY + 10;
    const subtotal = bill.items.reduce((sum, i) => sum + i.total, 0);
    const total = subtotal - (bill.discount || 0);
    
    doc.rect(350, summaryTop, 205, 60).stroke();
    doc.fontSize(9);
    doc.text('Subtotal:', 360, summaryTop + 8);
    doc.text(`Rs.${subtotal.toFixed(2)}`, 480, summaryTop + 8, { align: 'right' });
    
    if (bill.discount && bill.discount > 0) {
      doc.text('Discount:', 360, summaryTop + 23);
      doc.text(`-Rs.${bill.discount.toFixed(2)}`, 480, summaryTop + 23, { align: 'right' });
    }
    
    doc.font('Helvetica-Bold');
    doc.text('TOTAL:', 360, summaryTop + 40);
    doc.text(`Rs.${total.toFixed(2)}`, 480, summaryTop + 40, { align: 'right' });
    
    doc.moveDown(6);
    
    // Cute Message
    doc.fontSize(11).font('Helvetica-Oblique').fillColor('#8B0000');
    const cuteMessages = [
      "Thank you for choosing GlowHaven!",
      "Glow brighter every day with GlowHaven!",
      "You're beautiful, and we love serving you!",
      "Keep shining like the star you are!",
      "Stay glamorous, stay gorgeous!",
      "Come back soon for more beauty treasures!",
      "Loved serving you! See you again!"
    ];
    const randomMessage = cuteMessages[Math.floor(Math.random() * cuteMessages.length)];
    doc.text(randomMessage, { align: 'center' });
    
    doc.moveDown(1);
    doc.fontSize(8).font('Helvetica').fillColor('#999999');
    doc.text('This is a computer generated invoice - valid without signature', { align: 'center' });
    
    // Footer
    doc.moveDown(2);
    doc.fontSize(9).fillColor('#8B0000');
    doc.text(`Thank you for shopping at ${SHOP_NAME}!`, { align: 'center' });
    doc.fontSize(8).fillColor('#666666');
    doc.text(`Follow us on social media | ${SHOP_EMAIL}`, { align: 'center' });
    
    doc.end();
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ==================== RETURN API ====================
app.get('/api/returns', async (req, res) => {
  try {
    const returns = await Return.find().sort({ date: -1 });
    res.json(returns);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/returns', async (req, res) => {
  try {
    for (const item of req.body.items) {
      if (item.variantSku) {
        const product = await Product.findOne({ productId: item.productId });
        if (product) {
          const variant = product.variants.find(v => v.sku === item.variantSku);
          if (variant) {
            variant.stock += item.quantity;
            await product.save();
          }
        }
      } else {
        const product = await Product.findOne({ productId: item.productId });
        if (product) {
          product.defaultStock += item.quantity;
          await product.save();
        }
      }
    }
    const returnItem = new Return(req.body);
    await returnItem.save();
    io.emit('return-processed', returnItem);
    res.status(201).json(returnItem);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

app.delete('/api/returns/:id', async (req, res) => {
  try {
    const returnItem = await Return.findById(req.params.id);
    if (!returnItem) return res.status(404).json({ message: 'Return not found' });
    
    for (const item of returnItem.items) {
      if (item.variantSku) {
        const product = await Product.findOne({ productId: item.productId });
        if (product) {
          const variant = product.variants.find(v => v.sku === item.variantSku);
          if (variant) {
            variant.stock -= item.quantity;
            await product.save();
          }
        }
      } else {
        const product = await Product.findOne({ productId: item.productId });
        if (product) {
          product.defaultStock -= item.quantity;
          await product.save();
        }
      }
    }
    
    await Return.findByIdAndDelete(req.params.id);
    io.emit('return-deleted', returnItem.returnId);
    res.json({ message: 'Return deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ==================== EXPORT API ====================
app.get('/api/export/products', async (req, res) => {
  try {
    const products = await Product.find();
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Products');
    worksheet.columns = [
      { header: 'Product ID', key: 'productId', width: 15 },
      { header: 'Barcode', key: 'barcode', width: 15 },
      { header: 'Name', key: 'name', width: 25 },
      { header: 'Brand', key: 'brand', width: 15 },
      { header: 'Category', key: 'category', width: 15 },
      { header: 'Base Price', key: 'basePrice', width: 12 },
      { header: 'Has Variants', key: 'hasVariants', width: 12 }
    ];
    products.forEach(p => {
      worksheet.addRow({
        productId: p.productId,
        barcode: p.barcode || '-',
        name: p.name,
        brand: p.brand || '-',
        category: p.category,
        basePrice: p.basePrice,
        hasVariants: p.hasVariants ? 'Yes' : 'No'
      });
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=products.xlsx');
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/export/bills', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    let query = {};
    if (startDate && endDate) {
      query.date = { $gte: new Date(startDate), $lte: new Date(endDate) };
    }
    const bills = await Bill.find(query);
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Bills');
    worksheet.columns = [
      { header: 'Bill ID', key: 'billId', width: 15 },
      { header: 'Customer', key: 'customerName', width: 20 },
      { header: 'Date', key: 'date', width: 20 },
      { header: 'Subtotal', key: 'subtotal', width: 12 },
      { header: 'Discount', key: 'discount', width: 12 },
      { header: 'Total', key: 'total', width: 12 }
    ];
    bills.forEach(bill => {
      worksheet.addRow({
        billId: bill.billId,
        customerName: bill.customerName,
        date: moment(bill.date).format('DD/MM/YYYY HH:mm'),
        subtotal: bill.subtotal,
        discount: bill.discount || 0,
        total: bill.total
      });
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=bills.xlsx');
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create uploads folder
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// Start Server
const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0';

httpServer.listen(PORT, HOST, () => {
  console.log('========================================');
  console.log(`   ${SHOP_NAME} Server Started`);
  console.log('========================================');
  console.log(`Local access:    http://localhost:${PORT}`);
  console.log(`Network access:  http://${HOST}:${PORT}`);
  console.log('========================================');
});