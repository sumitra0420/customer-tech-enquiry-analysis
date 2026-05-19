const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { Pool } = require('pg');

const bedrockClient = new BedrockRuntimeClient({
  region: 'ap-southeast-2',
  maxAttempts: 5,        // retry up to 5 times
  retryMode: 'adaptive', // slows down automatically when throttled
});

// ─── Database connection ───────────────────────────────────────────────────────
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'enquiries',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Content-Type': 'application/json',
};

// ─── Product helpers (unchanged) ──────────────────────────────────────────────
function categorizeProduct(typeValue) {
  const t = String(typeValue).toUpperCase().trim();
  if (t.startsWith('BW')) return 'Baby Monitor';
  if (t.includes('DASH') || t.includes('IGO')) return 'Dash Cam';
  if (['DECT', 'SSE', 'FP', 'ELITE'].some(s => t.includes(s))) return 'Phone';
  if (['SOLO', 'APPCAM', 'APP CAM'].some(s => t.includes(s))) return 'Security Camera';
  if (['DVR', 'NVR', 'CVR', 'XVR', 'G37'].some(s => t.includes(s))) return 'Recorder';
  if (['XTRAK', 'UH', 'MHS', 'X86', 'X76', 'ADV25'].some(s => t.includes(s))) return 'Radio';
  if (t.includes('UPP')) return 'Power Supply';
  if (t.includes('SPS')) return 'Solar Panel';
  if (['CLEAN', 'SERVICE', 'TEST', 'NETWORK'].some(s => t.includes(s))) return 'Service/Maintenance';
  if (/^\d+$/.test(t)) return 'Unknown';
  return 'Other';
}

function normalizeProductType(csvProductType) {
  const type = String(csvProductType || '').toUpperCase().trim();
  if (type === 'BABY MONITORS') return 'Baby Monitor';
  if (['CORDLESS PHONE', 'CORDLESS PHONE - EXTRA HANDSET', 'CORDED'].includes(type)) return 'Phone';
  if (type === 'DASHCAM') return 'Dash Cam';
  if (['VS- WIRELESS', 'VS- WIRED'].includes(type)) return 'Security Camera';
  if (['UCB - HANDHELD RADIOS', 'UCB - MOBILE RADIOS'].includes(type)) return 'Radio';
  if (type === 'MARINE RADIO') return 'Marine Radio';
  if (type === 'JUMP STARTER') return 'Jump Starter';
  if (type === 'RADAR DETECTOR DASH') return 'Radar Detector';
  if (type === 'SCANNER') return 'Scanner';
  if (type === 'NAVI') return 'Navigation';
  if (type.startsWith('ACCESSORIES') || type.startsWith('ANTENNAS')) return 'Accessories';
  if (type === 'SPARE PARTS') return null;
  return null;
}

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

function detectProduct(text) {
  const lower = text.toLowerCase();
  for (const [product, keywords] of Object.entries(PRODUCT_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) return product;
  }
  return null;
}

// ─── Product index cache (persists across warm invocations) ───────────────────
let cachedProductIndex = null;

async function loadProductIndex() {
  if (cachedProductIndex) return cachedProductIndex;

  const { rows } = await pool.query(
    'SELECT model, product_name, warranty_month, product_type FROM products WHERE warranty_month > 0'
  );

  cachedProductIndex = {};
  for (const row of rows) {
    const model = (row.model || '').toUpperCase().trim();
    if (model && row.warranty_month) {
      cachedProductIndex[model] = { months: row.warranty_month, productType: row.product_type };
    }
  }

  console.log(`Product index loaded: ${Object.keys(cachedProductIndex).length} entries`);
  return cachedProductIndex;
}

// ─── Model lookup (unchanged 3-step logic) ────────────────────────────────────
function lookupWarranty(text, warrantyData) {
  const upper = text.toUpperCase();
  let matchedModel = null, warrantyMonths = null, productType = null;

  // Step 1: Direct match
  for (const [model, data] of Object.entries(warrantyData)) {
    if (upper.includes(model) && (!matchedModel || model.length > matchedModel.length)) {
      matchedModel = model; warrantyMonths = data.months; productType = data.productType;
    }
  }

  // Step 1.5: Normalized match (strips spaces)
  if (!matchedModel) {
    const norm = upper.replace(/\s+/g, '');
    for (const [model, data] of Object.entries(warrantyData)) {
      const normModel = model.replace(/\s+/g, '');
      if (normModel.length >= 4 && /\d/.test(normModel) && norm.includes(normModel)) {
        if (!matchedModel || normModel.length > matchedModel.replace(/\s+/g, '').length) {
          matchedModel = model; warrantyMonths = data.months; productType = data.productType;
        }
      }
    }
  }

  // Step 2: Reverse token match
  if (!matchedModel) {
    const tokens = (upper.match(/[A-Z0-9][A-Z0-9\-\+\/]{1,}/g) || []).filter(t => /\d/.test(t) && t.length >= 3);
    let bestLen = 0;
    for (const token of tokens) {
      for (const [model, data] of Object.entries(warrantyData)) {
        if (model.includes(token) && token.length > bestLen) {
          bestLen = token.length; matchedModel = model; warrantyMonths = data.months; productType = data.productType;
        }
      }
    }
    if (matchedModel) {
      const best = tokens.find(t => t.length === bestLen);
      for (const [model, data] of Object.entries(warrantyData)) {
        if (model.includes(best) && model.length < matchedModel.length) {
          matchedModel = model; warrantyMonths = data.months; productType = data.productType;
        }
      }
    }
  }

  return { matchedModel, warrantyMonths, productType };
}

// ─── Intent detection ─────────────────────────────────────────────────────────
function extractScNumber(text) {
  const match = text.match(/\bSC\d+\b/i);
  return match ? match[0].toUpperCase() : null;
}

async function detectIntent(text) {
  // SC number: reliable regex — short-circuit before Bedrock
  const scNumber = extractScNumber(text);
  if (scNumber) {
    const lower = text.toLowerCase();
    if (/\b(where|find|status|track|locate|look up|what happened|what is|tell me|show me|info|information|details|check|repair job|job number|about)\b/.test(lower)) {
      return { intent: 'JOB_LOOKUP', aiCategory: null };
    }
    return { intent: 'TECHNICIAN', aiCategory: null };
  }

  // Email address — reliable regex, short-circuit before Bedrock
  const emailMatch = text.match(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/);
  const extractedEmail = emailMatch ? emailMatch[0].toLowerCase() : null;
  if (extractedEmail) {
    return {
      intent: 'UNIT_TRACKING',
      aiCategory: null,
      unitTrackingTerms: {
        customerName: null,
        trackingNumber: null,
        reference: null,
        email: extractedEmail,
      },
    };
  }

  // RA number or long tracking number — reliable regex, short-circuit before Bedrock
  const raMatch = text.match(/\bRA\d+\b/i);
  const trackingMatch = text.match(/\b\d{8,}\b/);
  if (raMatch || trackingMatch) {
    return {
      intent: 'UNIT_TRACKING',
      aiCategory: null,
      unitTrackingTerms: {
        customerName: null,
        trackingNumber: trackingMatch ? trackingMatch[0] : null,
        reference: raMatch ? raMatch[0].toUpperCase() : null,
        email: null,
      },
    };
  }

  // Use AI to classify intent, extract product category, and extract unit tracking terms — all in one call
  const prompt = `You are a classifier for a Uniden Australia internal support tool.

Classify the enquiry into ONE intent, and extract additional data based on intent.

INTENTS:
- FAULT_LOOKUP: asking about common faults, issues, problems, or repair counts for a product model or fault type (e.g. battery issues, charging problems, screen failure)
- KNOWLEDGE_LOOKUP: asking how to use, reset, set up, pair, or troubleshoot a product
- POLICY_LOOKUP: asking about company policy, warranty rules, repair fees, return process, RA process
- PRODUCT_LOOKUP: asking about product availability, discontinued status, or what models exist in a category
- UNIT_TRACKING: asking where a parcel or unit is, whether it has been received at the warehouse, tracking a delivery, or checking if a customer's unit has been booked into the repair system
- CUSTOMER_SERVICE: a customer complaint or request that needs a drafted email response

PRODUCT CATEGORIES (only for PRODUCT_LOOKUP): CORDED, CORDLESS PHONE, DASHCAM, BABY MONITORS, VS- WIRELESS, VS- WIRED, UCB - HANDHELD RADIOS, UCB - MOBILE RADIOS, MARINE RADIO, SCANNER, NAVI, JUMP STARTER, ACCESSORIES, UNKNOWN

ENQUIRY: "${text.substring(0, 300)}"

Reply in this exact format (one line):
INTENT|CATEGORY|NAME|TRACKING|REFERENCE|FAULT_KEYWORD

- CATEGORY: product category for PRODUCT_LOOKUP, else NONE
- NAME: customer or sender name for UNIT_TRACKING, else NONE
- TRACKING: tracking number for UNIT_TRACKING, else NONE
- REFERENCE: RA or repair reference number for UNIT_TRACKING, else NONE
- FAULT_KEYWORD: for FAULT_LOOKUP, a short keyword to search repair records (e.g. battery, charging, screen, antenna, power), else NONE

Examples:
PRODUCT_LOOKUP|CORDED|NONE|NONE|NONE|NONE
FAULT_LOOKUP|NONE|NONE|NONE|NONE|battery
FAULT_LOOKUP|NONE|NONE|NONE|NONE|charging
UNIT_TRACKING|NONE|BENJAMIN ROSE|NONE|NONE|NONE
UNIT_TRACKING|NONE|NONE|NONE|RA0010590|NONE`;

  const result = await callBedrock(prompt, 60);
  const parts = result.trim().split('|');
  const intentRaw   = parts[0]?.replace(/[^A-Z_]/gi, '').toUpperCase() || 'CUSTOMER_SERVICE';
  const categoryRaw = parts[1]?.replace(/[^A-Z0-9\- ]/gi, '').trim().toUpperCase() || null;
  const nameRaw     = parts[2]?.trim().toUpperCase() || null;
  const trackingRaw = parts[3]?.trim().toUpperCase() || null;
  const refRaw      = parts[4]?.trim().toUpperCase() || null;
  const faultRaw    = parts[5]?.trim().toLowerCase() || null;

  const valid = ['FAULT_LOOKUP', 'KNOWLEDGE_LOOKUP', 'POLICY_LOOKUP', 'PRODUCT_LOOKUP', 'UNIT_TRACKING', 'CUSTOMER_SERVICE'];
  const intent = valid.includes(intentRaw) ? intentRaw : 'CUSTOMER_SERVICE';

  return {
    intent,
    aiCategory: categoryRaw && categoryRaw !== 'NONE' ? categoryRaw : null,
    faultKeyword: intent === 'FAULT_LOOKUP' && faultRaw && faultRaw !== 'none' ? faultRaw : null,
    unitTrackingTerms: intent === 'UNIT_TRACKING' ? {
      customerName:  nameRaw     && nameRaw     !== 'NONE' ? nameRaw     : null,
      trackingNumber: trackingRaw && trackingRaw !== 'NONE' ? trackingRaw : null,
      reference:     refRaw      && refRaw      !== 'NONE' ? refRaw      : null,
      email: null,
    } : null,
  };
}

// ─── Database query functions ──────────────────────────────────────────────────
async function queryRepairJobsByModel(model, limit = 50) {
  if (!model) return [];
  const { rows } = await pool.query(
    `SELECT job_number, product_model, customer_comment, technician_comment, job_action, date_opened
     FROM repair_jobs WHERE product_model = $1 ORDER BY date_opened DESC LIMIT $2`,
    [model.toUpperCase(), limit]
  );
  return rows;
}

async function queryRepairJobsByKeyword(keyword, limit = 200) {
  if (!keyword) return [];
  const pattern = `%${keyword}%`;
  const { rows } = await pool.query(
    `SELECT job_number, product_model, customer_comment, technician_comment, job_action, date_opened
     FROM repair_jobs
     WHERE customer_comment ILIKE $1 OR technician_comment ILIKE $1
     ORDER BY date_opened DESC LIMIT $2`,
    [pattern, limit]
  );
  return rows;
}

async function queryRepairJobsNewest(model, limit = 5) {
  if (!model) return [];
  const { rows } = await pool.query(
    `SELECT job_number, product_model, customer_comment, technician_comment, job_action, date_opened
     FROM repair_jobs WHERE product_model = $1 ORDER BY date_opened DESC LIMIT $2`,
    [model.toUpperCase(), limit]
  );
  return rows;
}

async function queryJobByNumber(scNumber) {
  const { rows } = await pool.query(
    `SELECT * FROM repair_jobs WHERE UPPER(job_number) = $1`,
    [scNumber.toUpperCase()]
  );
  return rows.length > 0 ? rows[0] : null;
}

function normalise(text) {
  return text ? text.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
}

async function resolveCustomerId(name) {
  const normName = normalise(name);
  const { rows } = await pool.query(
    `SELECT customer_id FROM customers
     WHERE similarity(customer_name_norm, $1) > 0.30
        OR word_similarity($1, customer_name_norm) > 0.50
     ORDER BY GREATEST(similarity(customer_name_norm, $1), word_similarity($1, customer_name_norm)) DESC
     LIMIT 1`,
    [normName]
  );
  return rows.length > 0 ? rows[0].customer_id : null;
}

async function queryConnoteByName(name) {
  const customerId = await resolveCustomerId(name);
  const { rows } = await pool.query(
    `SELECT * FROM daily_connote
     WHERE similarity(sender, $1) > 0.30
        OR word_similarity($1, sender) > 0.50
        OR ($2::int IS NOT NULL AND customer_id = $2)
     ORDER BY GREATEST(similarity(sender, $1), word_similarity($1, sender)) DESC,
              date_received DESC
     LIMIT 10`,
    [name, customerId]
  );
  return rows;
}

async function queryConnoteByTracking(tracking) {
  const { rows } = await pool.query(
    `SELECT * FROM daily_connote WHERE tracking ILIKE $1 ORDER BY date_received DESC LIMIT 5`,
    [`%${tracking}%`]
  );
  return rows;
}

async function queryConnoteByReference(reference) {
  const { rows } = await pool.query(
    `SELECT * FROM daily_connote WHERE reference ILIKE $1 ORDER BY date_received DESC LIMIT 5`,
    [`%${reference}%`]
  );
  return rows;
}

async function queryRepairJobsByReference(reference) {
  const { rows } = await pool.query(
    `SELECT job_number, product_model, customer_name, date_opened, job_action, customer_comment, technician_comment, reference
     FROM repair_jobs WHERE reference ILIKE $1 ORDER BY date_opened DESC LIMIT 10`,
    [`%${reference}%`]
  );
  return rows;
}

async function queryRepairJobsByName(name) {
  const customerId = await resolveCustomerId(name);
  const { rows } = await pool.query(
    `SELECT job_number, product_model, customer_name, date_opened, job_action, customer_comment, technician_comment
     FROM repair_jobs
     WHERE similarity(customer_name, $1) > 0.30
        OR word_similarity($1, customer_name) > 0.50
        OR ($2::int IS NOT NULL AND customer_id = $2)
     ORDER BY GREATEST(similarity(customer_name, $1), word_similarity($1, customer_name)) DESC,
              date_opened DESC
     LIMIT 10`,
    [name, customerId]
  );
  return rows;
}

async function queryJobsByCustomerName(customerName, excludeJobNumber) {
  const { rows } = await pool.query(
    `SELECT job_number, product_model, date_opened, job_action, customer_comment, technician_comment
     FROM repair_jobs
     WHERE LOWER(customer_name) = LOWER($1) AND UPPER(job_number) != $2
     ORDER BY date_opened DESC LIMIT 10`,
    [customerName, excludeJobNumber.toUpperCase()]
  );
  return rows;
}

async function queryKnowledgeBase(model) {
  if (!model) return [];
  const upper = model.toUpperCase();
  // Match exact OR partial — covers XTRAK80 ↔ XTRAK80SERIES, XTRAK80OFFROAD, etc.
  const { rows } = await pool.query(
    `SELECT question, answer, entry_type FROM knowledge_base
     WHERE product_model = $1
        OR product_model ILIKE $2
        OR $1 ILIKE '%' || product_model || '%'
     ORDER BY id ASC`,
    [upper, '%' + upper + '%']
  );
  return rows;
}

async function queryAllPolicies() {
  const { rows } = await pool.query('SELECT * FROM policies ORDER BY policy_id');
  return rows;
}

async function queryHighPriorityTemplate() {
  const { rows } = await pool.query(
    `SELECT details FROM policies WHERE policy_id = 'POL-036' LIMIT 1`
  );
  return rows.length > 0 ? rows[0].details : null;
}

async function detectModelFromDB(text) {
  const upper = text.toUpperCase();
  const tokens = (upper.match(/[A-Z0-9][A-Z0-9\-\+\/]{2,}/g) || []).filter(t => /\d/.test(t));
  if (tokens.length === 0) return null;
  const conditions = tokens.map((_, i) => `model LIKE $${i + 1}`).join(' OR ');
  const { rows } = await pool.query(
    `SELECT model FROM products WHERE ${conditions} ORDER BY length(model) ASC LIMIT 1`,
    tokens.map(t => `%${t}%`)
  );
  return rows.length > 0 ? rows[0].model : null;
}

// ─── Shared Bedrock call (with retry on throttling) ───────────────────────────
async function callBedrock(prompt, maxTokens = 2000) {
  try {
    const response = await bedrockClient.send(new InvokeModelCommand({
      modelId: process.env.BEDROCK_MODEL_ID || 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    }));
    const body = JSON.parse(new TextDecoder().decode(response.body));
    const text = body.content[0].text;
    console.log('MODEL:', process.env.BEDROCK_MODEL_ID || 'global.anthropic.claude-haiku-4-5-20251001-v1:0');
    console.log('AI RESPONSE:', text);
    return text;
  } catch (err) {
    throw err;
  }
}

// AI fallback for model extraction when rule-based fails
async function extractModelWithAI(text) {
  try {
    const analysis = await callBedrock(
      `Extract the Uniden product model code from this text.
Return ONLY the model code in uppercase with no spaces (e.g. XTRAK80OFFROAD, IGOPLAY10, APPCAMX24B).
If no Uniden product model can be identified, return "NONE".
Text: "${text}"`,
      50
    );
    const extracted = analysis.trim().toUpperCase().replace(/\s+/g, '');
    return extracted === 'NONE' ? null : extracted;
  } catch (e) {
    console.log('AI model extraction failed:', e.message);
    return null;
  }
}

// ─── Intent handlers ──────────────────────────────────────────────────────────

// 1. TECHNICIAN: SC number + fault description
// Shows warranty period, generates diagnosis, references 5 newest similar repair jobs
async function handleTechnician(text, matchedModel, warrantyMonths, productType, detectedProduct) {
  const [newestJobs, knowledgeEntries] = await Promise.all([
    queryRepairJobsNewest(matchedModel, 5),
    queryKnowledgeBase(matchedModel),
  ]);

  const jobsContext = newestJobs.length > 0
    ? newestJobs.map(j =>
        `- Job ${j.job_number} (${j.date_opened ? new Date(j.date_opened).toLocaleDateString('en-AU') : 'N/A'}) | Action: ${j.job_action}\n  Customer: ${j.customer_comment}\n  Tech: ${j.technician_comment}`
      ).join('\n')
    : 'No previous repair jobs found for this model.';

  const knowledgeContext = knowledgeEntries.length > 0
    ? knowledgeEntries.map(e => `[${e.entry_type}] Q: ${e.question}\nA: ${e.answer}`).join('\n\n')
    : 'No knowledge base entries for this model.';

  const prompt = `You are a technical assistant for Uniden repair technicians. Analyse this repair case.

PRODUCT INFORMATION:
- Model: ${matchedModel || 'Not detected'}
- Product Category: ${detectedProduct || productType || 'Unknown'}
- Warranty Period: ${warrantyMonths ? warrantyMonths + ' months' : 'Unknown'} (do NOT calculate expiry — just show the period)

PRODUCT KNOWLEDGE BASE:
${knowledgeContext}

5 MOST RECENT REPAIR JOBS FOR THIS MODEL:
${jobsContext}

TECHNICIAN'S CASE NOTE:
${text}

Provide a technical analysis in this format:

1. **Issue Category**: Specific fault type (e.g., Screen Flickering, Power Issue, Battery Swollen)
2. **Technical Diagnosis**: Likely root cause based on the case note and historical jobs
3. **Suggested Repair Action**: Step-by-step repair actions. Reference relevant historical job numbers (e.g., "Similar to Job SC1234 where...") when applicable
4. **Parts Likely Needed**: List components that may need replacement
5. **Suggested Technical Report Summary**: Write in PAST TENSE — this is sent to the customer with their repaired unit. Example: "Unit was inspected. Screen connector was reseated and tested. Display confirmed working."

Use markdown formatting. Be specific and reference historical cases where relevant.`;

  const analysis = await callBedrock(prompt);
  return {
    intent: 'TECHNICIAN',
    analysis,
    matchedModel,
    warrantyMonths,
    detectedProduct: detectedProduct || productType,
    matchedCases: newestJobs.length,
  };
}

// 2. KNOWLEDGE_LOOKUP: "How do I reset the XTRAK80?"
// Uses knowledge_base as primary source, AI improves and fills gaps
async function handleKnowledgeLookup(text, matchedModel, warrantyMonths, productType, detectedProduct) {
  const [knowledgeEntries, repairJobs] = await Promise.all([
    queryKnowledgeBase(matchedModel),
    queryRepairJobsByModel(matchedModel, 10),
  ]);

  const knowledgeContext = knowledgeEntries.length > 0
    ? knowledgeEntries.map(e => `[${e.entry_type.toUpperCase()}]\nQ: ${e.question}\nA: ${e.answer}`).join('\n\n')
    : 'No specific knowledge base entries found for this model.';

  const repairContext = repairJobs.length > 0
    ? repairJobs.map(j => `- Job ${j.job_number}: ${j.customer_comment} → ${j.technician_comment}`).join('\n')
    : 'No repair history found.';

  const prompt = `You are a knowledgeable Uniden product support assistant. Answer the question below.

PRODUCT INFORMATION:
- Model: ${matchedModel || 'Not specified'}
- Product Category: ${detectedProduct || 'Unknown'}
- Warranty Period: ${warrantyMonths ? warrantyMonths + ' months' : 'Unknown'}

KNOWLEDGE BASE (official Q&A for this product):
${knowledgeContext}

RELATED REPAIR HISTORY:
${repairContext}

QUESTION: ${text}

Instructions:
- Use the knowledge base as your PRIMARY source of truth
- If the knowledge base has a direct answer, present it clearly and improve the formatting
- If the knowledge base doesn't fully answer the question, supplement with general Uniden product knowledge
- If referencing repair jobs, mention the job number (e.g., "Based on Job SC1234...")
- Format your response with clear headings and steps where applicable
- Include the warranty period information in your response`;

  const analysis = await callBedrock(prompt);
  return {
    intent: 'KNOWLEDGE_LOOKUP',
    analysis,
    matchedModel,
    warrantyMonths,
    detectedProduct,
    matchedCases: repairJobs.length,
  };
}

// 3. POLICY_LOOKUP: policy, warranty, charges, procedures
// Queries all policies, AI formats the relevant answer
async function handlePolicyLookup(text, matchedModel, warrantyMonths, detectedProduct) {
  const policies = await queryAllPolicies();

  const policiesContext = policies.map(p =>
    `[${p.policy_id}] ${p.category} — ${p.procedure_title}\n${p.details}` +
    (p.applicable_fees ? `\nFee: ${p.applicable_fees}` : '') +
    (p.timeframe ? ` | Timeframe: ${p.timeframe}` : '') +
    (p.contact_info ? `\nContact: ${p.contact_info}` : '')
  ).join('\n\n');

  const prompt = `You are a customer service assistant for Uniden Australia. Answer the question using the company policies below.

COMPANY POLICIES:
${policiesContext}

${matchedModel ? `SPECIFIC PRODUCT INFO:\n- Model: ${matchedModel}\n- Warranty Period: ${warrantyMonths ? warrantyMonths + ' months' : 'Unknown'}\n` : ''}

QUESTION: ${text}

Instructions:
- Answer ONLY using the policies provided above
- Only include policies directly relevant to the question
- Format your response clearly with headings and bullet points where appropriate
- If asking about warranty for a specific product, include the warranty period
- If fees or timeframes apply, clearly state them
- Be concise and professional`;

  const analysis = await callBedrock(prompt);
  return {
    intent: 'POLICY_LOOKUP',
    analysis,
    matchedModel,
    warrantyMonths,
    detectedProduct,
  };
}

// 4. JOB_LOOKUP: "Where is repair job SC2500?"
// Fetches the repair job record and formats it clearly
async function handleJobLookup(text, scNumber) {
  const [job, warrantyData] = await Promise.all([
    queryJobByNumber(scNumber),
    loadProductIndex(),
  ]);

  // Look up warranty and product type from the product index using the job's model
  const jobModel = job?.product_model?.toUpperCase() || null;
  const productEntry = jobModel ? warrantyData[jobModel] : null;
  const warrantyMonths = productEntry?.months || null;
  const productType = productEntry?.productType || null;
  const detectedProduct = productType ? (normalizeProductType(productType) || categorizeProduct(jobModel)) : (jobModel ? categorizeProduct(jobModel) : null);

  // Fetch this customer's other repair history
  const otherJobs = job?.customer_name
    ? await queryJobsByCustomerName(job.customer_name, scNumber)
    : [];

  const jobContext = job
    ? `Job Number: ${job.job_number}
Model: ${job.product_model}
Customer: ${job.customer_name}
Date Opened: ${job.date_opened ? new Date(job.date_opened).toLocaleDateString('en-AU') : 'N/A'}
Date Closed: ${job.date_closed ? new Date(job.date_closed).toLocaleDateString('en-AU') : 'N/A'}
Status: ${job.status || 'N/A'}
Stage: ${job.stage || 'N/A'}
Job Action: ${job.job_action}
Customer Reported: ${job.customer_comment}
Technician Comment: ${job.technician_comment || 'Not yet updated'}
Original Serial Number: ${job.serial_number || 'N/A'}
Replacement Serial Number: ${job.replacement_serial_number || 'N/A'}`
    : `No repair job found with number ${scNumber}.`;

  const historyContext = otherJobs.length > 0
    ? `\n\nCUSTOMER'S OTHER REPAIR HISTORY (${otherJobs.length} previous jobs):\n` +
      otherJobs.map(j =>
        `- ${j.job_number} | ${j.product_model} | ${j.date_opened ? new Date(j.date_opened).toLocaleDateString('en-AU') : 'N/A'} | ${j.job_action || 'N/A'} | ${j.customer_comment || ''}`
      ).join('\n')
    : '\n\nNo other repair jobs found for this customer.';

  const prompt = `You are a repair tracking assistant for Uniden Australia.

REPAIR JOB RECORD:
${jobContext}
${historyContext}

QUESTION: ${text}

Present the repair job information in a clear, organized format. Include all available details.
Always format dates as DD Month YYYY (e.g. 05 April 2026) — never use MM/DD/YYYY or ambiguous numeric formats.

After the job details, include a "**Current Status Interpretation**" section using the following logic — always use tentative language (might, could, likely) since you cannot confirm the exact stage:
- If Job Action is "Refund" AND the job is not closed → say something like: "This job is flagged for a refund. A technician assessment may not be required — the job is likely being processed for refund and could be waiting for management approval or finalisation."
- If the technician comment mentions "replace" or "replacement" AND Replacement Serial Number is N/A AND the job is not closed → say something like: "The technician has confirmed the fault and indicated a replacement is needed. The job is likely waiting for the warehouse to issue a new unit."
- If the technician comment mentions "replace" or "replacement" AND Replacement Serial Number is filled in AND the job is not closed → say something like: "A replacement unit has likely been assigned. The job might be awaiting dispatch from the warehouse."
- If the job is closed → say something like: "This job appears to have been completed and closed."
- Otherwise → briefly summarise the job status and stage as-is without guessing.

Then include a section "**Customer Repair History**" summarising any previous jobs for this customer (models repaired, dates, outcomes).
If the job was not found, say so clearly and suggest checking the job number.
Use markdown formatting with bold labels for each field.`;

  const analysis = await callBedrock(prompt, 500);
  return {
    intent: 'JOB_LOOKUP',
    analysis,
    matchedModel: jobModel,
    warrantyMonths,
    detectedProduct,
    jobNumber: scNumber,
  };
}

// 5. FAULT_LOOKUP: "What faults does the iGOCAM55 commonly have?"
// Combines knowledge_base + repair_jobs to identify patterns
async function handleFaultLookup(text, matchedModel, warrantyMonths, detectedProduct, faultKeyword) {
  // If a specific model is matched, search by model; otherwise search by fault keyword across all jobs
  const keywordSearch = !matchedModel && faultKeyword;

  const [knowledgeEntries, repairJobs] = await Promise.all([
    queryKnowledgeBase(matchedModel),
    keywordSearch
      ? queryRepairJobsByKeyword(faultKeyword, 200)
      : queryRepairJobsByModel(matchedModel, 50),
  ]);

  const knowledgeContext = knowledgeEntries.length > 0
    ? knowledgeEntries.map(e => `[${e.entry_type}] Q: ${e.question}\nA: ${e.answer}`).join('\n\n')
    : 'No knowledge base entries.';

  const repairContext = repairJobs.length > 0
    ? repairJobs.map(j =>
        `Job ${j.job_number} | Model: ${j.product_model} | Customer: "${j.customer_comment}" | Tech: "${j.technician_comment}"`
      ).join('\n')
    : 'No matching repair jobs found.';

  const scopeDesc = keywordSearch
    ? `FAULT KEYWORD SEARCH: "${faultKeyword}" — searching across ALL models`
    : `MODEL: ${matchedModel || 'Not specified'}`;

  const prompt = `You are a technical analyst for Uniden Australia. Answer based ONLY on the repair data provided below — do not use general knowledge.

${scopeDesc}
${matchedModel ? `PRODUCT CATEGORY: ${detectedProduct || 'Unknown'}` : ''}
${matchedModel && warrantyMonths ? `WARRANTY PERIOD: ${warrantyMonths} months` : ''}

KNOWLEDGE BASE:
${knowledgeContext}

REPAIR JOB DATA (${repairJobs.length} jobs found):
${repairContext}

QUESTION: ${text}

Your response MUST include:
1. **Total Count**: Exact number of repair jobs found matching this fault
2. **Job Number List**: List every SC job number (e.g. SC12345) found — do not omit any
3. **Breakdown by Model**: Group job counts by product model
4. **Common Patterns**: What customers reported and what technicians found
${!matchedModel ? '' : '5. **Recommendations**: What to check first when this product comes in'}

Use markdown formatting. Base your answer strictly on the data above.`;

  const analysis = await callBedrock(prompt);
  return {
    intent: 'FAULT_LOOKUP',
    analysis,
    matchedModel,
    warrantyMonths,
    detectedProduct,
    matchedCases: repairJobs.length,
  };
}

// 6. PRODUCT_LOOKUP: "Is the iGOCAM55 discontinued?" / "What corded phone models are available?"
async function handleProductLookup(text, matchedModel, warrantyMonths, detectedProduct, aiCategory = null) {
  let productContext, repairContext, knowledgeContext;

  if (matchedModel) {
    // ── Single model query ──────────────────────────────────────────────────
    const [productRes, repairJobs, knowledgeEntries] = await Promise.all([
      pool.query(`SELECT status FROM products WHERE UPPER(model) = $1 LIMIT 1`, [matchedModel.toUpperCase()]),
      queryRepairJobsByModel(matchedModel, 30),
      queryKnowledgeBase(matchedModel),
    ]);

    const status = productRes.rows.length > 0 ? (productRes.rows[0].status || 'Active') : 'Unknown';

    productContext = `Model: ${matchedModel}\nCategory: ${detectedProduct || 'Unknown'}\nWarranty: ${warrantyMonths ? warrantyMonths + ' months' : 'Unknown'}\nStatus: ${status}`;

    repairContext = repairJobs.length > 0
      ? repairJobs.map(j => `- ${j.job_number}: "${j.customer_comment}" → Tech: "${j.technician_comment}"`).join('\n')
      : 'No repair history found.';

    knowledgeContext = knowledgeEntries.length > 0
      ? knowledgeEntries.map(e => `[${e.entry_type}] Q: ${e.question}\nA: ${e.answer}`).join('\n\n')
      : 'No knowledge base entries found.';

  } else {
    // ── Category / catalogue query ──────────────────────────────────────────
    // Approach 1: use detectedProduct (fast, no AI cost)
    const productTypeMap = {
      'Baby Monitor':      'BABY MONITOR',
      'Dash Cam':          'DASHCAM',
      // 'Phone' intentionally excluded — too broad (covers both CORDED and CORDLESS PHONE)
      // Let AI extraction (Approach 2) handle phone-type queries specifically
      'Security Camera':   'VS-',
      'Recorder':          'DVR',
      'Radio':             'UCB',
      'Power Supply':      'UPP',
      'Solar Panel':       'SPS',
    };
    const mappedType = detectedProduct ? productTypeMap[detectedProduct] : null;

    let catalogue = [];
    let categoryUsed = null;

    if (mappedType) {
      const res1 = await pool.query(
        `SELECT model, product_name, description, warranty_month, status
         FROM products
         WHERE product_type ILIKE $1
         AND warranty_month > 0
         ORDER BY status ASC, model ASC LIMIT 30`,
        [`%${mappedType}%`]
      );
      catalogue = res1.rows;
      categoryUsed = `detectedProduct mapping → "${mappedType}"`;
      console.log(`Catalogue Approach 1 (${categoryUsed}): ${catalogue.length} results`);
    }

    // Approach 2: use aiCategory already extracted during intent detection (no extra Bedrock call)
    if (catalogue.length === 0 && aiCategory && aiCategory !== 'UNKNOWN') {
      categoryUsed = `AI category → "${aiCategory}"`;
      console.log(`Catalogue Approach 2 (${categoryUsed}): querying...`);
      const res2 = await pool.query(
        `SELECT model, product_name, description, warranty_month, status
         FROM products
         WHERE product_type ILIKE $1
         AND warranty_month > 0
         ORDER BY status ASC, model ASC LIMIT 30`,
        [`%${aiCategory}%`]
      );
      catalogue = res2.rows;
      console.log(`Catalogue Approach 2 results: ${catalogue.length}`);
    }

    productContext = catalogue.length > 0
      ? catalogue.map(p =>
          `- ${p.model}: ${p.product_name || p.description || ''} | Warranty: ${p.warranty_month}m | Status: ${p.status || 'Active'}`
        ).join('\n')
      : 'No matching products found in database.';

    repairContext = null;
    knowledgeContext = null;
  }

  const prompt = matchedModel
    ? `You are a Uniden internal product specialist. Use ONLY the data below — do not add information from your own knowledge.

PRODUCT INFORMATION:
${productContext}

REPAIR HISTORY:
${repairContext}

KNOWLEDGE BASE:
${knowledgeContext}

QUESTION: ${text}

Respond with:
1. **Status** — confirmed from the data above
2. **Common Faults** — from repair history only, reference job numbers
3. **Knowledge Base** — from the entries above only
4. **Staff Notes** — practical handling notes

Do not invent model names, fault types, or policies not in the data above. No customer email. Use markdown.`

    : `You are a Uniden internal product specialist. Use ONLY the product list below — do not add any models from your own knowledge.

PRODUCTS FROM DATABASE:
${productContext}

QUESTION: ${text}

List ALL models from the DATABASE LIST above — every single row, no exceptions.
- Do NOT remove any model based on its name or your own assumptions
- Do NOT add any model that is not in the list above
- Group by status: Active first, then Discontinued
- For each model show: model code, product name, warranty period
- Use markdown formatting.`;

  const analysis = await callBedrock(prompt, 600);
  return {
    intent: 'PRODUCT_LOOKUP',
    analysis,
    matchedModel,
    warrantyMonths,
    detectedProduct,
  };
}

// 7. UNIT_TRACKING: "Where is Cameron Gerhardy's parcel?" / "Has SC tracking 01993... been received?"
// Checks daily_connote (warehouse receipt) + repair_jobs (booking status)
async function handleUnitTracking(text, unitTrackingTerms = {}) {
  const { customerName, trackingNumber, reference, email } = unitTrackingTerms;

  console.log('UNIT_TRACKING extracted — Name:', customerName, '| Tracking:', trackingNumber, '| Ref:', reference, '| Email:', email);

  // Resolve customer by email if provided
  let emailCustomerId = null;
  let emailCustomerName = null;
  if (email) {
    const { rows } = await pool.query(
      `SELECT customer_id, customer_name FROM customers WHERE LOWER(email) = $1 LIMIT 1`,
      [email]
    );
    if (rows.length > 0) {
      emailCustomerId = rows[0].customer_id;
      emailCustomerName = rows[0].customer_name;
    }
  }

  // A pure numeric "tracking number" may actually be a reference — search both
  const refTerm = reference || trackingNumber;

  // Query connote + repair jobs in parallel
  const [connoteByName, connoteByTracking, connoteByRef, connoteByEmailId,
         repairJobsByName, repairJobsByRef, repairJobsByEmailId] = await Promise.all([
    customerName   ? queryConnoteByName(customerName)          : Promise.resolve([]),
    trackingNumber ? queryConnoteByTracking(trackingNumber)    : Promise.resolve([]),
    refTerm        ? queryConnoteByReference(refTerm)          : Promise.resolve([]),
    emailCustomerId ? pool.query(`SELECT * FROM daily_connote WHERE customer_id = $1 ORDER BY date_received DESC LIMIT 10`, [emailCustomerId]).then(r => r.rows) : Promise.resolve([]),
    customerName   ? queryRepairJobsByName(customerName)       : Promise.resolve([]),
    refTerm        ? queryRepairJobsByReference(refTerm)       : Promise.resolve([]),
    emailCustomerId ? pool.query(`SELECT job_number, product_model, customer_name, date_opened, job_action, customer_comment, technician_comment FROM repair_jobs WHERE customer_id = $1 ORDER BY date_opened DESC LIMIT 10`, [emailCustomerId]).then(r => r.rows) : Promise.resolve([]),
  ]);

  // Deduplicate connote results by id
  const seen = new Set();
  const connoteRows = [...connoteByName, ...connoteByTracking, ...connoteByRef, ...connoteByEmailId].filter(r => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });

  // Deduplicate repair jobs by job_number
  const seenJobs = new Set();
  const repairJobs = [...repairJobsByName, ...repairJobsByRef, ...repairJobsByEmailId].filter(r => {
    if (seenJobs.has(r.job_number)) return false;
    seenJobs.add(r.job_number);
    return true;
  });

  const connoteContext = connoteRows.length > 0
    ? connoteRows.map(r =>
        `- Date: ${r.date_received ? new Date(r.date_received).toLocaleDateString('en-AU') : 'N/A'} | Courier: ${r.courier || 'N/A'} | Tracking: ${r.tracking || 'N/A'} | Reference: ${r.reference || 'N/A'} | Sender: ${r.sender || 'N/A'} | Received by: ${r.received_by || 'N/A'}`
      ).join('\n')
    : 'No connote/delivery records found.';

  // Find the earliest parcel receipt date to use as the cut-off for "related" jobs
  const parcelDate = connoteRows.length > 0
    ? connoteRows.reduce((earliest, r) => {
        if (!r.date_received) return earliest;
        const d = new Date(r.date_received);
        return !earliest || d < earliest ? d : earliest;
      }, null)
    : null;

  const repairContext = repairJobs.length > 0
    ? repairJobs.map(r => {
        const jobDate = r.date_opened ? new Date(r.date_opened) : null;
        const tag = parcelDate && jobDate
          ? (jobDate >= parcelDate ? '[LIKELY RELATED TO THIS PARCEL]' : '[OLD JOB — opened before parcel arrived]')
          : '';
        return `- ${r.job_number} ${tag} | Model: ${r.product_model} | Date: ${jobDate ? jobDate.toLocaleDateString('en-AU') : 'N/A'} | Action: ${r.job_action} | Issue: ${r.customer_comment}`;
      }).join('\n')
    : 'No repair jobs found for this customer.';

  const prompt = `You are a logistics and repair tracking assistant for Uniden Australia warehouse and customer service.

QUESTION: ${text}
SEARCHED FOR: ${[customerName && `Name: "${customerName}"`, trackingNumber && `Tracking: "${trackingNumber}"`, reference && `Reference: "${reference}"`, email && `Email: "${email}"${emailCustomerName ? ` → resolved to "${emailCustomerName}"` : ' → no matching customer found'}`].filter(Boolean).join(', ')}

CONNOTE / DELIVERY LOG (parcels received at Uniden warehouse):
${connoteContext}

REPAIR JOB RECORDS (units booked into the repair system):
${repairContext}

CRITICAL RULES:
- If a record exists in the CONNOTE / DELIVERY LOG, the parcel WAS received at the Uniden warehouse on that date. Never say "not yet received" or invent an "Expected delivery" date when a connote record exists.
- "Received by: N/A" only means the person's name was not recorded — the parcel was still received.
- Only say a parcel was not received if the connote section explicitly says "No connote/delivery records found."

Provide a clear status report:
1. **Parcel Received?** — Yes/No. If yes, include date received, courier, tracking number, and RA/reference. Only mention received_by if it is not N/A.
2. **Repair Job Status** — Focus on jobs tagged [LIKELY RELATED TO THIS PARCEL] (opened on or after the parcel date). List job number, model, date opened, action, and issue. Jobs tagged [OLD JOB] are pre-existing and should be listed briefly at the end under "Previous jobs" — do not treat them as linked to this parcel.
3. **Overall Summary** — One clear sentence for the customer service team.

If nothing is found in either table, say so clearly and suggest double-checking the customer name, tracking number, or reference number.
Today's date is ${new Date().toLocaleDateString('en-AU')}. All dates in the system are valid historical records.
Always format dates as DD Month YYYY (e.g. 05 April 2026) — never use MM/DD/YYYY or ambiguous numeric formats.
Use markdown formatting.`;

  const analysis = await callBedrock(prompt, 600);
  return {
    intent: 'UNIT_TRACKING',
    analysis,
    matchedModel: null,
    warrantyMonths: null,
    detectedProduct: null,
  };
}

// 8. CUSTOMER_SERVICE: customer email (Hi, my camera has a lag issue...)
// Full priority-based email drafting (existing logic)
async function handleCustomerService(text, matchedModel, warrantyMonths, productType, detectedProduct) {
  const [repairJobs, knowledgeEntries, policies, highPriorityTemplate] = await Promise.all([
    queryRepairJobsByModel(matchedModel, 50),
    queryKnowledgeBase(matchedModel),
    queryAllPolicies(),
    queryHighPriorityTemplate(),
  ]);

  // Score repair jobs by relevance
  const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const upperModel = matchedModel ? matchedModel.toUpperCase() : null;
  const scored = repairJobs.map(row => {
    const rowModel = (row.product_model || '').toUpperCase();
    const content = `${row.customer_comment || ''} ${row.technician_comment || ''}`.toLowerCase();
    let score = 0;
    if (upperModel && rowModel === upperModel) score += 100;
    else if (upperModel && (rowModel.includes(upperModel) || upperModel.includes(rowModel))) score += 50;
    score += words.filter(w => content.includes(w)).length;
    return { ...row, score };
  });
  const relevantCases = scored.sort((a, b) => b.score - a.score).slice(0, 15);

  const historicalContext = relevantCases.length > 0
    ? relevantCases.map(c =>
        `- Job: ${c.job_number} | Model: ${c.product_model} | Issue: ${c.customer_comment} | Resolution: ${c.technician_comment}`
      ).join('\n')
    : 'No similar historical cases found.';

  const knowledgeContext = knowledgeEntries.length > 0
    ? knowledgeEntries.map(e => `Q: ${e.question}\nA: ${e.answer}`).join('\n\n')
    : 'No specific product knowledge entries found.';

  const warrantyPolicies = policies
    .filter(p => p.category.toLowerCase().includes('warranty'))
    .map(p => `[${p.policy_id}] ${p.procedure_title}: ${p.details}`)
    .join('\n');

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

PRODUCT INFORMATION:
- Detected Product Category: ${detectedProduct || 'Unknown'}
- Matched Model: ${matchedModel || 'Not detected'}
- Warranty Period: ${warrantyMonths ? warrantyMonths + ' month(s)' : 'Unknown'}

IMPORTANT: Only use the Matched Model shown above. If "Not detected", use generic terms like "your unit", "your device". Never hallucinate a model name.

DATE DETECTION:
- Look for any date in the text (DD/MM/YYYY, DD-MM-YYYY, written dates)
- Use Australian date format: DD/MM/YYYY (day first)
- Today's date is: ${new Date().toLocaleDateString('en-AU')}

WARRANTY CALCULATION:
- Warranty expiry = purchase date + warranty months
- If today is AFTER expiry → OUT OF WARRANTY
- If today is BEFORE expiry → UNDER WARRANTY
- EXCEPTION: Baby monitors with swollen battery have EXTENDED warranty

WARRANTY POLICIES FROM DATABASE:
${warrantyPolicies || 'See standard company policies.'}

PRODUCT KNOWLEDGE BASE:
${knowledgeContext}

HISTORICAL SIMILAR CASES:
${historicalContext}

ENQUIRY TO ANALYSE:
${text}

---

PRIORITY DETECTION (check in this order):
1. **High** — Customer already tried troubleshooting ("I have tried", "still not working", "followed your steps", "already done")
2. **Medium** — Specific model code AND proof of purchase both provided, no troubleshooting yet
3. **Low** — Model OR proof of purchase is missing

**If Low Priority:**
1. **Issue Category**
2. **Priority**: Low
3. **Key Points**
4. **Missing Information**
5. **Suggested Email Response**: SHORT. Ask for missing info only (model number and/or proof of purchase). Do NOT suggest troubleshooting.
6. **Internal Notes**

**If Medium Priority:**
1. **Issue Category**
2. **Priority**: Medium
3. **Warranty Status**: Calculate from purchase date. Include expiry date.
4. **Key Points**
5. **Troubleshooting Steps**: Only reference historical cases for EXACT same model. Generic steps if no exact match.
6. **Suggested Email Response**: Include troubleshooting steps + warranty/out-of-warranty next steps
7. **Internal Notes**

**If High Priority:**
1. **Issue Category**
2. **Priority**: High
3. **Warranty Status**
4. **Key Points**
5. **Suggested Email Response**: Use the HIGH PRIORITY TEMPLATE below WORD FOR WORD
6. **Internal Notes**

FORMATTING: Use markdown. Blank lines between paragraphs. Numbered steps for instructions.
Do NOT explain why you chose Customer Service or Technician mode. Do NOT include a "Reasons:", "Team Detection:", or "ANALYSIS:" header. Go straight to Issue Category.

FINAL CHECK:
Q1: Already troubleshot? → YES = High
Q2: Specific model code provided? (not generic words)
Q3: Proof of purchase / specific date provided?
Q1=NO + Q2=YES + Q3=YES → Medium. Q1=NO + (Q2=NO or Q3=NO) → Low.

---

HIGH PRIORITY EMAIL TEMPLATE (use this WORD FOR WORD for High priority responses):

${highPriorityTemplate || 'Template not found — use standard high priority email format.'}`;

  const analysis = await callBedrock(prompt);
  return {
    intent: 'CUSTOMER_SERVICE',
    analysis,
    matchedModel,
    warrantyMonths,
    detectedProduct,
    matchedCases: relevantCases.length,
  };
}

// ─── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 200, headers: CORS_HEADERS, body: '' };
    }

    const body = JSON.parse(event.body || '{}');
    const { text, debugMode } = body;

    console.log('USER ENQUIRY:', text);

    if (!text || !text.trim()) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Missing enquiry text' }),
      };
    }

    // Step 1: Detect intent first (fast, no DB)
    const { intent, aiCategory, faultKeyword, unitTrackingTerms } = await detectIntent(text);
    const scNumber = extractScNumber(text);
    console.log('Intent:', intent, '| SC:', scNumber, '| AI Category:', aiCategory);

    // Step 2: Load product index and detect model (cached after cold start)
    const productIndex = await loadProductIndex();
    let { matchedModel, warrantyMonths, productType } = lookupWarranty(text, productIndex);
    let detectedProduct = detectProduct(text);

    // Step 3: Fallback model detection if not found
    if (!matchedModel) matchedModel = await detectModelFromDB(text);
    if (!matchedModel) {
      const aiModel = await extractModelWithAI(text);
      if (aiModel) {
        matchedModel = aiModel;
        if (productIndex[aiModel]) {
          warrantyMonths = productIndex[aiModel].months;
          productType = productIndex[aiModel].productType;
        }
      }
    }

    // Step 4: Derive product category from matched model
    if (matchedModel) {
      const mapped = normalizeProductType(productType);
      if (mapped) detectedProduct = mapped;
      else {
        const cat = categorizeProduct(matchedModel);
        if (cat !== 'Unknown' && cat !== 'Other') detectedProduct = cat;
      }
    }

    // Step 4b: Check if product is discontinued
    let productStatus = null;
    if (matchedModel) {
      const { rows } = await pool.query(
        'SELECT status FROM products WHERE UPPER(model) = $1 LIMIT 1',
        [matchedModel.toUpperCase()]
      );
      productStatus = rows[0]?.status || null;
    }

    console.log('Model:', matchedModel, '| Warranty:', warrantyMonths, '| Product:', detectedProduct);

    if (debugMode) {
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ debugMode: true, intent, matchedModel, warrantyMonths, detectedProduct, scNumber }),
      };
    }

    // Step 5: Route to appropriate handler
    let result;
    switch (intent) {
      case 'TECHNICIAN':
        result = await handleTechnician(text, matchedModel, warrantyMonths, productType, detectedProduct);
        break;
      case 'KNOWLEDGE_LOOKUP':
        result = await handleKnowledgeLookup(text, matchedModel, warrantyMonths, productType, detectedProduct);
        break;
      case 'POLICY_LOOKUP':
        result = await handlePolicyLookup(text, matchedModel, warrantyMonths, detectedProduct);
        break;
      case 'JOB_LOOKUP':
        result = await handleJobLookup(text, scNumber);
        break;
      case 'FAULT_LOOKUP':
        result = await handleFaultLookup(text, matchedModel, warrantyMonths, detectedProduct, faultKeyword);
        break;
      case 'PRODUCT_LOOKUP':
        result = await handleProductLookup(text, matchedModel, warrantyMonths, detectedProduct, aiCategory);
        break;
      case 'UNIT_TRACKING':
        result = await handleUnitTracking(text, unitTrackingTerms || {});
        break;
      default:
        result = await handleCustomerService(text, matchedModel, warrantyMonths, productType, detectedProduct);
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ ...result, productStatus }),
    };
  } catch (error) {
    console.error('Error:', error);
    const isThrottle = error.name === 'ThrottlingException' || error.$metadata?.httpStatusCode === 429;
    return {
      statusCode: isThrottle ? 429 : 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: isThrottle ? 'too_many_requests' : 'Analysis failed',
        details: error.message,
      }),
    };
  }
};
