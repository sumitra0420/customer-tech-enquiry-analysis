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
let cachedWarrantyData = null;

async function loadWarrantyData() {
  if (cachedWarrantyData) return cachedWarrantyData;

  const response = await s3Client.send(new GetObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: 'product_warranty_final.csv',
  }));

  const csvText = await response.Body.transformToString();
  const lines = csvText.split('\n');

  cachedWarrantyData = {};
  lines.slice(1).filter(line => line.trim()).forEach(line => {
    const [model, years] = line.split(',');
    if (model && years) {
      cachedWarrantyData[model.trim().toUpperCase()] = parseInt(years.trim());
    }
  });

  return cachedWarrantyData;
}

function lookupWarranty(text, warrantyData) {
  const upperText = text.toUpperCase();
  let matchedModel = null;
  let warrantyYears = null;

  // Step 1: Direct match — check if any warranty model appears in the text
  for (const [model, years] of Object.entries(warrantyData)) {
    if (upperText.includes(model)) {
      if (!matchedModel || model.length > matchedModel.length) {
        matchedModel = model;
        warrantyYears = years;
      }
    }
  }

  // Step 2: Reverse match — extract tokens from text and check if any warranty model CONTAINS that token
  // This handles shorthand like "X2K-2" matching "APPCAMSOLOX2K-2"
  if (!matchedModel) {
    // Extract alphanumeric tokens (with hyphens/plus) that look like model codes (at least 2 chars, contains a number)
    const tokens = upperText.match(/[A-Z0-9][A-Z0-9\-\+\/]{1,}/g) || [];
    const modelTokens = tokens.filter(t => /\d/.test(t) && t.length >= 3);

    let bestTokenLength = 0;
    for (const token of modelTokens) {
      for (const [model, years] of Object.entries(warrantyData)) {
        if (model.includes(token) && token.length > bestTokenLength) {
          bestTokenLength = token.length;
          matchedModel = model;
          warrantyYears = years;
        }
      }
    }

    // If multiple models match the same token, pick the shortest (most specific) model
    if (matchedModel) {
      const bestToken = modelTokens.find(t => t.length === bestTokenLength);
      let shortestModel = matchedModel;
      for (const [model, years] of Object.entries(warrantyData)) {
        if (model.includes(bestToken) && model.length < shortestModel.length) {
          shortestModel = model;
          matchedModel = model;
          warrantyYears = years;
        }
      }
    }
  }

  return { matchedModel, warrantyYears };
}

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

// Search historical repair data for a model that matches tokens from user text
function detectModelFromHistoricalData(text, historicalData) {
  const upperText = text.toUpperCase();
  // Extract alphanumeric tokens that look like model codes (at least 3 chars, contains a number)
  const tokens = upperText.match(/[A-Z0-9][A-Z0-9\-\+\/]{2,}/g) || [];
  const modelTokens = tokens.filter(t => /\d/.test(t));

  let bestModel = null;
  let bestTokenLength = 0;

  for (const token of modelTokens) {
    for (const row of historicalData) {
      const rowModel = (row.Model || '').toUpperCase();
      if (rowModel.includes(token) && token.length > bestTokenLength) {
        bestModel = rowModel;
        bestTokenLength = token.length;
      }
    }
  }

  return bestModel;
}

function filterRelevantCases(data, product, matchedModel, text, maxCases = 30) {
  // Filter by product category
  let filtered = product
    ? data.filter(row => categorizeProduct(row.Model) === product)
    : data;

  // Extract keywords from user text for relevance scoring
  const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const upperModel = matchedModel ? matchedModel.toUpperCase() : null;

  // Score each case: model match (high weight) + keyword matches
  const scored = filtered.map(row => {
    const rowModel = (row.Model || '').toUpperCase();
    const content = `${row['Custormer comment']} ${row['Repair comment']}`.toLowerCase();

    let score = 0;
    // Exact model match gets highest priority
    if (upperModel && rowModel === upperModel) {
      score += 100;
    }
    // Partial model match (e.g., same model family)
    else if (upperModel && (rowModel.includes(upperModel) || upperModel.includes(rowModel))) {
      score += 50;
    }
    // Keyword relevance from customer text
    score += words.filter(word => content.includes(word)).length;

    return { ...row, score };
  });

  console.log(`Filtered ${filtered.length} cases for product "${product}", model "${matchedModel}". Scoring by model match + ${words.length} keywords.`);

  // Sort by score (model matches first, then keyword relevance), take top results
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

    // Load historical and warranty data
    const [historicalData, warrantyData] = await Promise.all([
      loadHistoricalData(),
      loadWarrantyData(),
    ]);
    // Step 1: Try to detect category and model independently from user text
    let detectedProduct = detectProduct(text);
    let { matchedModel, warrantyYears } = lookupWarranty(text, warrantyData);

    // Step 2: If model not found in warranty data, try historical repair data
    if (!matchedModel) {
      const historicalMatch = detectModelFromHistoricalData(text, historicalData);
      if (historicalMatch) {
        matchedModel = historicalMatch;
      }
    }

    // Step 3: Fill in the gaps — derive one from the other
    // If we have model but no category → get category from model
    if (!detectedProduct && matchedModel) {
      detectedProduct = categorizeProduct(matchedModel);
      if (detectedProduct === 'Unknown' || detectedProduct === 'Other') {
        detectedProduct = null;
      }
    }
    // If we have category but no model → that's fine, we'll ask customer for model
    const relevantCases = filterRelevantCases(historicalData, detectedProduct, matchedModel, text);
    const historicalContext = formatCasesForPrompt(relevantCases);

    // Debug logging - view in CloudWatch Logs
    console.log('=== INPUT ===');
    console.log('Text:', text);
    console.log('=== WARRANTY ===');
    console.log('Matched Model:', matchedModel);
    console.log('Warranty Years:', warrantyYears);
    console.log('=== FILTERING ===');
    console.log('Detected Product:', detectedProduct);
    console.log('Total Historical Records:', historicalData.length);
    console.log('Matched Cases:', relevantCases.length);
    console.log('Relevant Cases:', JSON.stringify(relevantCases, null, 2));
    console.log('=== PROMPT CONTEXT ===');
    console.log('Historical Context:', historicalContext);

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

    const prompt = `You are an AI assistant for a tech support company. Analyse the enquiry and detect which team is using this system.

**TEAM DETECTION RULES (CRITICAL - READ CAREFULLY):**

Use **CUSTOMER SERVICE MODE** if ANY of these are true:
- Enquiry starts with greetings like "Hi", "Hello", "Dear"
- Written in first person ("my device", "I bought", "I need help")
- No SC number present in the text
- Sounds like an email from a customer asking for help

Use **TECHNICIAN MODE** ONLY if ALL of these are true:
- Contains an SC number (format: SC followed by numbers, e.g., SC1234, SC10655)
- Mentions a confirmed purchase date
- Written like an internal repair note, not a customer email

EXAMPLES:
- "Hi, my dashcam keeps restarting" → CUSTOMER SERVICE MODE (customer email, no SC number)
- "Hello Uniden, I bought a baby monitor and it won't pair" → CUSTOMER SERVICE MODE
- "SC12345 - DASHVIEW purchased 01/01/2024, unit restarting" → TECHNICIAN MODE (has SC number + purchase date)

PRODUCT INFORMATION:
- Detected Product Category: ${detectedProduct || 'Unknown'}
- Matched Model: ${matchedModel || 'Unknown'}
- Warranty Period: ${warrantyYears ? warrantyYears + ' year(s)' : 'Unknown'}

DATE DETECTION:
- Look for any date in the text (formats: DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY, or written dates)
- A date at the end of the text or near a product model is likely the PURCHASE DATE
- Use Australian date format: DD/MM/YYYY (day first, not month first)
- Today's date is: ${new Date().toLocaleDateString('en-AU')}

WARRANTY CALCULATION:
- If purchase date and warranty period are known, calculate if the unit is still under warranty
- Under warranty = purchase date + warranty period > today's date
- EXCEPTION: Baby monitors with swollen battery issues have EXTENDED warranty beyond the standard period

COMPANY POLICIES:
- Under warranty: Troubleshoot first, then offer repair or replacement
- For replacement: Customer returns unit, replacement issued when received
- For repair: Product sent to technical department for inspection
- Out of warranty: Customer can request repair, quotation will be provided
- If not repairable: 20% discount offered for new unit
- If customer rejects quotation: Unit will not be returned
- If customer wants rejected unit back: $45 AUD rejection fee applies

HISTORICAL SIMILAR CASES:
${historicalContext}

ENQUIRY TO ANALYSE:
${text}

---

IMPORTANT: Treat the ENTIRE text above as ONE single enquiry. Combine all information provided across all paragraphs. Choose ONLY ONE mode (Customer Service OR Technician) and provide ONLY ONE response. NEVER output both modes.

**IF CUSTOMER SERVICE ENQUIRY:**

CRITICAL PRIORITY RULES - YOU MUST FOLLOW THESE EXACTLY:
- A "product model number" means a SPECIFIC model from our product range, such as: BW3451R, BW5151R, IGOCAM85R, IGOCAM75, DASHVIEW30, APPCAMSOLO+, XDECT8315, SSE45, UH850S, XTRAK50, SOLO2KPT, etc.
- Generic words like "camera", "phone", "baby monitor", "dashcam", "radio" are NOT model numbers. The customer must provide the actual alphanumeric model code.
- "Proof of purchase" means a receipt, invoice, order confirmation number, or a specific purchase date (e.g., "purchased on 15/01/2025"). Vague statements like "I just bought it", "it's new", or "recently purchased" are NOT proof of purchase.
- If the customer has NOT provided BOTH a specific model number AND proof of purchase → you MUST use Low priority. No exceptions.
- ONLY use Medium priority if the customer explicitly states a specific product model number AND provides proof of purchase or a specific purchase date.

**If model OR proof of purchase is MISSING → MUST be Low Priority (1st email):**
1. **Issue Category**: Specific issue type (e.g., Device Not Powering On, Pairing Issue, Screen Problem, Battery Issue, Connectivity Issue, Physical Damage, etc.)
2. **Priority**: Low
3. **Key Points**: Main concerns from customer
4. **Missing Information**: List exactly what is still needed (model number, proof of purchase, purchase date, etc.)
5. **Suggested Email Response**: Professional draft response that acknowledges the customer's issue and politely asks them to provide the missing information. Format the email with proper paragraphs (use blank lines between paragraphs) and use bullet points (markdown - ) for any listed items.
6. **Internal Notes**: Brief note for CS team

**If specific model number AND proof of purchase are both PROVIDED → Medium Priority (2nd email):**
1. **Issue Category**: Specific issue type (e.g., Device Not Powering On, Pairing Issue, Screen Problem, Battery Issue, Connectivity Issue, Physical Damage, etc.)
2. **Priority**: Medium
3. **Warranty Status**: Calculate from purchase date + warranty period. State whether unit is under warranty or out of warranty, and include the expiry date.
4. **Key Points**: Main concerns from customer
5. **Troubleshooting Steps**: Based on historical similar cases above, provide likely diagnosis and troubleshooting steps the customer can try. Reference relevant Job numbers (e.g., Job #12345) from the historical cases.
6. **Suggested Email Response**: Professional draft response. Format the email with proper paragraphs (use blank lines between paragraphs) and use numbered steps (1. 2. 3.) for troubleshooting instructions. The email must include:
   - Troubleshooting steps for the customer to try (as numbered steps)
   - If UNDER warranty: inform the customer that if troubleshooting does not resolve the issue, we can offer a repair or replacement under warranty
   - If OUT of warranty: inform the customer that if troubleshooting does not resolve the issue, a quotation will be provided for repair
7. **Internal Notes**: Brief note for CS team

**IF TECHNICIAN ENQUIRY:**
1. **Issue Category**: Specific issue type (e.g., Broken Clip, Battery Swollen, Screen Damage, Firmware Crash, Connectivity Issue, Water Damage, etc.)
2. **Warranty Status**: Calculate if under warranty based on purchase date
3. **Key Points**: Technical details from complaint
4. **Technical Diagnosis**: Likely root cause based on historical cases
5. **Suggested Repair Action**: Specific repair steps, reference historical Job numbers (SC####)
6. **Parts Likely Needed**: Components that may need replacement
7. **Suggested Technical Report Summary**: Write in PAST TENSE describing what was done. This report is sent TO THE CUSTOMER with the repaired/replaced unit. Example: "Unit was inspected. Battery clip was found broken and has been replaced. TX/RX and audio tested and passed."

FORMATTING RULES:
- Use proper markdown formatting throughout your response
- For the Suggested Email Response: use blank lines between paragraphs, numbered lists (1. 2. 3.) for step-by-step instructions, and bullet points (- ) for listed items
- For Troubleshooting Steps: use numbered lists (1. 2. 3.)
- Ensure the email response is well-structured and easy to read when rendered as markdown

REMEMBER: Output ONLY ONE mode. Start your response with either **[CUSTOMER SERVICE MODE]** or **[TECHNICIAN MODE]** and provide only that single response.

FINAL CHECK BEFORE RESPONDING - DO THIS FIRST:
If this is a Customer Service enquiry, ask yourself these two questions before writing anything:
Q1: "Did the customer provide a SPECIFIC alphanumeric model code (e.g., BW3451R, IGOCAM85R, APPCAMSOLOX2K)?" — words like "camera", "phone", "monitor" do NOT count.
Q2: "Did the customer provide proof of purchase or a specific purchase date (e.g., 12/12/2024)?" — phrases like "I just bought it" or "it's new" do NOT count.
If EITHER answer is NO → Priority MUST be Low. Use the Low Priority format. Do NOT use the Medium Priority format.`;

    const response = await bedrockClient.send(
      new InvokeModelCommand({
        modelId: process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-haiku-20240307-v1:0',
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: 2048,
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
        matchedModel,
        warrantyYears,
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
