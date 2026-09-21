const { google } = require('googleapis');
const { getGoogleTokens, saveGoogleTokens } = require('../utils/token-crypto');

// Strict RFC-compliant email regex & CRLF sanitization to prevent Email Injection
const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

function sanitizeHeader(str) {
  return String(str || '').replace(/[\r\n]+/g, ' ').trim();
}

function validateAndSanitizeEmail(rawEmail) {
  if (!rawEmail || typeof rawEmail !== 'string') {
    throw new Error('Email address is required.');
  }
  const clean = rawEmail.replace(/[\r\n\t\s]+/g, '').trim();
  if (!EMAIL_REGEX.test(clean) || clean.length > 254) {
    throw new Error(`Invalid email format: "${clean}"`);
  }
  return clean;
}

function vars(inv) {
  const cn = process.env.COMPANY_NAME || 'Easy Recharge Solution';
  const pn = (inv.invoiceType === 'BUY' ? inv.sellerName : inv.buyerName) || '';
  const inum = inv.invoiceNumber || '';
  const amt = inv.invoiceAmount != null ? `₹${Number(inv.invoiceAmount).toLocaleString('en-IN')}` : '';
  const dt = inv.invoiceDate ? new Date(inv.invoiceDate).toLocaleDateString('en-IN') : '';
  const link = inv.driveFileId ? `https://drive.google.com/file/d/${inv.driveFileId}/view` : '';
  return {
    COMPANY_NAME: cn,
    company_name: cn,
    PARTY_NAME: pn,
    party_name: pn,
    BILL_NUMBER: inum,
    invoice_number: inum,
    AMOUNT: amt,
    invoice_total: amt,
    DATE: dt,
    invoice_date: dt,
    invoice_link: link
  };
}

function apply(t, v) {
  return String(t || '').replace(/\{\{?\s*([a-zA-Z0-9_]+)\s*\}?\}/g, (_, k) => {
    if (v[k] !== undefined) return v[k];
    const up = k.toUpperCase();
    if (v[up] !== undefined) return v[up];
    const low = k.toLowerCase();
    if (v[low] !== undefined) return v[low];
    return _;
  });
}

async function client() {
  const tokens = await getGoogleTokens();
  if (!tokens) throw new Error('Google account connect करें');
  const o = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
  o.setCredentials(tokens);
  o.on('tokens', (newTokens) => {
    saveGoogleTokens({ ...tokens, ...newTokens }).catch(err => console.warn('[Gmail Token Refresh Error]:', err.message));
  });
  return google.gmail({ version: 'v1', auth: o });
}

async function sendInvoiceEmail(to, inv, pdf) {
  const safeTo = validateAndSanitizeEmail(to);
  const g = await client();
  const v = vars(inv);
  const subject = sanitizeHeader(apply(process.env.EMAIL_SUBJECT_TEMPLATE || 'Invoice {BILL_NUMBER}', v));
  const fromName = sanitizeHeader(process.env.GMAIL_FROM_NAME || v.COMPANY_NAME);
  const body = apply(process.env.EMAIL_BODY_TEMPLATE || 'Please find attached invoice {BILL_NUMBER}.', v);
  const boundary = 'gst_invoice_boundary_' + Date.now().toString(16);

  const raw = [
    `From: ${fromName} <me>`,
    `To: ${safeTo}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    body,
    `--${boundary}`,
    'Content-Type: application/pdf; name="invoice.pdf"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="invoice.pdf"',
    '',
    pdf.toString('base64'),
    `--${boundary}--`
  ].join('\r\n');

  await g.users.messages.send({
    userId: 'me',
    requestBody: { raw: Buffer.from(raw).toString('base64url') }
  });
}

async function sendSecurityAlertEmail(alertInfo) {
  try {
    const g = await client();
    let targetEmail = process.env.ADMIN_ALERT_EMAIL;
    if (!targetEmail) {
      // Automatically send to connected admin Gmail address
      const profile = await g.users.getProfile({ userId: 'me' });
      targetEmail = profile.data.emailAddress;
    }
    if (!targetEmail) return;

    const safeTo = validateAndSanitizeEmail(targetEmail);
    const subject = `⚠️ Security Alert: Failed Login Attempt (${alertInfo.ip || 'Unknown IP'})`;
    const body = [
      `SECURITY ALERT - FAILED LOGIN ATTEMPT`,
      `======================================`,
      `Time: ${new Date().toLocaleString('en-IN')}`,
      `Username Attempted: ${alertInfo.username || 'N/A'}`,
      `IP Address: ${alertInfo.ip || 'N/A'}`,
      `User-Agent: ${alertInfo.userAgent || 'N/A'}`,
      ``,
      `If this was not you, someone may be attempting to guess your password.`,
      `Please ensure your admin password is strong and changed regularly.`,
      `GST Invoice Manager Security System`
    ].join('\n');

    const raw = [
      `From: GST Security Monitor <me>`,
      `To: ${safeTo}`,
      `Subject: ${sanitizeHeader(subject)}`,
      'Content-Type: text/plain; charset=UTF-8',
      '',
      body
    ].join('\r\n');

    await g.users.messages.send({
      userId: 'me',
      requestBody: { raw: Buffer.from(raw).toString('base64url') }
    });
    console.log(`[Security Alert] Email dispatched to ${safeTo}`);
  } catch (err) {
    console.warn('[Security Alert] Could not send email alert:', err.message);
  }
}

module.exports = { sendInvoiceEmail, sendSecurityAlertEmail, validateAndSanitizeEmail };

