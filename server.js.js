const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const { Document, Packer, Paragraph, TextRun, AlignmentType, convertInchesToTwip } = require('docx');

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

/**
 * POST /generate-grant-narrative
 * Generates a grant narrative from RFP text
 */
app.post('/generate-grant-narrative', async (req, res) => {
  const { rfpText, organizationName, organizationMission, tone } = req.body;

  if (!rfpText || !organizationName) {
    return res.status(400).json({
      error: 'Missing required fields: rfpText and organizationName'
    });
  }

  try {
    const narrative = await generateNarrative(
      rfpText,
      organizationName,
      organizationMission,
      tone
    );

    return res.json({ narrative });
  } catch (error) {
    console.error('Error generating narrative:', error);
    return res.status(500).json({
      error: 'Failed to generate narrative',
      details: error.message
    });
  }
});

/**
 * POST /download-narrative
 * Converts narrative to DOCX and returns as attachment
 */
app.post('/download-narrative', async (req, res) => {
  const { narrative, organizationName } = req.body;

  if (!narrative) {
    return res.status(400).json({ error: 'Missing narrative text' });
  }

  try {
    const docBuffer = await narrativeToDocx(narrative, organizationName);
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${organizationName || 'grant-narrative'}.docx"`);
    res.send(docBuffer);
  } catch (error) {
    console.error('Error generating DOCX:', error);
    return res.status(500).json({
      error: 'Failed to generate document',
      details: error.message
    });
  }
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * Generate grant narrative using Claude
 */
async function generateNarrative(rfpText, organizationName, organizationMission, tone) {
  const toneInstructions = {
    professional: `Use formal, grant-appropriate language. Emphasize credentials, outcomes, and organizational capacity. Include specific data points and metrics. Use active voice and confident statements. This should sound like a traditional foundation grant proposal.`,
    
    accessible: `Use clear, jargon-free language that non-experts can understand. Break complex ideas into simple concepts. Use conversational tone while remaining professional. Focus on human impact rather than technical details. Avoid acronyms unless absolutely necessary.`,
    
    impact: `Lead with the human impact and outcomes. Focus on who benefits and how lives change. Use compelling storytelling while remaining data-backed. Emphasize the urgency and relevance of the work. Make emotional connection while maintaining credibility.`
  };

  const systemPrompt = `You are an expert grant writer for nonprofit organizations. You analyze grant RFPs (Requests for Proposal) and draft compelling grant narratives.

Your task is to:
1. Carefully read and analyze the RFP requirements
2. Extract key requirements, preferences, and evaluation criteria
3. Draft a compelling grant narrative that addresses all requirements
4. Use the specified tone and style

IMPORTANT INSTRUCTIONS:
- Address all stated requirements in the RFP
- Use specific language from the RFP (echo their priorities)
- Include concrete examples and projected outcomes
- Demonstrate organizational capacity and track record (use realistic but compelling details)
- Keep narrative cohesive and flowing
- Aim for 400-600 words unless RFP specifies length
- Format as readable paragraphs (not bullet points)

${toneInstructions[tone] || toneInstructions.professional}`;

  const userPrompt = `Generate a grant narrative for this RFP:

ORGANIZATION: ${organizationName}
${organizationMission ? `MISSION: ${organizationMission}` : ''}

RFP TEXT:
${rfpText}

Draft a compelling grant narrative that directly addresses the RFP requirements and demonstrates why this organization deserves funding. The narrative should be ready for a grant officer to review and refine.`;

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-20250507',
    max_tokens: 1500,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: userPrompt
      }
    ]
  });

  // Extract text from response
  const narrative = message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n\n');

  return narrative;
}

/**
 * Convert narrative text to DOCX format
 */
async function narrativeToDocx(narrative, organizationName) {
  // Split narrative into paragraphs
  const paragraphs = narrative
    .split('\n')
    .filter(p => p.trim().length > 0)
    .map(p => 
      new Paragraph({
        text: p.trim(),
        spacing: {
          line: 360, // 1.5 line spacing (240 = single, 360 = 1.5)
          after: 200
        },
        alignment: AlignmentType.LEFT
      })
    );

  // Add title
  const docParagraphs = [
    new Paragraph({
      text: `Grant Narrative: ${organizationName || 'Organization'}`,
      heading: 'Heading1',
      spacing: { after: 200 },
      alignment: AlignmentType.CENTER,
      bold: true,
      size: 32,
      color: '1a5f3f'
    }),
    new Paragraph({
      text: `Generated by NonprofitAI on ${new Date().toLocaleDateString()}`,
      spacing: { after: 400 },
      alignment: AlignmentType.CENTER,
      size: 20,
      color: '999999'
    }),
    ...paragraphs
  ];

  // Create document
  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margins: {
              top: convertInchesToTwip(1),
              right: convertInchesToTwip(1),
              bottom: convertInchesToTwip(1),
              left: convertInchesToTwip(1)
            }
          }
        },
        children: docParagraphs
      }
    ]
  });

  // Convert to buffer
  const buffer = await Packer.toBuffer(doc);
  return buffer;
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NonprofitAI API listening on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
