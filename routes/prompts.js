const express = require('express');
const router = express.Router();

// Function to extract first message from structured prompt format
function extractFirstMessageFromPrompt(systemPrompt) {
    // Look for FIRST_MESSAGE: "greeting text"
    const firstMessageMatch = systemPrompt.match(/FIRST_MESSAGE:\s*["']([^"']+)["']/i);
    if (firstMessageMatch) {
        return firstMessageMatch[1].trim();
    }
    
    // Look for GREETING: "greeting text"
    const greetingMatch = systemPrompt.match(/GREETING:\s*["']([^"']+)["']/i);
    if (greetingMatch) {
        return greetingMatch[1].trim();
    }
    
    // Look for OPENING: "greeting text"
    const openingMatch = systemPrompt.match(/OPENING:\s*["']([^"']+)["']/i);
    if (openingMatch) {
        return openingMatch[1].trim();
    }
    
    // Fallback
    return "Hello! How can I help you today?";
}

// Function to validate structured prompt format
function validatePromptStructure(systemPrompt) {
    const requiredSections = [
        /FIRST_MESSAGE:\s*["'][^"']+["']/i,
        /SYSTEM_PROMPT:/i
    ];
    
    for (const section of requiredSections) {
        if (!section.test(systemPrompt)) {
            return false;
        }
    }
    return true;
}

// Function to format prompt into structured format
function formatPromptStructure(systemPrompt, firstMessage) {
    // If already structured, return as-is
    if (validatePromptStructure(systemPrompt)) {
        return systemPrompt;
    }
    
    // Convert to structured format
    return `FIRST_MESSAGE: "${firstMessage}"

SYSTEM_PROMPT:
${systemPrompt}`;
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

// Update prompt - structured format with automatic extraction
router.put('/', async (req, res) => {
    const { system_prompt, first_message } = req.body;
    
    if (!system_prompt) {
        return res.status(400).json({ error: 'system_prompt is required' });
    }

    try {
        // Extract first message from structured prompt
        let extractedFirstMessage = extractFirstMessageFromPrompt(system_prompt);
        
        // Use provided first_message if available, otherwise use extracted
        const finalFirstMessage = first_message || extractedFirstMessage;
        
        // Format prompt into structured format
        const structuredPrompt = formatPromptStructure(system_prompt, finalFirstMessage);
        
        // Clear all old prompts and insert new one
        await req.appState.pool.query('DELETE FROM prompts');
        
        const result = await req.appState.pool.query(`
            INSERT INTO prompts (system_prompt, first_message, prompt, created_at, updated_at) 
            VALUES ($1, $2, $1, NOW(), NOW()) 
            RETURNING *
        `, [structuredPrompt, finalFirstMessage]);

        // Update ElevenLabs agent
        try {
            await updateElevenLabsAgent(structuredPrompt, finalFirstMessage, req.appState.elevenLabsConfig);
            console.log('ElevenLabs agent updated successfully');
        } catch (elevenLabsError) {
            console.error('Failed to update ElevenLabs agent:', elevenLabsError.message);
            // Continue anyway - database update succeeded
        }

        // Emit update to connected clients
        if (req.appState.io) {
            req.appState.io.emit('promptUpdated', result.rows[0]);
        }
        
        res.json({ 
            success: true, 
            message: 'Prompt updated successfully',
            prompt: result.rows[0],
            extracted_first_message: finalFirstMessage,
            is_structured: validatePromptStructure(structuredPrompt)
        });
    } catch (error) {
        console.error('Error updating prompt:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// Helper endpoint to convert existing prompt to structured format
router.post('/convert', async (req, res) => {
    const { system_prompt, first_message } = req.body;
    
    if (!system_prompt) {
        return res.status(400).json({ error: 'system_prompt is required' });
    }
    
    const finalFirstMessage = first_message || "Hello! How can I help you today?";
    const structuredPrompt = formatPromptStructure(system_prompt, finalFirstMessage);
    
    res.json({
        structured_prompt: structuredPrompt,
        extracted_first_message: finalFirstMessage,
        is_valid: validatePromptStructure(structuredPrompt)
    });
});

// Get prompt in structured format
router.get('/structured', async (req, res) => {
    try {
        const result = await req.appState.pool.query('SELECT * FROM prompts ORDER BY updated_at DESC LIMIT 1');
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'No prompts found' });
        }
        
        const prompt = result.rows[0];
        const structuredPrompt = formatPromptStructure(prompt.system_prompt, prompt.first_message);
        
        res.json({ 
            prompt: {
                ...prompt,
                system_prompt: structuredPrompt
            },
            is_structured: validatePromptStructure(structuredPrompt)
        });
    } catch (error) {
        console.error('Error fetching structured prompt:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

module.exports = router;
