const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { Pool } = require('pg');

const bedrockClient = new BedrockRuntimeClient({ region: 'ap-southeast-2' });

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl:      { rejectUnauthorized: false },
  max:      2,
  connectionTimeoutMillis: 10000,
});

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Content-Type': 'application/json',
};

async function extractFromImage(base64Image, mediaType) {
  const prompt = `You are extracting data from a retail purchase receipt photo.

Extract ONLY these fields (if visible on the receipt):
- store_name: The store name (e.g. "BCF", "JB Hi-Fi", "Harvey Norman")
- customer_name: Customer name if shown (e.g. from EFTPOS card name or loyalty card)
- product_name: Full product name, especially any Uniden products
- model_number: Product model number (e.g. MHS155UV, XDECT8355, IGOCAM55)
- purchase_date: Purchase date in YYYY-MM-DD format
- total_price: Total amount paid as a number only (no $ sign)
- receipt_number: Receipt, docket, or invoice number

Reply ONLY with a valid JSON object, no other text or explanation:
{
  "store_name": "...",
  "customer_name": "...",
  "product_name": "...",
  "model_number": "...",
  "purchase_date": "...",
  "total_price": "...",
  "receipt_number": "..."
}

Use null for any field not found on the receipt.`;

  const response = await bedrockClient.send(new InvokeModelCommand({
    modelId: process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType || 'image/jpeg',
              data: base64Image,
            },
          },
          { type: 'text', text: prompt },
        ],
      }],
    }),
  }));

  const body = JSON.parse(new TextDecoder().decode(response.body));
  const text = body.content[0].text.trim();

  // Parse JSON from response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Could not parse JSON from Bedrock response');
  return JSON.parse(jsonMatch[0]);
}

async function saveReceipt(data, uploadedBy) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `INSERT INTO receipts
         (store_name, customer_name, product_name, model_number, purchase_date, total_price, receipt_number, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        data.store_name    || null,
        data.customer_name || null,
        data.product_name  || null,
        data.model_number  || null,
        data.purchase_date || null,
        data.total_price   ? parseFloat(data.total_price) : null,
        data.receipt_number || null,
        uploadedBy         || null,
      ]
    );
    return rows[0].id;
  } finally {
    client.release();
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { action, image, mediaType, receiptData, uploadedBy } = body;

    if (action === 'extract') {
      if (!image) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Missing image' }) };
      }
      console.log('Extracting receipt data from image...');
      const extracted = await extractFromImage(image, mediaType);
      console.log('Extracted:', JSON.stringify(extracted));
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ extracted }),
      };
    }

    if (action === 'save') {
      if (!receiptData) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Missing receipt data' }) };
      }
      console.log('Saving receipt for:', uploadedBy);
      const id = await saveReceipt(receiptData, uploadedBy);
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: true, id }),
      };
    }

    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid action' }) };

  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Failed', details: error.message }),
    };
  }
};
