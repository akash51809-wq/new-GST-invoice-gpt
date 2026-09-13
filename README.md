# GST Invoice Manager

## Features
- Login
- Company setting
- Multiple PDF upload
- Gemini invoice extraction
- Multiple Gemini key rotation
- BUY/SELL detection using company name
- Duplicate detection by invoice number + amount
- Google Drive automatic folder creation
- Gmail invoice email with custom template
- Party directory
- Invoice report + CSV export

## Drive structure
For BUY invoices:
`GST Invoices/FY 2026-27/buy/April/Invoice.pdf`

For SELL invoices:
`GST Invoices/FY 2026-27/buysell/April/Invoice.pdf`

The app creates missing folders automatically.

## Setup
1. Copy `.env.example` to `.env`.
2. Fill MongoDB URI, Google OAuth credentials, and Gemini keys.
3. `npm install`
4. `npm start`
5. Open `http://localhost:4322`
6. Login: `admin / admin`
7. Set Company Name, Google credentials, connect Google account, Gemini keys, and Email template.

## Google Cloud
Enable Google Drive API and Gmail API. Configure OAuth consent and a Web application OAuth client. Add the exact callback URL from `GOOGLE_REDIRECT_URI` to Authorized redirect URIs.

## Security
Never commit `.env` or API keys. The Settings forms write values to the server `.env`; use HTTPS and admin authentication in production.
