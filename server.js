const http = require('http');
const https = require('https');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;

// Body parser
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// Server
const server = http.createServer(async (req, res) => {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    return;
  }

  // Generate grant narrative - Claude proxy
  if (req.method === 'POST' && req.url === '/generate-grant-narrative') {
    try {
      const requestBody = await parseBody(req);

      const {
        rfpText,
        organizationName,
        organizationMission,
        yearsInOperation,
        annualBudget,
        staffAndVolunteers,
        peopleServedAnnually,
        projectTitle,
        projectDescription,
        pastAccomplishments,
        tone
      } = requestBody;

      if (!rfpText || !organizationName) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required fields: rfpText and organizationName' }));
        return;
      }

      // Build the system and user prompts
      const toneInstructions = {
        professional: `Use formal, grant-appropriate language. Emphasize credentials, outcomes, and organizational capacity. Include specific data points and metrics. Use active voice and confident statements. This should sound like a traditional foundation grant proposal.`,
        
        accessible: `Use clear, jargon-free language that non-experts can understand. Break complex ideas into simple concepts. Use conversational tone while remaining professional. Focus on human impact rather than technical details. Avoid acronyms unless absolutely necessary.`,
        
        impact: `Lead with the human impact and outcomes. Focus on who benefits and how lives change. Use compelling storytelling while remaining data-backed. Emphasize the urgency and relevance of the work. Make emotional connection while maintaining credibility.`
      };

      const systemPrompt = `You are an expert grant writer for nonprofit organizations. You analyze grant RFPs and draft compelling, data-backed grant narratives using organizational context.

Your task is to:
1. Carefully read and analyze the RFP requirements
2. Extract key requirements, preferences, and evaluation criteria
3. Draft a compelling grant narrative that directly addresses all requirements
4. Integrate the organization's background, experience, and track record throughout
5. Use the specified tone and style

IMPORTANT INSTRUCTIONS:
- Address all stated requirements in the RFP
- Use specific language from the RFP (echo their priorities)
- Incorporate organizational data (years operating, budget, staff, people served) naturally
- Include concrete examples and past accomplishments when provided
- Demonstrate organizational capacity and track record with specific details
- Keep narrative cohesive and flowing
- Aim for 500-750 words unless RFP specifies length
- Format as readable paragraphs (not bullet points)
- Make the narrative compelling while maintaining credibility

${toneInstructions[tone] || toneInstructions.professional}`;

      const userPrompt = `Generate a compelling grant narrative for this RFP using the following organizational context:

ORGANIZATION: ${organizationName}
MISSION: ${organizationMission}
YEARS IN OPERATION: ${yearsInOperation} years
ANNUAL BUDGET: $${parseInt(annualBudget).toLocaleString()}
STAFF & VOLUNTEERS: ${staffAndVolunteers}
PEOPLE SERVED ANNUALLY: ${parseInt(peopleServedAnnually).toLocaleString()}

PROJECT TITLE: ${projectTitle}
PROJECT DESCRIPTION: ${projectDescription}

${pastAccomplishments ? `PAST ACCOMPLISHMENTS: ${pastAccomplishments}` : ''}

RFP TEXT:
${rfpText}

Draft a professional grant narrative that:
1. Demonstrates the organization's experience and capacity (${yearsInOperation} years operating)
2. Shows proven impact (staff size, people served)
3. Describes the proposed project and its alignment with RFP priorities
4. Incorporates specific organizational data naturally throughout
5. Includes past accomplishments to build credibility
6. Compels the reader to fund this organization

The narrative should be ready for a grant officer to review and refine, and should feel authentic to this specific organization.`;

      // Proxy to Anthropic API
      const claudeBody = JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: userPrompt
          }
        ]
      });

      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(claudeBody)
        }
      };

      const anthropicReq = https.request(options, (anthropicRes) => {
        let responseData = '';
        anthropicRes.on('data', chunk => { responseData += chunk; });
        anthropicRes.on('end', () => {
          console.log('Claude response status:', anthropicRes.statusCode);
          console.log('Claude response data:', responseData.substring(0, 500)); // Log first 500 chars
          try {
            const parsed = JSON.parse(responseData);
            console.log('Parsed response:', JSON.stringify(parsed, null, 2).substring(0, 500));
            // Extract narrative from Claude response
            const narrative = parsed.content && parsed.content[0] && parsed.content[0].text
              ? parsed.content[0].text
              : 'Unable to generate narrative';
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ narrative }));
          } catch (e) {
            console.error('Parse error:', e);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to parse Claude response', details: responseData }));
          }
        });
      });

      anthropicReq.on('error', (err) => {
        console.error('Anthropic request error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to generate narrative', details: err.message }));
      });

      anthropicReq.write(claudeBody);
      anthropicReq.end();

    } catch (err) {
      console.error('Error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Download narrative as DOCX
  if (req.method === 'POST' && req.url === '/download-narrative') {
    try {
      const { narrative, organizationName, projectTitle } = await parseBody(req);

      if (!narrative) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing narrative text' }));
        return;
      }

      // Simple text-based DOCX generation (minimal but functional)
      // For production, you'd want to use a proper library
      const docContent = `${organizationName ? organizationName + ' - ' : ''}Grant Narrative\n\n${narrative}`;
      
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Disposition': `attachment; filename="${organizationName || 'grant-narrative'}.txt"`
      });
      res.end(docContent);

    } catch (err) {
      console.error('Download error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 404
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`NonprofitAI API listening on port ${PORT}`);
  console.log('Routes: /health | /generate-grant-narrative | /download-narrative');
});
