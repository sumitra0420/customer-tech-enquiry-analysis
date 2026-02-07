const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const bedrockClient = new BedrockRuntimeClient({ region: 'ap-southeast-2' });
const s3Client = new S3Client({ region: 'ap-southeast-2' });

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Content-Type': 'application/json',
};

// Product categorization based on model/type patterns
function categorizeProduct(typeValue) {
  const typeStr = String(typeValue).toUpperCase().trim();

  // Baby Monitor - starts with BW
  if (typeStr.startsWith('BW')) {
    return 'Baby Monitor';
  }

  // Dash Cam - contains DASH or IGO
  if (typeStr.includes('DASH') || typeStr.includes('IGO')) {
    return 'Dash Cam';
  }

  // Phone - contains DECT, SSE, FP, or ELITE
  if (['DECT', 'SSE', 'FP', 'ELITE'].some(indicator => typeStr.includes(indicator))) {
    return 'Phone';
  }

  // Security Camera - contains SOLO or APPCAM
  if (['SOLO', 'APPCAM', 'APP CAM'].some(indicator => typeStr.includes(indicator))) {
    return 'Security Camera';
  }

  // Recorder - contains DVR, NVR, CVR, XVR, or G37
  if (['DVR', 'NVR', 'CVR', 'XVR', 'G37'].some(indicator => typeStr.includes(indicator))) {
    return 'Recorder';
  }

  // Radio - contains XTRAK, UH, MHS, X86, X76, or ADV25
  if (['XTRAK', 'UH', 'MHS', 'X86', 'X76', 'ADV25'].some(indicator => typeStr.includes(indicator))) {
    return 'Radio';
  }

  // Power Supply
  if (typeStr.includes('UPP')) {
    return 'Power Supply';
  }

  // Solar Panel
  if (typeStr.includes('SPS')) {
    return 'Solar Panel';
  }

  // Service/Maintenance
  if (['CLEAN', 'SERVICE', 'TEST', 'NETWORK'].some(word => typeStr.includes(word))) {
    return 'Service/Maintenance';
  }

  // Numeric-only entries
  if (/^\d+$/.test(typeStr)) {
    return 'Unknown';
  }

  return 'Other';
}

// Keywords to detect product from user enquiry text
const PRODUCT_KEYWORDS = {
  'Baby Monitor': ['baby', 'monitor', 'bw3', 'bw4', 'nursery', 'pairing'],
  'Dash Cam': ['dash', 'dashcam', 'dashview', 'igocam', 'car camera', 'driving'],
  'Phone': ['phone', 'dect', 'handset', 'dial', 'cordless', 'base unit', 'answering', 'sse', 'xdect', 'elite'],
  'Security Camera': ['security camera', 'solo', 'appcam', 'surveillance', 'cctv'],
  'Recorder': ['dvr', 'nvr', 'cvr', 'xvr', 'recorder', 'g37'],
  'Radio': ['radio', 'xtrak', 'walkie', 'two-way', 'uhf', 'mhs'],
  'Power Supply': ['power supply', 'upp', 'adapter', 'charger'],
  'Solar Panel': ['solar', 'sps', 'panel'],
};

// Cache for CSV data (persists across warm Lambda invocations)
let cachedData = null;

async function loadHistoricalData() {
  if (cachedData) return cachedData;

  const response = await s3Client.send(new GetObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: 'repair_data.csv',
  }));

  const csvText = await response.Body.transformToString();
  const lines = csvText.split('\n');
  const headers = lines[0].split(',');

  cachedData = lines.slice(1).filter(line => line.trim()).map(line => {
    const values = line.match(/(".*?"|[^,]+)/g) || [];
    const row = {};
    headers.forEach((header, i) => {
      row[header.trim()] = (values[i] || '').replace(/^"|"$/g, '').trim();
    });
    return row;
  });

  return cachedData;
}

function detectProduct(text) {
  const lowerText = text.toLowerCase();

  for (const [product, keywords] of Object.entries(PRODUCT_KEYWORDS)) {
    for (const keyword of keywords) {
      if (lowerText.includes(keyword)) {
        return product;
      }
    }
  }
  return null;
}

function filterRelevantCases(data, product, text, maxCases = 10) {
  // First filter by product category (using Model column to categorize)
  let filtered = product
    ? data.filter(row => categorizeProduct(row.Model) === product)
    : data;

  // Extract keywords from user text for relevance scoring
  const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 3);

  // Score each case by keyword matches
  const scored = filtered.map(row => {
    const content = `${row['Custormer comment']} ${row['Repair comment']}`.toLowerCase();
    const score = words.filter(word => content.includes(word)).length;
    return { ...row, score };
  });

  // Sort by relevance and take top cases
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxCases)
    .map(({ score, ...row }) => row);
}

function formatCasesForPrompt(cases) {
  if (cases.length === 0) return 'No similar historical cases found.';

  return cases.map(c =>
    `- Job: ${c.Job} | Model: ${c.Model} | Issue: ${c['Custormer comment']} | Resolution: ${c['Repair comment']}`
  ).join('\n');
}

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { text, debugMode } = body;

    if (!text || !text.trim()) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Missing enquiry text' }),
      };
    }

    // Load and filter historical data
    const historicalData = await loadHistoricalData();
    const detectedProduct = detectProduct(text);
    const relevantCases = filterRelevantCases(historicalData, detectedProduct, text);
    const historicalContext = formatCasesForPrompt(relevantCases);

    // Debug mode - return filtered cases without calling Bedrock
    if (debugMode) {
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          debugMode: true,
          detectedProduct,
          totalHistoricalRecords: historicalData.length,
          matchedCases: relevantCases.length,
          relevantCases,
          promptPreview: historicalContext,
        }),
      };
    }

    const prompt = `You are a technician and online technical support assistant responsible for answering customer technical enquiries related to company products
Customers must provide the following information before support can be offered: Product category,Product model,Proof of purchase with purchase date
Each product has a specific warranty period such as IGOCAM90R 1 year warranty, DASHVIEW models 2 year warranty, Baby monitors 2 year warranty except swollen batteries which have an extended warranty etc.
- If the product is under warranty analyse the reported issue and provide step by step troubleshooting guidance
- If the issue persists after troubleshooting offer further solutions such as repair or replacement
- For replacement the customer must return the unit once the unit arrives at headquarters a replacement will be issued
- For repair the customer must return the product to headquarters where it will be sent to the technical department for physical inspection and further investigation
- If the product is out of warranty and the customer requests repair the customer must return the faulty product to the company and a repair quotation will be provided
- If the product is not repairable the company will offer a 20 percent discount to purchase a new unit
- If the customer rejects the quotation the unit will not be returned
- If the customer requests the faulty unit to be returned after rejecting the quotation a rejection fee of 45 AUD will apply.

Detected Product Category: ${detectedProduct || 'Unknown'}

Historical Similar Cases:
${historicalContext}

Analyse the following customer enquiry and provide:

1. **Category**: The type of issue (e.g., Hardware, Software, Network, Account, Billing, etc.)
2. **Priority**: First email is low priority, second email is medium priority, third email is high priority
3. **Key Points**: Main technical details or concerns mentioned
4. **Suggested Response for email**: A draft response or next steps for the support team
5. **Suggested Response for technical report**: shorter than email version.
6. **Relevant Historical Cases**: Reference the similar cases above if applicable.

Customer Enquiry:
${text}

Provide your analysis in a clear, structured format.`;

    const response = await bedrockClient.send(
      new InvokeModelCommand({
        modelId: process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-haiku-20240307-v1:0',
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: 1024,
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
        }),
      })
    );

    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    const analysis = responseBody.content[0].text;

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        analysis,
        detectedProduct,
        matchedCases: relevantCases.length,
      }),
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Analysis failed', details: error.message }),
    };
  }
};
