require('dotenv').config();
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const BCRYPT_ROUNDS = 12;
const { google } = require('googleapis');
const { processInvoice, askGeminiReport } = require('./services/gemini-service');
const { ensureFolderPath, uploadFile, downloadFile, deleteFile } = require('./services/drive-service');
const { sendInvoiceEmail, sendSecurityAlertEmail, validateAndSanitizeEmail } = require('./services/gmail-service');
const { Invoice, Party, Setting, User } = require('./models');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

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

// MongoDB NoSQL Injection Sanitizer: Recursively strip $ and . operators
function sanitizeNoSql(target) {
  if (!target || typeof target !== 'object') return target;
  if (Array.isArray(target)) {
    target.forEach(sanitizeNoSql);
    return target;
  }
  for (const key of Object.keys(target)) {
    if (key.startsWith('$') || key.includes('.')) {
      delete target[key];
    } else if (typeof target[key] === 'object') {
      sanitizeNoSql(target[key]);
    }
  }
  return target;
}

app.use((req, res, next) => {
  if (req.body) sanitizeNoSql(req.body);
  if (req.query) sanitizeNoSql(req.query);
  if (req.params) sanitizeNoSql(req.params);
  next();
});

// ReDoS (Regular Expression Denial of Service) Prevention Utility
function escapeRegex(str) {
  if (typeof str !== 'string') return '';
  return str.slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Cookie Secure Flag & Production Hardening
const isProduction = process.env.NODE_ENV === 'production';
const isCookieSecure = process.env.COOKIE_SECURE === 'true' || (process.env.COOKIE_SECURE === 'auto' && isProduction);

app.use(session({
  secret: process.env.SESSION_SECRET || 'gst-invoice-manager-secure-session-2026',
  resave: false,
  saveUninitialized: false,
  store: process.env.MONGODB_URI ? MongoStore.create({ mongoUrl: process.env.MONGODB_URI }) : undefined,
  cookie: {
    httpOnly: true,
    secure: isCookieSecure,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// CSRF Token Generation for every session
app.use((req, res, next) => {
  if (req.session) {
    if (!req.session.csrfToken) {
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    }
    res.locals.csrfToken = req.session.csrfToken;
  } else {
    res.locals.csrfToken = '';
  }
  next();
});

// CSRF Verification Middleware for state-changing requests
const csrfProtect = (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sessionToken = req.session && req.session.csrfToken;
  const submittedToken = (req.body && req.body._csrf) ||
                         req.headers['x-csrf-token'] ||
                         req.headers['csrf-token'] ||
                         req.query._csrf;

  if (!sessionToken || !submittedToken || sessionToken !== submittedToken) {
    console.warn(`[CSRF Blocked] ${req.method} ${req.path} from IP ${req.ip}`);
    if (req.xhr || req.headers['content-type'] === 'application/json' || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.status(403).json({ error: 'CSRF verification failed. Please refresh the page.' });
    }
    return res.status(403).send('CSRF validation failed! Unauthorized request. Please refresh the page.');
  }
  next();
};

// Strict File Filter: ONLY PDF and Excel (.xlsx, .xls, .csv) Allowed
const ALLOWED_INVOICE_EXTS = ['.pdf', '.xlsx', '.xls', '.csv'];
const ALLOWED_INVOICE_MIMES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
  'application/csv',
  'application/octet-stream'
];

const invoiceFileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (!ALLOWED_INVOICE_EXTS.includes(ext)) {
    return cb(new Error('Invalid file type! Sirf PDF aur Excel files (.pdf, .xlsx, .xls, .csv) allow hain.'));
  }
  if (!ALLOWED_INVOICE_MIMES.includes(file.mimetype) && !ALLOWED_INVOICE_EXTS.includes(ext)) {
    return cb(new Error('Invalid MIME type! Sirf PDF aur Excel files allow hain.'));
  }
  cb(null, true);
};

const upload = multer({
  dest: TMP,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: invoiceFileFilter
});

// Logo file filter (only safe images)
const logoFileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname || '').toLowerCase();
  const allowedLogoExts = ['.png', '.jpg', '.jpeg', '.webp', '.svg'];
  if (!allowedLogoExts.includes(ext) || !file.mimetype.startsWith('image/')) {
    return cb(new Error('Sirf safe image formats (PNG, JPG, WEBP, SVG) allow hain.'));
  }
  cb(null, true);
};

const uploadLogo = multer({
  dest: TMP,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: logoFileFilter
});

// WhatsApp Security Alert Function
async function sendSecurityAlertWhatsApp(alertInfo) {
  const apiUrl = process.env.WHATSAPP_API_URL;
  if (!apiUrl) return;
  try {
    const text = `⚠️ Security Alert: Failed login attempt on GST Invoice Manager\nUser: ${alertInfo.username || 'unknown'}\nIP: ${alertInfo.ip || 'unknown'}\nTime: ${new Date().toLocaleString('en-IN')}`;
    const targetUrl = apiUrl.replace(/\{\{message\}\}/g, encodeURIComponent(text)).replace(/\{\{mobile_number\}\}/g, encodeURIComponent(process.env.ADMIN_MOBILE || ''));
    if (typeof fetch === 'function') {
      await fetch(targetUrl, {
        method: process.env.WHATSAPP_REQUEST_TYPE || 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, alert: alertInfo })
      });
      console.log('[Security Alert] WhatsApp alert dispatched');
    }
  } catch (err) {
    console.warn('[Security Alert] Could not send WhatsApp alert:', err.message);
  }
}

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const requireAuth = asyncRoute(async (req, res, next) => {
  if (!req.session || !req.session.userId) return res.redirect('/login');
  // Enforce password change for first-login users (allow /settings/security and /logout through)
  const ALLOWED_WHEN_MUST_CHANGE = ['/settings/security', '/logout'];
  if (!ALLOWED_WHEN_MUST_CHANGE.some(p => req.path.startsWith(p))) {
    const u = await User.findById(req.session.userId).select('mustChangePassword').lean();
    if (u && u.mustChangePassword) return res.redirect('/settings/security?mustChange=1');
  }
  next();
});

async function boot() {
  if (process.env.MONGODB_URI) await mongoose.connect(process.env.MONGODB_URI);

  // Auto-upgrade weak or default SESSION_SECRET
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'CHANGE_ME' || process.env.SESSION_SECRET === 'change-me' || process.env.SESSION_SECRET.length < 32) {
    const strongSecret = crypto.randomBytes(64).toString('hex');
    await saveEnv({ SESSION_SECRET: strongSecret });
    process.env.SESSION_SECRET = strongSecret;
    console.log('🔒 Weak SESSION_SECRET auto-upgraded to 128-char cryptographic secret.');
  }

  const SHA256_ADMIN_HASH = crypto.createHash('sha256').update('admin').digest('hex');
  let existing = await User.findOne({ username: 'admin' });

  if (!existing) {
    // Fresh install — generate a strong random password
    const rawPass = process.env.ADMIN_DEFAULT_PASSWORD || crypto.randomBytes(10).toString('base64url').slice(0, 14);
    const hash = await bcrypt.hash(rawPass, BCRYPT_ROUNDS);
    await User.create({ username: 'admin', passwordHash: hash, name: 'Administrator', mustChangePassword: true });
    if (!process.env.ADMIN_DEFAULT_PASSWORD) {
      console.log('\n========================================');
      console.log('  ✅  Admin account created!');
      console.log(`  👤  Username : admin`);
      console.log(`  🔑  Password : ${rawPass}`);
      console.log('  ⚠️   Please change this password after first login!');
      console.log('========================================\n');
    }
  } else if (existing.passwordHash === SHA256_ADMIN_HASH) {
    // Existing admin still using unsafe SHA-256 hash of "admin" — migrate to bcrypt
    const rawPass = process.env.ADMIN_DEFAULT_PASSWORD || crypto.randomBytes(10).toString('base64url').slice(0, 14);
    const hash = await bcrypt.hash(rawPass, BCRYPT_ROUNDS);
    await User.updateOne({ username: 'admin' }, { $set: { passwordHash: hash, mustChangePassword: true } });
    console.log('\n========================================');
    console.log('  🔒  Security upgrade: admin password migrated to bcrypt!');
    console.log(`  🔑  New Password : ${rawPass}`);
    console.log('  ⚠️   Please change this password immediately after login!');
    console.log('========================================\n');
  }
  // If admin exists with bcrypt hash already — no action needed
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

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minute window
  max: 5, // max 5 failed attempts per IP
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: (req, res) => {
    const alertInfo = {
      username: (typeof req.body?.username === 'string' ? req.body.username : 'RateLimited'),
      ip: req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      userAgent: req.headers['user-agent']
    };
    sendSecurityAlertEmail(alertInfo).catch(() => {});
    sendSecurityAlertWhatsApp(alertInfo).catch(() => {});
    res.status(429).render('login', {
      error: 'अत्यधिक असफल प्रयास! सुरक्षा कारणों से लॉगिन 15 मिनट के लिए ब्लॉक कर दिया गया है।',
      csrfToken: req.session?.csrfToken || ''
    });
  }
});

app.get('/login', (req, res) => res.render('login', { error: null, csrfToken: req.session?.csrfToken || '' }));

app.post('/login', loginLimiter, csrfProtect, asyncRoute(async (req, res) => {
  // Prevent NoSQL Injection: strictly enforce string primitives
  const username = (typeof req.body?.username === 'string') ? req.body.username.trim() : '';
  const password = (typeof req.body?.password === 'string') ? req.body.password : '';
  if (!username || !password) {
    return res.render('login', { error: 'गलत यूज़रनेम या पासवर्ड', csrfToken: req.session?.csrfToken || '' });
  }

  const u = await User.findOne({ username });
  // Constant-time: always run bcrypt even if user not found (prevent timing attacks)
  const dummyHash = '$2b$12$invalidhashfortimingprotection000000000000000000000000';
  const isValid = u ? await bcrypt.compare(password, u.passwordHash) : await bcrypt.compare('', dummyHash).catch(() => false);
  
  if (!isValid) {
    const alertInfo = {
      username: username || 'Unknown',
      ip: req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      userAgent: req.headers['user-agent']
    };
    // Send instant Email and WhatsApp alert on every wrong password attempt
    sendSecurityAlertEmail(alertInfo).catch(e => console.warn('[Email Alert Error]:', e.message));
    sendSecurityAlertWhatsApp(alertInfo).catch(e => console.warn('[WhatsApp Alert Error]:', e.message));

    return res.render('login', { error: 'गलत यूज़रनेम या पासवर्ड', csrfToken: req.session?.csrfToken || '' });
  }

  // Regenerate session ID upon successful login to prevent session fixation
  req.session.regenerate(async (err) => {
    if (err) console.error('Session regenerate error:', err);
    req.session.userId = u._id;
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    if (u.mustChangePassword) return res.redirect('/settings/security?mustChange=1');
    res.redirect('/dashboard');
  });
}));

app.post('/logout', csrfProtect, (req, res) => {
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
    Invoice.countDocuments({ status: 'pending_verification' }),
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

app.post('/api/invoices/upload', requireAuth, (req, res, next) => {
  upload.array('invoices', 50)(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}, csrfProtect, asyncRoute(async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'कृपया कम से कम एक PDF या Excel फ़ाइल चुनें' });
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

      // 6. Save Invoice in MongoDB — status: pending_verification (admin verify karega baad mein)
      const newInv = await Invoice.create({
        ...data,
        partyId: party._id,
        originalFileName: f.originalname,
        driveFileId: driveId,
        driveFolderId: folderId,
        localPath: localDest,
        status: 'pending_verification'
      });

      job.status = 'completed';
      job.invoiceNumber = data.invoiceNumber || ('INV-' + Date.now().toString().slice(-4));
      job.invoiceType = data.invoiceType;
      job.partyName = partyName;
      job.pendingVerification = true; // Admin ko Pending page pe verify karna hoga
      // NOTE: Auto-email ab verify karne ke baad trigger hoga (/invoice/:id/verify route mein)
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
  // Sirf admin-verified (completed) invoices dikhao
  const q = { status: 'completed' };
  if (req.query.type && req.query.type !== 'ALL') q.invoiceType = req.query.type;
  if (req.query.party) q.partyId = req.query.party;
  if (req.query.financialYear) q.financialYear = String(req.query.financialYear);
  if (req.query.month) q.month = String(req.query.month);
  if (req.query.search && typeof req.query.search === 'string') {
    const s = escapeRegex(req.query.search);
    if (s) {
      q.$or = [
        { invoiceNumber: new RegExp(s, 'i') }, 
        { buyerName: new RegExp(s, 'i') }, 
        { sellerName: new RegExp(s, 'i') }
      ];
    }
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
  // Sirf naye upload hue invoices jo abhi admin ne verify nahi kiye
  const q = { status: 'pending_verification' };
  if (req.query.type && req.query.type !== 'ALL') q.invoiceType = String(req.query.type);
  if (req.query.party) q.partyId = String(req.query.party);
  if (req.query.financialYear) q.financialYear = String(req.query.financialYear);
  if (req.query.month) q.month = String(req.query.month);
  if (req.query.search && typeof req.query.search === 'string') {
    const s = escapeRegex(req.query.search);
    if (s) {
      q.$and = [{
        $or: [
          { invoiceNumber: new RegExp(s, 'i') },
          { buyerName: new RegExp(s, 'i') },
          { sellerName: new RegExp(s, 'i') }
        ]
      }];
    }
  }
  const invoices = await Invoice.find(q).populate('partyId').sort({ createdAt: -1 }).limit(1000);
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

// Admin: Invoice verify karo (pending_verification → completed)
app.post('/invoice/:id/verify', requireAuth, csrfProtect, asyncRoute(async (req, res) => {
  const inv = await Invoice.findById(req.params.id).populate('partyId');
  if (!inv) return res.status(404).send('Invoice nahi mila');
  if (inv.status !== 'pending_verification') return res.redirect('/reports/pending');

  // Status completed kar do
  inv.status = 'completed';
  await inv.save();

  // Auto-email workflow trigger (jo pehle upload pe hota tha, ab verify pe hoga)
  try {
    const invDateRef = inv.invoiceDate || new Date();
    const isPrevMonth = isPreviousMonth(invDateRef);
    const party = inv.partyId;
    if (inv.invoiceType === 'SELL' && isPrevMonth && process.env.AUTO_EMAIL !== 'false') {
      if (party && party.email) {
        let pdfBuffer;
        if (inv.driveFileId) {
          try { pdfBuffer = await downloadFile(inv.driveFileId); } catch(e) {}
        }
        if (!pdfBuffer && inv.localPath && fs.existsSync(inv.localPath)) {
          pdfBuffer = fs.readFileSync(inv.localPath);
        }
        if (pdfBuffer) {
          await sendInvoiceEmail(party.email, inv, pdfBuffer);
          inv.emailSent = true;
          inv.emailSentAt = new Date();
          inv.emailStatus = 'sent';
          await inv.save();
        }
      }
    }
  } catch (emailErr) {
    console.error('Verify auto-email error:', emailErr.message);
  }

  res.redirect('/reports/pending');
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

app.post('/api/reports/ai-chat', requireAuth, csrfProtect, asyncRoute(async (req, res) => {
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

app.post('/invoice/:id/email', requireAuth, csrfProtect, asyncRoute(async (req, res) => {
  const inv = await Invoice.findById(req.params.id).populate('partyId');
  if (!inv) return res.sendStatus(404);
  if (!inv.partyId || !inv.partyId.email) return res.status(400).send('Party email नहीं है');
  const safeEmail = validateAndSanitizeEmail(inv.partyId.email);
  let pdf;
  if (inv.driveFileId) {
    try { pdf = await downloadFile(inv.driveFileId); } catch (e) {}
  }
  if (!pdf && inv.localPath && fs.existsSync(inv.localPath)) {
    pdf = fs.readFileSync(inv.localPath);
  }
  if (!pdf) return res.status(400).send('Invoice PDF file उपलब्ध नहीं है');
  await sendInvoiceEmail(safeEmail, inv, pdf);
  inv.emailSent = true;
  inv.emailSentAt = new Date();
  inv.emailStatus = 'sent';
  await inv.save();
  res.redirect('/reports/invoices');
}));

app.post('/invoice/:id/delete', requireAuth, csrfProtect, asyncRoute(async (req, res) => {
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

app.post('/parties/update/:id', requireAuth, csrfProtect, asyncRoute(async (req, res) => {
  const { email, mobile } = req.body;
  const safeEmail = email ? validateAndSanitizeEmail(email) : '';
  await Party.findByIdAndUpdate(req.params.id, { email: safeEmail, mobile: String(mobile || '').replace(/[\r\n]/g, '').trim() });
  res.redirect('/parties');
}));

app.post('/api/parties/save-email-and-send', requireAuth, csrfProtect, asyncRoute(async (req, res) => {
  const { partyId, email, invoiceId } = req.body;
  if (!partyId || !email || !invoiceId) return res.status(400).json({ error: 'partyId, email और invoiceId ज़रूरी हैं' });
  const safeEmail = validateAndSanitizeEmail(email);
  await Party.findByIdAndUpdate(partyId, { email: safeEmail });
  const inv = await Invoice.findById(invoiceId);
  if (!inv) return res.status(404).json({ error: 'Invoice नहीं मिला' });
  const pdfBuffer = await downloadFile(inv.driveFileId);
  await sendInvoiceEmail(safeEmail, inv, pdfBuffer);
  inv.emailSent = true;
  inv.emailSentAt = new Date();
  inv.emailStatus = 'sent';
  await inv.save();
  res.json({ message: `ईमेल भेज दिया गया ${email}` });
}));

async function renderSettings(req, res, activeTab = 'company') {
  const googleTokens = await Setting.findOne({ key: 'google_tokens' });
  const isDriveConnected = !!(googleTokens && googleTokens.value);
  const currentUser = await User.findById(req.session.userId).select('mustChangePassword').lean();
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
    mustChangePassword: !!(currentUser && currentUser.mustChangePassword),
    saved: req.query.saved,
    securityError: req.query.securityError || null,
    securitySuccess: req.query.securitySuccess || null,
    mustChange: req.query.mustChange || null
  });
}

const SETTINGS_PIN = process.env.SETTINGS_PIN || process.env.DELETE_PIN || '1234';

const requireSettingsPin = asyncRoute(async (req, res, next) => {
  // If user is forced to change initial password, allow access to /settings/security
  if (req.path === '/settings/security') {
    const u = await User.findById(req.session.userId).select('mustChangePassword').lean();
    if (u && u.mustChangePassword) {
      return next();
    }
  }

  if (req.session && req.session.settingsUnlocked) {
    return next();
  }

  return res.render('settings-pin', {
    page: 'settings',
    pageTitle: 'Unlock Settings',
    pageHeading: 'Settings PIN',
    returnUrl: req.originalUrl || '/settings',
    error: req.query.pinError || null,
    csrfToken: req.session?.csrfToken || ''
  });
});

app.post('/settings/unlock-pin', requireAuth, csrfProtect, (req, res) => {
  const pin = String(req.body?.pin || '').trim();
  const returnUrl = (typeof req.body?.returnUrl === 'string' && req.body.returnUrl.startsWith('/settings'))
    ? req.body.returnUrl
    : '/settings';

  if (pin === SETTINGS_PIN) {
    req.session.settingsUnlocked = true;
    return res.redirect(returnUrl);
  }
  res.redirect('/settings?pinError=' + encodeURIComponent('गलत PIN दर्ज किया गया है!'));
});

app.post('/settings/lock', requireAuth, csrfProtect, (req, res) => {
  if (req.session) {
    req.session.settingsUnlocked = false;
  }
  res.redirect('/settings');
});

app.get('/settings', requireAuth, requireSettingsPin, asyncRoute((req, res) => renderSettings(req, res, req.query.tab || 'company')));
app.get('/settings/company', requireAuth, requireSettingsPin, asyncRoute((req, res) => renderSettings(req, res, 'company')));
app.get('/settings/drive', requireAuth, requireSettingsPin, asyncRoute((req, res) => renderSettings(req, res, 'drive')));
app.get('/settings/google', requireAuth, requireSettingsPin, asyncRoute((req, res) => renderSettings(req, res, 'drive')));
app.get('/settings/gmail', requireAuth, requireSettingsPin, asyncRoute((req, res) => renderSettings(req, res, 'gmail')));
app.get('/settings/gemini', requireAuth, requireSettingsPin, asyncRoute((req, res) => renderSettings(req, res, 'gemini')));
app.get('/settings/email', requireAuth, requireSettingsPin, asyncRoute((req, res) => renderSettings(req, res, 'template')));
app.get('/settings/template', requireAuth, requireSettingsPin, asyncRoute((req, res) => renderSettings(req, res, 'template')));
app.get('/settings/whatsapp', requireAuth, requireSettingsPin, asyncRoute((req, res) => renderSettings(req, res, 'whatsapp')));

// Security tab
app.get('/settings/security', requireAuth, requireSettingsPin, asyncRoute((req, res) => renderSettings(req, res, 'security')));

// Password change handler
app.post('/settings/security', csrfProtect, asyncRoute(async (req, res) => {
  if (!req.session || !req.session.userId) return res.redirect('/login');
  const { currentPassword, newPassword, confirmPassword } = req.body;

  const u = await User.findById(req.session.userId);
  if (!u) return res.redirect('/login');

  // Validate new password
  if (!newPassword || newPassword.length < 8) {
    return res.redirect('/settings/security?securityError=New+password+must+be+at+least+8+characters');
  }
  if (newPassword !== confirmPassword) {
    return res.redirect('/settings/security?securityError=New+passwords+do+not+match');
  }

  // Verify current password (skip check if mustChangePassword — first login)
  if (!u.mustChangePassword) {
    const isValid = await bcrypt.compare(currentPassword || '', u.passwordHash);
    if (!isValid) {
      return res.redirect('/settings/security?securityError=Current+password+is+incorrect');
    }
  }

  // Hash and save new password
  const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await User.updateOne({ _id: u._id }, { $set: { passwordHash: newHash, mustChangePassword: false } });
  res.redirect('/settings/security?securitySuccess=1');
}));


app.post('/settings/company', requireAuth, (req, res, next) => {
  uploadLogo.single('logo')(req, res, (err) => {
    if (err) return res.redirect('/settings/company?error=' + encodeURIComponent(err.message));
    next();
  });
}, csrfProtect, asyncRoute(async (req, res) => {
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

app.post('/settings/google', requireAuth, csrfProtect, asyncRoute(async (req, res) => {
  const updates = {};
  if (req.body.googleClientId !== undefined) updates.GOOGLE_CLIENT_ID = req.body.googleClientId;
  if (req.body.googleClientSecret !== undefined) updates.GOOGLE_CLIENT_SECRET = req.body.googleClientSecret;
  if (req.body.googleRedirectUri !== undefined) updates.GOOGLE_REDIRECT_URI = req.body.googleRedirectUri;
  if (req.body.gmailFromName !== undefined) updates.GMAIL_FROM_NAME = req.body.gmailFromName;
  await saveEnv(updates);
  res.redirect('/settings/drive?saved=1');
}));

app.post('/settings/gmail', requireAuth, csrfProtect, asyncRoute(async (req, res) => {
  if (req.body.gmailFromName !== undefined) {
    await saveEnv({ GMAIL_FROM_NAME: req.body.gmailFromName });
  }
  res.redirect('/settings/gmail?saved=1');
}));

app.post('/settings/gemini', requireAuth, csrfProtect, asyncRoute(async (req, res) => {
  const keys = String(req.body.keys || '').split(/\r?\n|,/).map(s => s.trim()).filter(Boolean);
  await saveEnv({ GEMINI_API_KEYS: keys.join(',') });
  res.redirect('/settings/gemini?saved=1');
}));

app.post('/settings/email', requireAuth, csrfProtect, asyncRoute(async (req, res) => {
  await saveEnv({ EMAIL_SUBJECT_TEMPLATE: req.body.subject, EMAIL_BODY_TEMPLATE: req.body.body });
  res.redirect('/settings/email?saved=1');
}));

app.post('/settings/whatsapp', requireAuth, csrfProtect, asyncRoute(async (req, res) => {
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
  console.error('[Application Error]:', err.stack || err);
  if (res.headersSent) {
    return next(err);
  }
  if (req.xhr || req.headers['content-type'] === 'application/json' || (req.headers.accept && req.headers.accept.includes('application/json'))) {
    return res.status(500).json({ error: 'Internal server error. Please try again or contact support.' });
  }
  res.status(500).send('Internal Server Error. Please contact administrator.');
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