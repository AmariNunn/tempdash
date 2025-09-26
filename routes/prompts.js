const express = require('express');
const router = express.Router();

// Function to extract first message from system prompt
function extractFirstMessageFromPrompt(systemPrompt) {
    // Look for patterns like "Hello! This is [Name] from [Company]"
    const patterns = [
        /["']([^"']*Hello[^"']*)["']/i,
        /HOW TO START CALLS:\s*-\s*["']([^"']*)["']/i,
        /greeting[:\s]*["']([^"']*)["']/i,
        /first message[:\s]*["']([^"']*)["']/i
    ];
    
    for (const pattern of patterns) {
        const match = systemPrompt.match(pattern);
        if (match && match[1]) {
            return match[1].trim();
        }
    }
    
    // Look for agent name and company in the prompt
    const nameMatch = systemPrompt.match(/name:\s*([A-Za-z]+)/i);
    const companyMatch = systemPrompt.match(/company:\s*([A-Za-z\s]+)/i);
    
    if (nameMatch && companyMatch) {
        const name = nameMatch[1].trim();
        const company = companyMatch[1].trim();
        return `Hello! This is ${name} from ${company}. How can I help you today?`;
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

// Update prompt - clear old ones, extract first message, update ElevenLabs
router.put('/', async (req, res) => {
    const { system_prompt } = req.body;
    
    if (!system_prompt) {
        return res.status(400).json({ error: 'system_prompt is required' });
    }

    try {
        // Extract first message from the system prompt
        const first_message = extractFirstMessageFromPrompt(system_prompt);
        
        // Clear all old prompts and insert new one
        await req.appState.pool.query('DELETE FROM prompts');
        
        const result = await req.appState.pool.query(`
            INSERT INTO prompts (system_prompt, first_message, prompt, created_at, updated_at) 
            VALUES ($1, $2, $1, NOW(), NOW()) 
            RETURNING *
        `, [system_prompt, first_message]);

        // Update ElevenLabs agent
        try {
            await updateElevenLabsAgent(system_prompt, first_message, req.appState.elevenLabsConfig);
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
            extracted_first_message: first_message
        });
    } catch (error) {
        console.error('Error updating prompt:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// Get prompt history (now just returns current since we clear old ones)
router.get('/history', async (req, res) => {
    try {
        const result = await req.appState.pool.query('SELECT * FROM prompts ORDER BY created_at DESC LIMIT 1');
        res.json({ prompts: result.rows });
    } catch (error) {
        console.error('Error fetching prompt history:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

module.exports = router;
