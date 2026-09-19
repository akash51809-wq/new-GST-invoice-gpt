require('dotenv').config();
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');
const { google } = require('googleapis');
const { processInvoice, askGeminiReport } = require('./services/gemini-service');
const { ensureFolderPath, uploadFile, downloadFile, deleteFile } = require('./services/drive-service');
const { sendInvoiceEmail } = require('./services/gmail-service');
const { Invoice, Party, Setting, User } = require('./models');

const app = express();
const PORT = process.env.PORT || 4322;
const TMP = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });
const INVOICES_DIR = path.join(__dirname, 'public', 'invoices');
if (!fs.existsSync(INVOICES_DIR)) fs.mkdirSync(INVOICES_DIR, { recursive: true });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me',
  resave: false,
  saveUninitialized: false,
  store: process.env.MONGODB_URI ? MongoStore.create({ mongoUrl: process.env.MONGODB_URI }) : undefined,
  cookie: { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }
}));

const upload = multer({ dest: TMP, limits: { fileSize: 25 * 1024 * 1024 } });
const requireAuth = (req, res, next) => {
  if (!req.session || !req.session.userId) return res.redirect('/login');
  next();
};
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function boot() {
  if (process.env.MONGODB_URI) await mongoose.connect(process.env.MONGODB_URI);
  await User.findOneAndUpdate(
    { username: 'admin' },
    {
      $setOnInsert: {
        username: 'admin',
        passwordHash: crypto.createHash('sha256').update('admin').digest('hex'),
        name: 'Administrator'
      }
    },
    { upsert: true }
  );
}

function fyFor(date) {
  const d = new Date(date), y = d.getFullYear(), m = d.getMonth() + 1;
  return m >= 4 ? `${y}-${String(y + 1).slice(-2)}` : `${y - 1}-${String(y).slice(-2)}`;
}
function monthName(date) { return new Date(date).toLocaleString('en-US', { month: 'long' }); }
function csvEscape(v) { return '"' + String(v || '').replace(/"/g, '""') + '"'; }

function isPreviousMonth(invDate, refDate = new Date()) {
  const d = new Date(invDate);
  const ref = new Date(refDate);
  const targetYear = ref.getMonth() === 0 ? ref.getFullYear() - 1 : ref.getFullYear();
  const targetMonth = ref.getMonth() === 0 ? 11 : ref.getMonth() - 1;
  return d.getFullYear() === targetYear && d.getMonth() === targetMonth;
}

app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', asyncRoute(async (req, res) => {
  const { username, password } = req.body;
  const u = await User.findOne({ username });
  const hash = crypto.createHash('sha256').update(password || '').digest('hex');
  if (!u || u.passwordHash !== hash) return res.render('login', { error: 'गलत यूज़रनेम या पासवर्ड' });
  req.session.userId = u._id;
  res.redirect('/dashboard');
}));

app.post('/logout', (req, res) => {
  if (req.session) {
    req.session.destroy((err) => {
      if (err) console.error('Session destroy error:', err);
      res.clearCookie('connect.sid');
      res.redirect('/login');
    });
  } else {
    res.redirect('/login');
  }
});

app.get('/', requireAuth, (req, res) => res.redirect('/dashboard'));
app.get('/dashboard', requireAuth, asyncRoute(async (req, res) => {
  const [
    total,
    buy,
    sell,
    parties,
    pending,
    buyAgg,
    sellAgg,
    monthlyAgg,
    googleTokens,
    currentUser
  ] = await Promise.all([
    Invoice.countDocuments({ status: 'completed' }),
    Invoice.countDocuments({ invoiceType: 'BUY', status: 'completed' }),
    Invoice.countDocuments({ invoiceType: 'SELL', status: 'completed' }),
    Party.countDocuments(),
    Invoice.countDocuments({ invoiceType: 'SELL', emailSent: false, status: 'completed' }),
    Invoice.aggregate([
      { $match: { invoiceType: 'BUY', status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$invoiceAmount' } } }
    ]),
    Invoice.aggregate([
      { $match: { invoiceType: 'SELL', status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$invoiceAmount' } } }
    ]),
    Invoice.aggregate([
      { $match: { status: 'completed' } },
      {
        $group: {
          _id: { month: '$month', type: '$invoiceType' },
          count: { $sum: 1 },
          amount: { $sum: '$invoiceAmount' }
        }
      }
    ]),
    Setting.findOne({ key: 'google_tokens' }),
    User.findById(req.session.userId)
  ]);

  const buyTotalAmount = buyAgg[0]?.total || 0;
  const sellTotalAmount = sellAgg[0]?.total || 0;
  const isDriveConnected = !!(googleTokens && googleTokens.value);
  const isAiReady = !!(process.env.GEMINI_API_KEYS && process.env.GEMINI_API_KEYS.trim());
  const isEmailActive = !!(process.env.EMAIL_SUBJECT_TEMPLATE || googleTokens);
  const companyName = process.env.COMPANY_NAME || 'Easy Recharge Solution';
  const userName = currentUser?.name || currentUser?.username || 'Administrator';

  const monthOrder = ['April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'January', 'February', 'March'];
  const monthlyStats = {};
  monthOrder.forEach(m => { monthlyStats[m] = { buyCount: 0, saleCount: 0, buyAmount: 0, saleAmount: 0 }; });
  
  (monthlyAgg || []).forEach(item => {
    const m = item._id?.month;
    const type = item._id?.type;
    if (m && monthlyStats[m]) {
      if (type === 'BUY') {
        monthlyStats[m].buyCount = item.count;
        monthlyStats[m].buyAmount = item.amount;
      } else if (type === 'SELL') {
        monthlyStats[m].saleCount = item.count;
        monthlyStats[m].saleAmount = item.amount;
      }
    }
  });

  let maxCount = 1;
  monthOrder.forEach(m => {
    maxCount = Math.max(maxCount, monthlyStats[m].buyCount, monthlyStats[m].saleCount);
  });

  const chartMonths = monthOrder.map(m => {
    const buyH = maxCount > 0 && monthlyStats[m].buyCount > 0 ? Math.max(12, Math.round((monthlyStats[m].buyCount / maxCount) * 100)) : 6;
    const saleH = maxCount > 0 && monthlyStats[m].saleCount > 0 ? Math.max(12, Math.round((monthlyStats[m].saleCount / maxCount) * 100)) : 6;
    return {
      name: m,
      buyHeight: buyH,
      saleHeight: saleH,
      buyCount: monthlyStats[m].buyCount,
      saleCount: monthlyStats[m].saleCount
    };
  });

  res.render('dashboard', {
    page: 'dashboard',
    pageTitle: 'Dashboard',
    pageHeading: 'Dashboard Overview',
    total,
    buy,
    sell,
    parties,
    pending,
    buyTotalAmount,
    sellTotalAmount,
    companyName,
    userName,
    isDriveConnected,
    isAiReady,
    isEmailActive,
    chartMonths
  });
}));

app.get('/invoices/upload', requireAuth, (req, res) => res.render('upload', {
  page: 'upload',
  pageTitle: 'Upload Invoice',
  pageHeading: 'Upload Invoices',
  companyName: process.env.COMPANY_NAME || 'Easy Recharge Solution',
  message: null
}));

function detectInvoiceType(buyerName, sellerName, company) {
  const b = String(buyerName || '').toLowerCase().trim();
  const s = String(sellerName || '').toLowerCase().trim();
  const c = String(company || '').toLowerCase().trim();
  if (c) {
    if (b.includes(c)) return 'BUY';
    if (s.includes(c)) return 'SELL';
    const words = c.split(/\s+/).filter(w => w.length >= 4);
    const buyerMatch = words.some(w => b.includes(w));
    const sellerMatch = words.some(w => s.includes(w));
    if (buyerMatch && !sellerMatch) return 'BUY';
    if (sellerMatch && !buyerMatch) return 'SELL';
  }
  return 'BUY';
}

app.post('/api/invoices/upload', requireAuth, upload.array('invoices', 50), asyncRoute(async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'कृपया कम से कम एक PDF चुनें' });
  const company = process.env.COMPANY_NAME || 'Easy Recharge Solution';
  const results = [];
  const pendingEmails = [];
  
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    let job = { file: f.originalname, status: 'processing', index: i + 1, total: files.length };
    try {
      // 1. Extract invoice data via Gemini AI
      const data = await processInvoice(f.path);
      data.financialYear = fyFor(data.invoiceDate || new Date());
      data.month = monthName(data.invoiceDate || new Date());
      data.invoiceType = detectInvoiceType(data.buyerName, data.sellerName, company);

      // 2. Check for duplicate invoice
      const dup = await Invoice.findOne({ invoiceNumber: data.invoiceNumber, invoiceAmount: data.invoiceAmount });
      if (dup) {
        job.status = 'duplicate';
        job.error = 'Duplicate invoice number + amount';
        job.invoiceNumber = data.invoiceNumber;
        job.invoiceType = data.invoiceType;
        job.partyName = data.invoiceType === 'BUY' ? (data.sellerName || 'Unknown') : (data.buyerName || 'Unknown');
        results.push(job);
        try { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch (e) {}
        continue;
      }

      // 3. Keep persistent local copy in public/invoices
      const safeFilename = `${Date.now()}_${path.basename(f.originalname).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const localDest = path.join(INVOICES_DIR, safeFilename);
      try {
        fs.copyFileSync(f.path, localDest);
      } catch (copyErr) {
        console.warn('Local invoice file copy warning:', copyErr.message);
      }

      // 4. Upload to Google Drive (with graceful fallback if offline / expired)
      let driveId = '';
      let folderId = '';
      try {
        const folderType = data.invoiceType === 'BUY' ? 'buy' : 'buysell';
        const folder = await ensureFolderPath([process.env.GOOGLE_DRIVE_ROOT || 'GST Invoices', data.financialYear, folderType, data.month]);
        folderId = folder ? folder.id : '';
        const drive = await uploadFile(f.path, f.originalname, folderId);
        driveId = drive ? drive.id : '';
      } catch (driveErr) {
        console.warn(`[Google Drive Notice for ${f.originalname}]`, driveErr.message);
        job.driveNotice = 'Google Drive connect nahi hai ya token expire hai, file local save kar di gayi hai.';
      }

      // 5. Find or create Party
      let partyName = data.invoiceType === 'BUY' ? (data.sellerName || 'Unknown Supplier') : (data.buyerName || 'Unknown Customer');
      let party = await Party.findOne({ name: new RegExp('^' + partyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') });
      if (!party) {
        party = await Party.create({
          name: partyName,
          gstin: (data.invoiceType === 'BUY' ? data.sellerGSTIN : data.buyerGSTIN) || '',
          email: '',
          mobile: ''
        });
      }

      // 6. Save Invoice in MongoDB
      const newInv = await Invoice.create({
        ...data,
        partyId: party._id,
        originalFileName: f.originalname,
        driveFileId: driveId,
        driveFolderId: folderId,
        localPath: localDest,
        status: 'completed'
      });

      job.status = 'completed';
      job.invoiceNumber = data.invoiceNumber || ('INV-' + Date.now().toString().slice(-4));
      job.invoiceType = data.invoiceType;
      job.partyName = partyName;

      // 7. Auto email workflow
      try {
        const invDateRef = newInv.invoiceDate || new Date();
        const isPrevMonth = isPreviousMonth(invDateRef);
        if (newInv.invoiceType === 'SELL' && isPrevMonth && process.env.AUTO_EMAIL !== 'false') {
          if (party.email) {
            let pdfBuffer;
            if (driveId) {
              try { pdfBuffer = await downloadFile(driveId); } catch(e) {}
            }
            if (!pdfBuffer && fs.existsSync(localDest)) {
              pdfBuffer = fs.readFileSync(localDest);
            }
            if (pdfBuffer) {
              await sendInvoiceEmail(party.email, newInv, pdfBuffer);
              newInv.emailSent = true;
              newInv.emailSentAt = new Date();
              newInv.emailStatus = 'sent';
              await newInv.save();
              job.autoEmailSent = true;
            }
          } else {
            job.autoEmailSent = false;
            job.emailMissing = true;
            pendingEmails.push({
              partyId: party._id,
              partyName: partyName,
              invoiceId: newInv._id,
              invoiceNumber: newInv.invoiceNumber
            });
          }
        } else {
          job.autoEmailSent = false;
        }
      } catch (emailErr) {
        console.error('Auto email error for upload', emailErr.message);
        job.autoEmailError = emailErr.message;
      }
    } catch (e) {
      job.status = 'failed';
      job.error = e.message;
    } finally {
      if (fs.existsSync(f.path)) {
        try { fs.unlinkSync(f.path); } catch (e) {}
      }
      results.push(job);
    }
  }
  res.json({ results, pendingEmails });
}));

app.get('/reports', requireAuth, (req, res) => res.redirect('/reports/invoices'));

app.get('/reports/invoices', requireAuth, asyncRoute(async (req, res) => {
  const q = {};
  if (req.query.type && req.query.type !== 'ALL') q.invoiceType = req.query.type;
  if (req.query.party) q.partyId = req.query.party;
  if (req.query.financialYear) q.financialYear = req.query.financialYear;
  if (req.query.month) q.month = req.query.month;
  if (req.query.search) {
    q.$or = [
      { invoiceNumber: new RegExp(req.query.search, 'i') }, 
      { buyerName: new RegExp(req.query.search, 'i') }, 
      { sellerName: new RegExp(req.query.search, 'i') }
    ];
  }
  const invoices = await Invoice.find(q).populate('partyId').sort({ invoiceDate: -1 }).limit(1000);
  const parties = await Party.find().sort({ name: 1 });
  res.render('invoices', {
    page: 'reports',
    subpage: 'upload-invoice-report',
    pageTitle: 'Invoice Reports',
    pageHeading: 'Upload Invoice Report',
    companyName: process.env.COMPANY_NAME || 'Easy Recharge Solution',
    invoices,
    parties,
    query: req.query
  });
}));

app.get('/reports/pending', requireAuth, asyncRoute(async (req, res) => {
  const q = {
    $or: [{ emailSent: false }, { status: 'pending' }]
  };
  if (req.query.type && req.query.type !== 'ALL') q.invoiceType = req.query.type;
  if (req.query.party) q.partyId = req.query.party;
  if (req.query.financialYear) q.financialYear = req.query.financialYear;
  if (req.query.month) q.month = req.query.month;
  if (req.query.search) {
    const s = req.query.search;
    q.$and = [{
      $or: [
        { invoiceNumber: new RegExp(s, 'i') },
        { buyerName: new RegExp(s, 'i') },
        { sellerName: new RegExp(s, 'i') }
      ]
    }];
  }
  const invoices = await Invoice.find(q).populate('partyId').sort({ invoiceDate: -1 }).limit(1000);
  const parties = await Party.find().sort({ name: 1 });
  res.render('report-pending', {
    page: 'reports',
    subpage: 'pending-invoice',
    pageTitle: 'Pending Invoices',
    pageHeading: 'Pending Invoice',
    companyName: process.env.COMPANY_NAME || 'Easy Recharge Solution',
    invoices,
    parties,
    query: req.query
  });
}));

app.get('/reports/ai', requireAuth, asyncRoute(async (req, res) => {
  const totalInvoices = await Invoice.countDocuments();
  res.render('report-ai', {
    page: 'reports',
    subpage: 'ai-report',
    pageTitle: 'GST AI Assistant',
    pageHeading: 'AI Report',
    companyName: process.env.COMPANY_NAME || 'Easy Recharge Solution',
    totalInvoices
  });
}));

app.post('/api/reports/ai-chat', requireAuth, asyncRoute(async (req, res) => {
  const { question } = req.body;
  if (!question || !question.trim()) return res.status(400).json({ error: 'Question required' });

  const totalInvoices = await Invoice.countDocuments();
  const buyInvoices = await Invoice.find({ invoiceType: 'BUY' }).select('invoiceNumber invoiceAmount invoiceDate sellerName financialYear month').sort({ invoiceDate: -1 }).limit(200);
  const sellInvoices = await Invoice.find({ invoiceType: 'SELL' }).select('invoiceNumber invoiceAmount invoiceDate buyerName financialYear month').sort({ invoiceDate: -1 }).limit(200);
  const parties = await Party.find().select('name gstin email mobile');
  const pendingCount = await Invoice.countDocuments({ $or: [{ emailSent: false }, { status: 'pending' }] });

  const totalBuyAmount = buyInvoices.reduce((s, x) => s + (x.invoiceAmount || 0), 0);
  const totalSellAmount = sellInvoices.reduce((s, x) => s + (x.invoiceAmount || 0), 0);

  const partyMap = {};
  [...buyInvoices, ...sellInvoices].forEach(inv => {
    const p = inv.sellerName || inv.buyerName || 'Unknown';
    partyMap[p] = (partyMap[p] || 0) + (inv.invoiceAmount || 0);
  });
  const topParties = Object.entries(partyMap).sort((a,b) => b[1] - a[1]).slice(0, 5).map(([name, totalAmt]) => ({ name, totalAmount: '₹ ' + Math.round(totalAmt).toLocaleString('en-IN') }));

  const dataSummary = {
    companyName: process.env.COMPANY_NAME || 'Easy Recharge Solution',
    totalInvoices,
    pendingInvoicesCount: pendingCount,
    totalBuyCount: buyInvoices.length,
    totalBuyAmount: '₹ ' + Math.round(totalBuyAmount).toLocaleString('en-IN'),
    totalSellCount: sellInvoices.length,
    totalSellAmount: '₹ ' + Math.round(totalSellAmount).toLocaleString('en-IN'),
    totalParties: parties.length,
    topPartiesByAmount: topParties,
    recentInvoicesSample: [...buyInvoices, ...sellInvoices].slice(0, 10).map(i => ({
      num: i.invoiceNumber,
      amt: '₹ ' + (i.invoiceAmount || 0),
      party: i.sellerName || i.buyerName,
      month: i.month,
      fy: i.financialYear
    }))
  };

  const answer = await askGeminiReport(question.trim(), dataSummary);
  res.json({ answer });
}));

app.get('/invoice/:id/view', requireAuth, asyncRoute(async (req, res) => {
  const inv = await Invoice.findById(req.params.id);
  if (!inv) return res.status(404).send('Not found');
  res.render('invoice', {
    page: 'reports',
    pageTitle: 'View Invoice',
    pageHeading: 'Invoice Details',
    companyName: process.env.COMPANY_NAME || 'Easy Recharge Solution',
    inv
  });
}));

app.get('/invoice/:id/download', requireAuth, asyncRoute(async (req, res) => {
  const inv = await Invoice.findById(req.params.id);
  if (!inv) return res.sendStatus(404);
  let data;
  if (inv.driveFileId) {
    try { data = await downloadFile(inv.driveFileId); } catch (e) { console.warn('Drive download failed:', e.message); }
  }
  if (!data && inv.localPath && fs.existsSync(inv.localPath)) {
    data = fs.readFileSync(inv.localPath);
  }
  if (!data) return res.status(404).send('Invoice file not found');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(inv.originalFileName || 'invoice.pdf')}"`);
  res.end(data);
}));

app.post('/invoice/:id/email', requireAuth, asyncRoute(async (req, res) => {
  const inv = await Invoice.findById(req.params.id).populate('partyId');
  if (!inv) return res.sendStatus(404);
  if (!inv.partyId || !inv.partyId.email) return res.status(400).send('Party email नहीं है');
  let pdf;
  if (inv.driveFileId) {
    try { pdf = await downloadFile(inv.driveFileId); } catch (e) {}
  }
  if (!pdf && inv.localPath && fs.existsSync(inv.localPath)) {
    pdf = fs.readFileSync(inv.localPath);
  }
  if (!pdf) return res.status(400).send('Invoice PDF file उपलब्ध नहीं है');
  await sendInvoiceEmail(inv.partyId.email, inv, pdf);
  inv.emailSent = true;
  inv.emailSentAt = new Date();
  inv.emailStatus = 'sent';
  await inv.save();
  res.redirect('/reports/invoices');
}));

app.post('/invoice/:id/delete', requireAuth, asyncRoute(async (req, res) => {
  const { pin } = req.body;
  const ADMIN_PIN = process.env.DELETE_PIN || '1234';
  if (pin !== ADMIN_PIN) return res.status(400).send('गलत PIN दर्ज किया गया है!');
  const inv = await Invoice.findById(req.params.id);
  if (!inv) return res.status(404).send('इनवॉइस नहीं मिला');
  if (inv.driveFileId) {
    try { await deleteFile(inv.driveFileId); } catch (e) { console.error('Drive delete error', e.message); }
  }
  if (inv.localPath && fs.existsSync(inv.localPath)) {
    try { fs.unlinkSync(inv.localPath); } catch (e) {}
  }
  await Invoice.findByIdAndDelete(req.params.id);
  res.redirect('/reports/invoices');
}));

app.get('/parties', requireAuth, asyncRoute(async (req, res) => {
  const parties = await Party.find().sort({ name: 1 });
  res.render('parties', {
    page: 'parties',
    pageTitle: 'Party List',
    pageHeading: 'Customer & Supplier Directory',
    companyName: process.env.COMPANY_NAME || 'Easy Recharge Solution',
    parties
  });
}));

app.post('/parties/update/:id', requireAuth, asyncRoute(async (req, res) => {
  const { email, mobile } = req.body;
  await Party.findByIdAndUpdate(req.params.id, { email, mobile });
  res.redirect('/parties');
}));

app.post('/api/parties/save-email-and-send', requireAuth, asyncRoute(async (req, res) => {
  const { partyId, email, invoiceId } = req.body;
  if (!partyId || !email || !invoiceId) return res.status(400).json({ error: 'partyId, email और invoiceId ज़रूरी हैं' });
  await Party.findByIdAndUpdate(partyId, { email });
  const inv = await Invoice.findById(invoiceId);
  if (!inv) return res.status(404).json({ error: 'Invoice नहीं मिला' });
  const pdfBuffer = await downloadFile(inv.driveFileId);
  await sendInvoiceEmail(email, inv, pdfBuffer);
  inv.emailSent = true;
  inv.emailSentAt = new Date();
  inv.emailStatus = 'sent';
  await inv.save();
  res.json({ message: `ईमेल भेज दिया गया ${email}` });
}));

async function renderSettings(req, res, activeTab = 'company') {
  const googleTokens = await Setting.findOne({ key: 'google_tokens' });
  const isDriveConnected = !!(googleTokens && googleTokens.value);
  res.render('settings', {
    page: 'settings',
    activeTab,
    pageTitle: 'Settings',
    pageHeading: 'Settings',
    companyName: process.env.COMPANY_NAME || 'Easy Recharge Solution',
    companyLogo: process.env.COMPANY_LOGO || '',
    autoEmail: process.env.AUTO_EMAIL !== 'false',
    autoWhatsApp: process.env.AUTO_WHATSAPP === 'true',
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    googleRedirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:4322/auth/google/callback',
    gmailFromName: process.env.GMAIL_FROM_NAME || 'Easy Recharge Solution',
    isDriveConnected,
    geminiApiKey: (process.env.GEMINI_API_KEYS || '').split(',').map(s => s.trim()).join('\n'),
    emailSubject: process.env.EMAIL_SUBJECT_TEMPLATE || 'Tax Invoice from {{company_name}} - {{invoice_number}}',
    emailBody: process.env.EMAIL_BODY_TEMPLATE || 'Dear {{party_name}},\n\nPlease find attached your tax invoice {{invoice_number}} dated {{invoice_date}} for the amount of {{invoice_total}}.\n\nThank you for your business!\n{{company_name}}',
    whatsappRequestType: process.env.WHATSAPP_REQUEST_TYPE || 'POST',
    whatsappApiUrl: process.env.WHATSAPP_API_URL || '',
    saved: req.query.saved
  });
}

app.get('/settings', requireAuth, asyncRoute((req, res) => renderSettings(req, res, req.query.tab || 'company')));
app.get('/settings/company', requireAuth, asyncRoute((req, res) => renderSettings(req, res, 'company')));
app.get('/settings/drive', requireAuth, asyncRoute((req, res) => renderSettings(req, res, 'drive')));
app.get('/settings/google', requireAuth, asyncRoute((req, res) => renderSettings(req, res, 'drive')));
app.get('/settings/gmail', requireAuth, asyncRoute((req, res) => renderSettings(req, res, 'gmail')));
app.get('/settings/gemini', requireAuth, asyncRoute((req, res) => renderSettings(req, res, 'gemini')));
app.get('/settings/email', requireAuth, asyncRoute((req, res) => renderSettings(req, res, 'template')));
app.get('/settings/template', requireAuth, asyncRoute((req, res) => renderSettings(req, res, 'template')));
app.get('/settings/whatsapp', requireAuth, asyncRoute((req, res) => renderSettings(req, res, 'whatsapp')));

app.post('/settings/company', requireAuth, upload.single('logo'), asyncRoute(async (req, res) => {
  const updates = {
    COMPANY_NAME: req.body.companyName || 'Easy Recharge Solution',
    AUTO_EMAIL: req.body.autoEmail ? 'true' : 'false',
    AUTO_WHATSAPP: req.body.autoWhatsApp ? 'true' : 'false'
  };
  if (req.file) {
    const dest = path.join(__dirname, 'public', 'logo.png');
    fs.copyFileSync(req.file.path, dest);
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    updates.COMPANY_LOGO = '/logo.png';
  }
  await saveEnv(updates);
  res.redirect('/settings/company?saved=1');
}));

app.post('/settings/google', requireAuth, asyncRoute(async (req, res) => {
  const updates = {};
  if (req.body.googleClientId !== undefined) updates.GOOGLE_CLIENT_ID = req.body.googleClientId;
  if (req.body.googleClientSecret !== undefined) updates.GOOGLE_CLIENT_SECRET = req.body.googleClientSecret;
  if (req.body.googleRedirectUri !== undefined) updates.GOOGLE_REDIRECT_URI = req.body.googleRedirectUri;
  if (req.body.gmailFromName !== undefined) updates.GMAIL_FROM_NAME = req.body.gmailFromName;
  await saveEnv(updates);
  res.redirect('/settings/drive?saved=1');
}));

app.post('/settings/gmail', requireAuth, asyncRoute(async (req, res) => {
  if (req.body.gmailFromName !== undefined) {
    await saveEnv({ GMAIL_FROM_NAME: req.body.gmailFromName });
  }
  res.redirect('/settings/gmail?saved=1');
}));

app.post('/settings/gemini', requireAuth, asyncRoute(async (req, res) => {
  const keys = String(req.body.keys || '').split(/\r?\n|,/).map(s => s.trim()).filter(Boolean);
  await saveEnv({ GEMINI_API_KEYS: keys.join(',') });
  res.redirect('/settings/gemini?saved=1');
}));

app.post('/settings/email', requireAuth, asyncRoute(async (req, res) => {
  await saveEnv({ EMAIL_SUBJECT_TEMPLATE: req.body.subject, EMAIL_BODY_TEMPLATE: req.body.body });
  res.redirect('/settings/email?saved=1');
}));

app.post('/settings/whatsapp', requireAuth, asyncRoute(async (req, res) => {
  await saveEnv({
    WHATSAPP_REQUEST_TYPE: req.body.whatsappRequestType || 'POST',
    WHATSAPP_API_URL: req.body.whatsappApiUrl || ''
  });
  res.redirect('/settings/whatsapp?saved=1');
}));

app.get('/auth/google', requireAuth, (req, res) => {
  const o = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
  const scopes = ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/gmail.send'];
  res.redirect(o.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: scopes }));
});
app.get('/auth/google/callback', requireAuth, asyncRoute(async (req, res) => {
  const o = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
  const { tokens } = await o.getToken(req.query.code);
  await Setting.findOneAndUpdate({ key: 'google_tokens' }, { $set: { value: JSON.stringify(tokens) } }, { upsert: true });
  res.redirect('/settings/google?saved=1');
}));

app.get('/reports/export.csv', requireAuth, asyncRoute(async (req, res) => {
  const invoices = await Invoice.find({ status: 'completed' }).sort({ invoiceDate: -1 });
  const rows = [['Date', 'Party Name', 'Bill Number', 'GSTIN', 'Amount', 'Type']];
  for (const x of invoices) rows.push([
    x.invoiceDate ? x.invoiceDate.toISOString().slice(0, 10) : '',
    x.invoiceType === 'BUY' ? x.sellerName : x.buyerName,
    x.invoiceNumber,
    x.invoiceType === 'BUY' ? x.sellerGSTIN : x.buyerGSTIN,
    x.invoiceAmount,
    x.invoiceType
  ]);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=invoices.csv');
  res.send(rows.map(r => r.map(csvEscape).join(',')).join('\n'));
}));

app.get('/ping', (req, res) => {
  res.status(200).send('Pong! Server is active.');
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Server error: ' + err.message);
});

async function saveEnv(values) {
  let text = fs.existsSync(path.join(__dirname, '.env')) ? fs.readFileSync(path.join(__dirname, '.env'), 'utf8') : '';
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) continue;
    const line = `${k}=${String(v || '').replace(/\r?\n/g, '\\n')}`;
    const re = new RegExp(`^${k}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, line) : text + '\n' + line;
  }
  fs.writeFileSync(path.join(__dirname, '.env'), text);
  for (const [k, v] of Object.entries(values)) {
    if (v !== undefined) process.env[k] = v;
  }
}

boot().then(() => app.listen(PORT, () => console.log(`GST Invoice Manager running on ${PORT}`))).catch(e => { console.error(e); process.exit(1); });