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

async function generateWithFallback(ai, contents, isJson = false) {
  const customModel = process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : [];
  const models = [...new Set([...customModel, ...CANDIDATE_MODELS])];

  let lastErr;
  for (const m of models) {
    try {
      const opts = { model: m, contents: contents };
      if (isJson) opts.config = { responseMimeType: 'application/json' };
      const res = await ai.models.generateContent(opts);
      if (res && res.text) return res.text;
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || '');
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
  const ks = keys();
  if (!ks.length) throw new Error('GEMINI_API_KEYS सेट नहीं है। कृपया Settings > Gemini में API Key जोड़ें।');

  // Direct multimodal PDF data for Gemini
  const pdfPart = {
    inlineData: {
      mimeType: 'application/pdf',
      data: buffer.toString('base64')
    }
  };

  const prompt = `You are an expert GST Tax Invoice Data Extraction system.
Analyze this invoice PDF and return ONLY a valid JSON object.
Extract these exact fields:
- invoiceNumber (string, invoice / bill / memo number)
- invoiceDate (string, invoice date in YYYY-MM-DD format if possible)
- invoiceAmount (number, total invoice value / grand total including GST)
- buyerName (string, name of the recipient / customer / buyer)
- sellerName (string, name of the supplier / issuer / seller)
- buyerGSTIN (string, GSTIN of the buyer)
- sellerGSTIN (string, GSTIN of the seller)

Rules:
- Do not guess or invent data. If a field is not present in the invoice, use empty string "" (or 0 for invoiceAmount).
- Return ONLY valid JSON format without markdown code blocks.`;

  // Optional: Extract text layer if pdf-parse succeeds, but NEVER crash if it encounters bad XRef entry or formatting issues
  let textLayer = '';
  try {
    const parsed = await pdfParse(buffer);
    if (parsed && parsed.text) {
      textLayer = parsed.text.trim();
    }
  } catch (pdfErr) {
    // Gracefully ignore pdf-parse XRef issues and let Gemini handle the PDF natively
    console.warn('[PDF-Parse Notice] Native text extraction bypassed (' + pdfErr.message + '), relying on Gemini multimodal vision.');
  }

  const contents = [pdfPart];
  if (textLayer) {
    contents.push(`Extracted text layer:\n${textLayer.slice(0, 15000)}`);
  }
  contents.push(prompt);

  let last;
  for (let attempt = 0; attempt < ks.length; attempt++) {
    const key = ks[(rr + attempt) % ks.length];
    try {
      const ai = new GoogleGenAI({ apiKey: key });
      const raw = await generateWithFallback(ai, contents, true);
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
  throw last || new Error('Gemini invoice processing failed');
}

async function askGeminiReport(question, dataSummary, language = 'English') {
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

MANDATORY LANGUAGE RULE:
You MUST generate the entire answer EXCLUSIVELY in ${language}.
- Do NOT use or mix any Urdu script or words.
- If language is "English", use clean, fluent English only.
- If language is "Hinglish", use Hindi written in English (Latin) script.
- If an Indian regional language is selected (e.g. Hindi, Gujarati, Marathi, Bengali, Tamil, Telugu, Kannada, Malayalam, Punjabi, Odia), generate pure, professional sentences only in that language and script.

Highlight key financial numbers, amounts in ₹, and party names in bold. All calculations and responses must strictly reflect the real data provided above.`;

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
