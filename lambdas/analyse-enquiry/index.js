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

// Map CSV "Product Type" column values to user-readable category labels
function mapProductType(csvProductType) {
  const type = String(csvProductType || '').toUpperCase().trim();
  if (type === 'BABY MONITORS') return 'Baby Monitor';
  if (type === 'CORDLESS PHONE' || type === 'CORDLESS PHONE - EXTRA HANDSET' || type === 'CORDED') return 'Phone';
  if (type === 'DASHCAM') return 'Dash Cam';
  if (type === 'VS- WIRELESS' || type === 'VS- WIRED') return 'Security Camera';
  if (type === 'UCB - HANDHELD RADIOS' || type === 'UCB - MOBILE RADIOS') return 'Radio';
  if (type === 'MARINE RADIO') return 'Marine Radio';
  if (type === 'JUMP STARTER') return 'Jump Starter';
  if (type === 'RADAR DETECTOR DASH') return 'Radar Detector';
  if (type === 'SCANNER') return 'Scanner';
  if (type === 'NAVI') return 'Navigation';
  if (type.startsWith('ACCESSORIES') || type.startsWith('ANTENNAS')) return 'Accessories';
  if (type === 'SPARE PARTS') return null; // Don't show spare parts as a category
  return null;
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
    Key: 'product_data.csv',
  }));

  const csvText = await response.Body.transformToString();
  const lines = csvText.split('\n');

  cachedWarrantyData = {};
  // CSV columns: Name, Display Name, Model Description, Warranty (Month), Product Type
  lines.slice(1).filter(line => line.trim()).forEach(line => {
    // Replace escaped double-quotes ("") with placeholder before parsing
    // so fields like "10.26"" WIRELESS..." don't shift column positions
    const values = line.replace(/""/g, '\x00').match(/(".*?"|[^,]+)/g) || [];
    const name = (values[0] || '').replace(/^"|"$/g, '').trim().toUpperCase();
    const displayName = (values[1] || '').replace(/^"|"$/g, '').trim().toUpperCase();
    const warrantyMonths = parseInt((values[3] || '').replace(/^"|"$/g, '').trim());
    const productType = (values[4] || '').replace(/^"|"$/g, '').trim();

    if (name && warrantyMonths) {
      cachedWarrantyData[name] = { months: warrantyMonths, productType };
    }
    // Also index by display name (extract model from "MODEL DESCRIPTION - CODE" format)
    // Require at least one digit to avoid indexing generic words like "PHONE", "APP", "CAM"
    if (displayName) {
      const modelMatch = displayName.match(/^([A-Z0-9][A-Z0-9\-\+\/]+)/);
      if (modelMatch && /\d/.test(modelMatch[1])) {
        cachedWarrantyData[modelMatch[1]] = { months: warrantyMonths, productType };
      }
    }
  });

  return cachedWarrantyData;
}

function lookupWarranty(text, warrantyData) {
  const upperText = text.toUpperCase();
  let matchedModel = null;
  let warrantyMonths = null;
  let productType = null;

  // Step 1: Direct match — check if any warranty model appears in the text
  for (const [model, data] of Object.entries(warrantyData)) {
    if (upperText.includes(model)) {
      if (!matchedModel || model.length > matchedModel.length) {
        matchedModel = model;
        warrantyMonths = data.months;
        productType = data.productType;
      }
    }
  }

  // Step 1.5: Normalized match — strip spaces from customer text and match against Name keys
  // Handles "iGO Play 10" → "IGOPLAY10", "App Cam X24B" → "APPCAMX24B", double spaces, etc.
  if (!matchedModel) {
    const normalizedText = upperText.replace(/\s+/g, '');
    for (const [model, data] of Object.entries(warrantyData)) {
      const normalizedModel = model.replace(/\s+/g, '');
      if (normalizedModel.length >= 4 && /\d/.test(normalizedModel) && normalizedText.includes(normalizedModel)) {
        if (!matchedModel || normalizedModel.length > matchedModel.replace(/\s+/g, '').length) {
          matchedModel = model;
          warrantyMonths = data.months;
          productType = data.productType;
        }
      }
    }
  }

  // Step 2: Reverse match — extract tokens from text and check if any warranty model CONTAINS that token
  // This handles shorthand like "X2K-2" matching "APPCAMSOLOX2K-2"
  if (!matchedModel) {
    const tokens = upperText.match(/[A-Z0-9][A-Z0-9\-\+\/]{1,}/g) || [];
    const modelTokens = tokens.filter(t => /\d/.test(t) && t.length >= 3);

    let bestTokenLength = 0;
    for (const token of modelTokens) {
      for (const [model, data] of Object.entries(warrantyData)) {
        if (model.includes(token) && token.length > bestTokenLength) {
          bestTokenLength = token.length;
          matchedModel = model;
          warrantyMonths = data.months;
          productType = data.productType;
        }
      }
    }

    // If multiple models match the same token, pick the shortest (most specific) model
    if (matchedModel) {
      const bestToken = modelTokens.find(t => t.length === bestTokenLength);
      for (const [model, data] of Object.entries(warrantyData)) {
        if (model.includes(bestToken) && model.length < matchedModel.length) {
          matchedModel = model;
          warrantyMonths = data.months;
          productType = data.productType;
        }
      }
    }
  }

  return { matchedModel, warrantyMonths, productType };
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
      const rowModel = (row['Model Name'] || '').toUpperCase();
      if (rowModel.includes(token) && token.length > bestTokenLength) {
        bestModel = rowModel;
        bestTokenLength = token.length;
      }
    }
  }

  return bestModel;
}

function filterRelevantCases(data, product, matchedModel, text, maxCases = 15) {
  // Filter by product category
  let filtered = product
    ? data.filter(row => categorizeProduct(row['Model Name']) === product)
    : data;

  // Extract keywords from user text for relevance scoring
  const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const upperModel = matchedModel ? matchedModel.toUpperCase() : null;

  // Score each case: model match (high weight) + keyword matches
  const scored = filtered.map(row => {
    const rowModel = (row['Model Name'] || '').toUpperCase();
    const content = `${row['Customer Comment'] || ''} ${row['Technician Comment'] || ''}`.toLowerCase();

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
    `- Job: ${c['Job Number']} | Model: ${c['Model Name']} | Issue: ${c['Customer Comment']} | Resolution: ${c['Technician Comment']}`
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
    let { matchedModel, warrantyMonths, productType } = lookupWarranty(text, warrantyData);

    // Step 2: If model not found in warranty data, try historical repair data
    if (!matchedModel) {
      const historicalMatch = detectModelFromHistoricalData(text, historicalData);
      if (historicalMatch) {
        matchedModel = historicalMatch;
      }
    }

    // Step 3: Fill in the gaps — derive one from the other
    // If we matched a model, use CSV product type (mapped to readable label) — this is authoritative
    // and overrides keyword detection (e.g. avoid "Phone" from free text when model is a camera)
    if (matchedModel) {
      const mappedType = mapProductType(productType);
      if (mappedType) {
        detectedProduct = mappedType;
      } else {
        // Fall back to categorizing from model name keywords
        const modelCategory = categorizeProduct(matchedModel);
        if (modelCategory !== 'Unknown' && modelCategory !== 'Other') {
          detectedProduct = modelCategory;
        }
      }
    } else if (!detectedProduct) {
      // No model matched — use keyword detection result or CSV product type
      if (productType) {
        const mappedType = mapProductType(productType);
        if (mappedType) detectedProduct = mappedType;
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
    console.log('Warranty Months:', warrantyMonths);
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
- Matched Model: ${matchedModel || 'Not detected'}
- Warranty Period: ${warrantyMonths ? warrantyMonths + ' month(s)' : 'Unknown'}

IMPORTANT: Only use the Matched Model shown above in your response. If Matched Model is "Not detected", do NOT guess or invent a model name. Use generic terms like "your camera", "your unit", "your device" instead. Never assume or hallucinate a model name that the customer did not provide.

DATE DETECTION:
- Look for any date in the text (formats: DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY, or written dates)
- A date at the end of the text or near a product model is likely the PURCHASE DATE
- Use Australian date format: DD/MM/YYYY (day first, not month first)
- Today's date is: ${new Date().toLocaleDateString('en-AU')}

WARRANTY CALCULATION:
- Use Australian date format: DD/MM/YYYY. So "1/4/2024" means 1st April 2024, NOT 4th January 2024.
- Warranty period is given in MONTHS. Warranty expiry = purchase date + warranty months.
- Example: Purchase date 01/04/2024 + 12 months warranty = expires 01/04/2025
- Example: Purchase date 01/06/2024 + 24 months warranty = expires 01/06/2026
- Compare expiry date to today's date (${new Date().toLocaleDateString('en-AU')})
- If today's date is AFTER the expiry date → OUT OF WARRANTY
- If today's date is BEFORE the expiry date → UNDER WARRANTY
- DOUBLE CHECK your calculation. If the expiry date has passed, the warranty has EXPIRED.
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

PRIORITY DETECTION (check in this order):
1. **High priority** — Customer indicates they have ALREADY tried troubleshooting steps and the issue persists. Look for phrases like: "I have tried", "I have completed", "still not working", "issue remains", "already done", "followed your steps", "troubleshooting didn't help", "charged and recharged", "reset as instructed", "updated firmware but", "tried everything". If the customer describes specific actions they took (e.g., "fully charged", "reset the router", "formatted the SD card", "reinstalled") and the problem continues → this is High priority.
2. **Medium priority** — Customer provides BOTH a specific model number AND proof of purchase, but has NOT yet tried troubleshooting.
3. **Low priority** — Customer has NOT provided both a specific model number and proof of purchase.

**If model OR proof of purchase is MISSING → MUST be Low Priority (1st email):**
1. **Issue Category**: Specific issue type (e.g., Device Not Powering On, Pairing Issue, Screen Problem, Battery Issue, Connectivity Issue, Physical Damage, etc.)
2. **Priority**: Low
3. **Key Points**: Main concerns from customer. Do NOT repeat the model name or serial number here.
4. **Missing Information**: List exactly what is still needed (model number, proof of purchase, purchase date, etc.)
5. **Suggested Email Response**: Keep it SHORT and SIMPLE. The email should ONLY:
   - Acknowledge the customer's issue briefly
   - Ask for the missing information (model number and/or proof of purchase) using bullet points
   - Explain why we need it (to check warranty and provide accurate guidance)
   - Say we will investigate further once we have the details
   - Do NOT ask extra questions (e.g., "what cable are you using?", "how long has this been happening?", "any other symptoms?"). Do NOT suggest any troubleshooting steps. Just ask for model and proof of purchase only.
6. **Internal Notes**: Brief note for CS team

**If specific model number AND proof of purchase are both PROVIDED → Medium Priority (2nd email):**
1. **Issue Category**: Specific issue type (e.g., Device Not Powering On, Pairing Issue, Screen Problem, Battery Issue, Connectivity Issue, Physical Damage, etc.)
2. **Priority**: Medium
3. **Warranty Status**: Calculate from purchase date + warranty period. State whether unit is under warranty or out of warranty, and include the expiry date.
4. **Key Points**: Main concerns from customer. Do NOT repeat the model name or serial number here.
5. **Troubleshooting Steps**: IMPORTANT — Only reference historical cases and Job numbers if they are for the EXACT same model. If no exact model match exists, provide ONLY these basic generic steps and nothing else:
   - Try a different charging cable
   - Try a different power source
   - Perform a factory reset
   Do NOT invent or add ANY specific numbers, times, voltages, or technical details (e.g., do NOT write "charge for 4 hours", "use 5V/2A", "hold for 10 seconds") unless that exact detail appears in the historical cases for this exact model. If you are not sure, do not include it.
6. **Suggested Email Response**: Professional draft response. Format the email with proper paragraphs (use blank lines between paragraphs) and use numbered steps (1. 2. 3.) for troubleshooting instructions. Keep troubleshooting steps simple and generic if no exact model match exists in historical cases. The email must include:
   - Troubleshooting steps for the customer to try (as numbered steps)
   - If UNDER warranty: inform the customer that if troubleshooting does not resolve the issue, we can offer a repair or replacement under warranty
   - If OUT of warranty: inform the customer that if troubleshooting does not resolve the issue, a quotation will be provided for repair
7. **Internal Notes**: Brief note for CS team

**If customer has ALREADY tried troubleshooting and issue persists → High Priority (follow-up email):**
1. **Issue Category**: Specific issue type
2. **Priority**: High
3. **Warranty Status**: Calculate from purchase date + warranty period if available. State whether unit is under warranty or out of warranty.
4. **Key Points**: Main concerns from customer. Do NOT repeat the model name or serial number here., including what troubleshooting steps they have already completed
5. **Suggested Email Response**: IMPORTANT — Do NOT suggest more troubleshooting steps. The customer has already troubleshot. Write out the FULL email using the HIGH PRIORITY EMAIL TEMPLATE from the end of this prompt. Rules:
   - Copy the template WORD FOR WORD. Do NOT rewrite, rephrase, or skip any section.
   - ONLY replace: [Customer Name] → actual name, [describe the specific issue] → their issue, [Your Name] → keep as [Your Name]
   - You MUST include ALL of these sections in this exact order: Sending Your Unit, address, Please Include, Repair Charges, Repair Timeframe, Important Information
   - The Repair Charges section MUST always be included regardless of warranty status
   - The Important Information section must use the EXACT wording from the template (about user error, liquid damage, user-generated data)
   - Do NOT add extra sections, do NOT remove sections, do NOT change the wording of the template sections
6. **Internal Notes**: Brief note for CS team including what troubleshooting was already attempted

**IF TECHNICIAN ENQUIRY:**
1. **Issue Category**: Specific issue type (e.g., Broken Clip, Battery Swollen, Screen Damage, Firmware Crash, Connectivity Issue, Water Damage, etc.)
2. **Warranty Status**: Calculate warranty status as of TODAY (${new Date().toLocaleDateString('en-AU')}). Purchase date + warranty months = expiry date. If expiry date is BEFORE today → OUT OF WARRANTY. Show: purchase date, warranty period, expiry date, today's date, and whether UNDER or OUT of warranty. Do NOT calculate warranty "at time of report" — always use TODAY's date.
3. **Key Points**: Technical details from complaint. Do NOT repeat the model name or serial number here — they are already displayed separately in the UI.
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
If this is a Customer Service enquiry, ask yourself these three questions before writing anything:
Q1: "Has the customer already tried troubleshooting steps and reported the issue still persists?" — Look for phrases like "I have tried", "still not working", "followed your steps", "charged and recharged", etc.
If YES → Priority MUST be High. Use the High Priority format.
Q2: "Did the customer provide a SPECIFIC alphanumeric model code (e.g., BW3451R, IGOCAM85R, APPCAMSOLOX2K)?" — words like "camera", "phone", "monitor" do NOT count.
Q3: "Did the customer provide proof of purchase or a specific purchase date (e.g., 12/12/2024)?" — phrases like "I just bought it" or "it's new" do NOT count.
If Q1 is NO and BOTH Q2 and Q3 are YES → Priority is Medium.
If Q1 is NO and EITHER Q2 or Q3 is NO → Priority MUST be Low.

---

HIGH PRIORITY EMAIL TEMPLATE (use this ONLY inside the "Suggested Email Response" field for High priority):

Dear [Customer Name],

Thank you for completing the troubleshooting steps and for providing the detailed update. We truly appreciate your cooperation.

To accurately assess the [describe the specific issue] you described, our technician will need to inspect the unit in person. An in-person inspection is required to determine whether the unit qualifies for repair or replacement under warranty.

**Sending Your Unit for Inspection (Within Australia)**

Please send your unit to the address below:

**Uniden Australia Pty Ltd**
**PO BOX 755**
**MOOREBANK NSW 1875**

Please note: Uniden Australia is not liable for items lost in transit. We strongly recommend sending your parcel via Australia Post with tracking for security and peace of mind.

**Please Include the Following:**
- Your full name
- Return address
- Contact phone number
- Email address
- If available, please include a copy of your proof of purchase

If a receipt is not available, we are still happy to inspect your unit and provide a repair quotation. You may also complete and attach the Repair and Service Form (if applicable).

💲 **Repair Charges (Out-of-Warranty Units)**
- Inspection & Quotation: From $88 (includes return freight within Australia; excludes overseas shipments)
- Rejected Quote: $45 basic service charge (if the unit is requested to be returned without proceeding with repair)

⏱ **Repair Timeframe**

Repairs are typically completed within 5–10 working days from the date of receipt.
To check the status of your repair, please contact us at:
📞 **1300 366 895**
Monday – Friday, 9:00 AM – 5:00 PM (Sydney time)

⚠️ **Important Information**
- Damage caused by user error (including liquid damage, lightning damage, or improper use) is not covered under warranty.
- Repairs may result in the loss of user-generated data (e.g., phonebooks, frequency channels, SD card contents). We strongly recommend backing up any important data before sending your unit.

Thank you for your understanding and cooperation.
We look forward to assisting you further.

Kind regards,
[Your Name]
Uniden Customer Service`;

    const response = await bedrockClient.send(
      new InvokeModelCommand({
        modelId: process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: 2000,
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
        warrantyMonths,
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
