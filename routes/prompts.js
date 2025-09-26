const express = require('express');
const router = express.Router();

// Smart first message extraction - handles any format
function extractFirstMessageFromPrompt(systemPrompt) {
    const lines = systemPrompt.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    
    // Strategy 1: Look for explicit greeting patterns anywhere in the text
    for (const line of lines) {
        const cleaned = line.replace(/^[-*•"']\s*/, '').replace(/["']$/, '').trim();
        
        // Find lines that look like greetings
        if (cleaned.match(/^(hello|hi|good\s+(morning|afternoon|evening)|thank\s+you\s+for\s+calling)/i) && cleaned.length < 200) {
            return cleaned;
        }
        
        // Find "This is..." introductions
        if (cleaned.match(/^this\s+is\s+\w+/i) && cleaned.length < 150) {
            return cleaned.startsWith('Hello') ? cleaned : `Hello! ${cleaned}`;
        }
    }
    
    // Strategy 2: Extract from "You are [Name]" and build greeting
    const nameCompanyMatch = systemPrompt.match(/you\s+are\s+(\w+).*?(?:from|at|for|work\s+for)\s+([^.!?\n]+)/i);
    if (nameCompanyMatch) {
        const name = nameCompanyMatch[1];
        const company = nameCompanyMatch[2].replace(/[,.].*/, '').trim();
        return `Hello! This is ${name} from ${company}. How can I help you today?`;
    }
    
    // Strategy 3: Look for any name in the prompt
    const simpleNameMatch = systemPrompt.match(/you\s+are\s+(\w+)/i);
    if (simpleNameMatch) {
        const name = simpleNameMatch[1];
        return `Hello! This is ${name}. How can I help you today?`;
    }
    
    // Fallback
    return "Hello! How can I help you today?";
}

// Function to update ElevenLabs agent
async function updateElevenLabsAgent(systemPrompt, firstMessage, elevenLabsConfig) {
    if (!elevenLabsConfig.apiKey || !elevenLabsConfig.agentId) {
        throw new Error('ElevenLabs configuration missing');
    }

    const updateData = {
        conversation_config: {
            agent: {
                first_message: firstMessage,
                prompt: {
                    prompt: systemPrompt
                }
            }
        }
    };

    const response = await fetch(`${elevenLabsConfig.agentsUrl}/${elevenLabsConfig.agentId}`, {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json',
            'xi-api-key': elevenLabsConfig.apiKey
        },
        body: JSON.stringify(updateData)
    });

    if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`ElevenLabs API error: ${response.status} - ${errorData}`);
    }

    return await response.json();
}

// Get current prompt
router.get('/', async (req, res) => {
    try {
        const result = await req.appState.pool.query('SELECT * FROM prompts ORDER BY updated_at DESC LIMIT 1');
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'No prompts found' });
        }
        
        res.json({ prompt: result.rows[0] });
    } catch (error) {
        console.error('Error fetching prompt:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// Update prompt - simple format, smart extraction
router.put('/', async (req, res) => {
    const { system_prompt } = req.body;
    
    if (!system_prompt) {
        return res.status(400).json({ error: 'system_prompt is required' });
    }

    try {
        // Smart extraction of first message
        const extractedFirstMessage = extractFirstMessageFromPrompt(system_prompt);
        
        // Clear old prompts and insert new one
        await req.appState.pool.query('DELETE FROM prompts');
        
        const result = await req.appState.pool.query(`
            INSERT INTO prompts (system_prompt, first_message, prompt, created_at, updated_at) 
            VALUES ($1, $2, $1, NOW(), NOW()) 
            RETURNING *
        `, [system_prompt, extractedFirstMessage]);

        // Update ElevenLabs agent
        try {
            await updateElevenLabsAgent(system_prompt, extractedFirstMessage, req.appState.elevenLabsConfig);
            console.log(`ElevenLabs agent updated with greeting: "${extractedFirstMessage}"`);
        } catch (elevenLabsError) {
            console.error('Failed to update ElevenLabs agent:', elevenLabsError.message);
        }

        // Emit update to connected clients
        if (req.appState.io) {
            req.appState.io.emit('promptUpdated', result.rows[0]);
        }
        
        res.json({ 
            success: true, 
            message: 'Prompt updated successfully',
            prompt: result.rows[0],
            extracted_first_message: extractedFirstMessage
        });
    } catch (error) {
        console.error('Error updating prompt:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

module.exports = router;
