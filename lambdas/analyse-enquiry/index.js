const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

const client = new BedrockRuntimeClient({ region: 'ap-southeast-2' });

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { text } = body;

    if (!text || !text.trim()) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Missing enquiry text' }),
      };
    }

    const prompt = `You are a technical support analyst. Analyse the following customer enquiry and provide:

1. **Summary**: A brief summary of the customer's issue
2. **Category**: The type of issue (e.g., Hardware, Software, Network, Account, Billing, etc.)
3. **Priority**: Suggested priority level (Low, Medium, High, Critical)
4. **Key Points**: Main technical details or concerns mentioned
5. **Suggested Response**: A draft response or next steps for the support team

Customer Enquiry:
${text}

Provide your analysis in a clear, structured format.`;

    const response = await client.send(
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
      body: JSON.stringify({ analysis }),
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
