const fs=require('fs');
const {GoogleGenAI}=require('@google/genai');
const pdfParse=require('pdf-parse');
let rr=0;
function keys(){return (process.env.GEMINI_API_KEYS||'').split(',').map(x=>x.trim()).filter(Boolean)}
async function processInvoice(file){
 const text=(await pdfParse(fs.readFileSync(file))).text||'';
 const ks=keys(); if(!ks.length)throw new Error('GEMINI_API_KEYS सेट नहीं है');
 let last;
 for(let attempt=0;attempt<ks.length;attempt++){
  const key=ks[(rr+attempt)%ks.length]; try{
   const ai=new GoogleGenAI({apiKey:key});
   const prompt=`Read this complete invoice text and return ONLY valid JSON. Extract: invoiceNumber, invoiceDate (ISO date if possible), invoiceAmount (number), buyerName, sellerName, buyerGSTIN, sellerGSTIN. Do not invent. If missing use empty string or 0.\nTEXT:\n${text}`;
   const r=await ai.models.generateContent({model:process.env.GEMINI_MODEL||'gemini-2.5-flash',contents:prompt});
   const raw=(r.text||'').replace(/```json|```/g,'').trim(); const data=JSON.parse(raw); rr=(rr+attempt+1)%ks.length;return data;
  }catch(e){last=e;if(String(e.message).includes('429')||String(e.message).includes('RESOURCE_EXHAUSTED'))continue;}
 }
  throw last||new Error('Gemini processing failed');
}

async function askGeminiReport(question, dataSummary){
  const ks=keys(); if(!ks.length)throw new Error('GEMINI_API_KEYS सेट नहीं है');
  let last;
  for(let attempt=0;attempt<ks.length;attempt++){
    const key=ks[(rr+attempt)%ks.length]; try{
      const ai=new GoogleGenAI({apiKey:key});
      const prompt=`You are an expert GST Financial Assistant for "${dataSummary.companyName || 'Easy Recharge Solution'}".
Here is the current live summary of invoices and parties from the database:
${JSON.stringify(dataSummary, null, 2)}

User Question: "${question}"

Provide a concise, helpful, and professional answer in Hindi or Hinglish (or English if the question was in English).
Highlight important numbers, amounts in ₹, and party names in bold. If calculating totals or pending counts, base it strictly on the provided real data.`;
      const r=await ai.models.generateContent({model:process.env.GEMINI_MODEL||'gemini-2.5-flash',contents:prompt});
      rr=(rr+attempt+1)%ks.length;
      return (r.text||'').trim();
    }catch(e){
      last=e;
      if(String(e.message).includes('429')||String(e.message).includes('RESOURCE_EXHAUSTED'))continue;
    }
  }
  throw last||new Error('Gemini query failed');
}

module.exports={processInvoice, askGeminiReport};
