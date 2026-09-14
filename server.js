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
const { processInvoice } = require('./services/gemini-service');
const { ensureFolderPath, uploadFile, downloadFile, deleteFile } = require('./services/drive-service');
const { sendInvoiceEmail } = require('./services/gmail-service');
const { Invoice, Party, Setting, User } = require('./models');

const app = express();
const PORT = process.env.PORT || 4322;
const TMP = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

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
  const [total, buy, sell, parties] = await Promise.all([
    Invoice.countDocuments({ status: 'completed' }),
    Invoice.countDocuments({ invoiceType: 'BUY', status: 'completed' }),
    Invoice.countDocuments({ invoiceType: 'SELL', status: 'completed' }),
    Party.countDocuments()
  ]);
  res.render('dashboard', { total, buy, sell, parties });
}));

app.get('/invoices/upload', requireAuth, (req, res) => res.render('upload', { message: null }));

app.post('/api/invoices/upload', requireAuth, upload.array('invoices', 50), asyncRoute(async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'PDF चुनें' });
  const company = process.env.COMPANY_NAME || 'Company';
  const results = [];
  const pendingEmails = [];
  
  for (let i = 0; i < files.length; i++) {
    const f = files[i]; let job = { file: f.originalname, status: 'processing', index: i + 1, total: files.length };
    try {
      const data = await processInvoice(f.path);
      data.financialYear = fyFor(data.invoiceDate || new Date());
      data.month = monthName(data.invoiceDate || new Date());
      data.invoiceType = (String(data.buyerName || '').toLowerCase().includes(company.toLowerCase())) ? 'BUY' : ((String(data.sellerName || '').toLowerCase().includes(company.toLowerCase())) ? 'SELL' : 'UNKNOWN');
      if (data.invoiceType === 'UNKNOWN') throw new Error('Company name buyer/seller में नहीं मिला');
      const dup = await Invoice.findOne({ invoiceNumber: data.invoiceNumber, invoiceAmount: data.invoiceAmount });
      if (dup) { job.status = 'duplicate'; job.error = 'Duplicate invoice number + amount'; results.push(job); fs.unlinkSync(f.path); continue; }
      
      const folderType = data.invoiceType === 'BUY' ? 'buy' : 'buysell';
      const folder = await ensureFolderPath([process.env.GOOGLE_DRIVE_ROOT || 'GST Invoices', data.financialYear, folderType, data.month]);
      const drive = await uploadFile(f.path, f.originalname, folder.id);
      
      let partyName = data.invoiceType === 'BUY' ? data.sellerName : data.buyerName;
      let party = await Party.findOne({ name: new RegExp('^' + partyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') });
      if (!party) party = await Party.create({ name: partyName, gstin: data.invoiceType === 'BUY' ? data.sellerGSTIN : data.buyerGSTIN, email: '', mobile: '' });
      
      const newInv = await Invoice.create({ ...data, partyId: party._id, originalFileName: f.originalname, driveFileId: drive.id, driveFolderId: folder.id, status: 'completed' });
      job.status = 'completed'; job.invoiceNumber = data.invoiceNumber; job.invoiceType = data.invoiceType;
      job.partyName = partyName;

      try {
        const invDateRef = newInv.invoiceDate || new Date();
        const isPrevMonth = isPreviousMonth(invDateRef);
        if (newInv.invoiceType === 'SELL' && isPrevMonth) {
          if (party.email) {
            const pdfBuffer = await downloadFile(newInv.driveFileId);
            await sendInvoiceEmail(party.email, newInv, pdfBuffer);
            newInv.emailSent = true;
            newInv.emailSentAt = new Date();
            newInv.emailStatus = 'sent';
            await newInv.save();
            job.autoEmailSent = true;
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
    } catch (e) { job.status = 'failed'; job.error = e.message; }
    finally { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); results.push(job); }
  }
  res.json({ results, pendingEmails });
}));

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
  res.render('invoices', { invoices, parties, query: req.query });
}));

app.get('/invoice/:id/view', requireAuth, asyncRoute(async (req, res) => {
  const inv = await Invoice.findById(req.params.id);
  if (!inv) return res.status(404).send('Not found');
  res.render('invoice', { inv });
}));

app.get('/invoice/:id/download', requireAuth, asyncRoute(async (req, res) => {
  const inv = await Invoice.findById(req.params.id);
  if (!inv) return res.sendStatus(404);
  const data = await downloadFile(inv.driveFileId);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=${inv.originalFileName}`);
  res.end(data);
}));

app.post('/invoice/:id/email', requireAuth, asyncRoute(async (req, res) => {
  const inv = await Invoice.findById(req.params.id).populate('partyId');
  if (!inv) return res.sendStatus(404);
  if (!inv.partyId || !inv.partyId.email) return res.status(400).send('Party email नहीं है');
  const pdf = await downloadFile(inv.driveFileId);
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
  await Invoice.findByIdAndDelete(req.params.id);
  res.redirect('/reports/invoices');
}));

app.get('/parties', requireAuth, asyncRoute(async (req, res) => {
  const parties = await Party.find().sort({ name: 1 });
  res.render('parties', { parties });
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

app.get('/settings/company', requireAuth, (req, res) => res.render('settings-company', { saved: req.query.saved }));
app.post('/settings/company', requireAuth, asyncRoute(async (req, res) => { await saveEnv({ COMPANY_NAME: req.body.companyName }); res.redirect('/settings/company?saved=1'); }));

app.get('/settings/google', requireAuth, (req, res) => res.render('settings-google', { saved: req.query.saved }));
app.post('/settings/google', requireAuth, asyncRoute(async (req, res) => {
  await saveEnv({
    GOOGLE_CLIENT_ID: req.body.googleClientId,
    GOOGLE_CLIENT_SECRET: req.body.googleClientSecret,
    GOOGLE_REDIRECT_URI: req.body.googleRedirectUri,
    GMAIL_FROM_NAME: req.body.gmailFromName
  });
  res.redirect('/settings/google?saved=1');
}));

app.get('/settings/gemini', requireAuth, (req, res) => res.render('settings-gemini', {
  saved: req.query.saved,
  keys: (process.env.GEMINI_API_KEYS || '').split(',').map(s => s.trim()).filter(Boolean)
}));
app.post('/settings/gemini', requireAuth, asyncRoute(async (req, res) => {
  const keys = String(req.body.keys || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  await saveEnv({ GEMINI_API_KEYS: keys.join(',') });
  res.redirect('/settings/gemini?saved=1');
}));

app.get('/settings/email', requireAuth, (req, res) => res.render('settings-email', {
  saved: req.query.saved,
  subject: process.env.EMAIL_SUBJECT_TEMPLATE || '',
  body: process.env.EMAIL_BODY_TEMPLATE || ''
}));
app.post('/settings/email', requireAuth, asyncRoute(async (req, res) => {
  await saveEnv({ EMAIL_SUBJECT_TEMPLATE: req.body.subject, EMAIL_BODY_TEMPLATE: req.body.body });
  res.redirect('/settings/email?saved=1');
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
    const line = `${k}=${String(v || '').replace(/\r?\n/g, '\\n')}`;
    const re = new RegExp(`^${k}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, line) : text + '\n' + line;
  }
  fs.writeFileSync(path.join(__dirname, '.env'), text);
  for (const [k, v] of Object.entries(values)) process.env[k] = v;
}

boot().then(() => app.listen(PORT, () => console.log(`GST Invoice Manager running on ${PORT}`))).catch(e => { console.error(e); process.exit(1); });