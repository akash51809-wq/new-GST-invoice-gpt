const fs = require('fs');
const { GoogleGenAI } = require('@google/genai');
const pdfParse = require('pdf-parse');

let rr = 0;

function keys() {
  return (process.env.GEMINI_API_KEYS || '')
    .split(/[\r\n,]+/)
    .map(x => x.trim())
    .filter(Boolean);
}

const CANDIDATE_MODELS = [
  'gemini-flash-lite-latest',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-flash-latest'
];

async function generateWithFallback(ai, prompt, isJson = false) {
  const customModel = process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : [];
  const models = [...new Set([...customModel, ...CANDIDATE_MODELS])];

  let lastErr;
  for (const m of models) {
    try {
      const opts = { model: m, contents: prompt };
      if (isJson) opts.config = { responseMimeType: 'application/json' };
      const res = await ai.models.generateContent(opts);
      if (res && res.text) return res.text;
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || '');
      // If 503, 429, 404, or UNAVAILABLE, try next candidate model
      if (msg.includes('503') || msg.includes('429') || msg.includes('404') || msg.includes('UNAVAILABLE') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('NOT_FOUND')) {
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('Gemini models unavailable');
}

async function processInvoice(file) {
  const buffer = fs.readFileSync(file);
  const parsed = await pdfParse(buffer);
  const text = (parsed && parsed.text) ? parsed.text.trim() : '';
  if (!text) throw new Error('PDF file me koi text nahi mila (Scanned/Empty PDF)');

  const ks = keys();
  if (!ks.length) throw new Error('GEMINI_API_KEYS सेट नहीं है। कृपया Settings > Gemini में API Key जोड़ें।');

  let last;
  for (let attempt = 0; attempt < ks.length; attempt++) {
    const key = ks[(rr + attempt) % ks.length];
    try {
      const ai = new GoogleGenAI({ apiKey: key });
      const prompt = `Read this complete invoice text and return ONLY valid JSON.
Extract these exact fields:
- invoiceNumber (string, or empty string if not found)
- invoiceDate (string in YYYY-MM-DD format if possible, or ISO string)
- invoiceAmount (number, total grand amount of the invoice)
- buyerName (string, company or customer receiving goods/services)
- sellerName (string, vendor or supplier issuing invoice)
- buyerGSTIN (string, GSTIN of buyer if available)
- sellerGSTIN (string, GSTIN of seller if available)

Do not invent or hallucinate data. If missing, use empty string or 0.
INVOICE TEXT:
${text}`;

      const raw = await generateWithFallback(ai, prompt, true);
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Valid JSON not found in Gemini response');
      const data = JSON.parse(jsonMatch[0]);
      rr = (rr + attempt + 1) % ks.length;
      return data;
    } catch (e) {
      last = e;
      const msg = String(e.message || '');
      if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('503')) {
        continue;
      }
    }
  }
  throw last || new Error('Gemini processing failed');
}

async function askGeminiReport(question, dataSummary) {
  const ks = keys();
  if (!ks.length) throw new Error('GEMINI_API_KEYS सेट नहीं है। कृपया Settings > Gemini में API Key जोड़ें।');

  let last;
  for (let attempt = 0; attempt < ks.length; attempt++) {
    const key = ks[(rr + attempt) % ks.length];
    try {
      const ai = new GoogleGenAI({ apiKey: key });
      const prompt = `You are an expert GST Financial Assistant for "${dataSummary.companyName || 'Easy Recharge Solution'}".
Here is the current live summary of invoices and parties from the database:
${JSON.stringify(dataSummary, null, 2)}

User Question: "${question}"

Provide a concise, helpful, and professional answer in Hindi or Hinglish (or English if the question was in English).
Highlight important numbers, amounts in ₹, and party names in bold. If calculating totals or pending counts, base it strictly on the provided real data.`;

      const responseText = await generateWithFallback(ai, prompt, false);
      rr = (rr + attempt + 1) % ks.length;
      return responseText.trim();
    } catch (e) {
      last = e;
      const msg = String(e.message || '');
      if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('503')) {
        continue;
      }
    }
  }
  throw last || new Error('Gemini query failed');
}

module.exports = { processInvoice, askGeminiReport };
