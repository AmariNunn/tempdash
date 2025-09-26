const express = require('express');
const router = express.Router();

// Get current prompt
router.get('/', async (req, res) => {
    try {
        const result = await req.appState.pool.query('SELECT * FROM prompts ORDER BY created_at DESC LIMIT 1');
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'No prompts found' });
        }
        
        res.json({ prompt: result.rows[0] });
    } catch (error) {
        console.error('Error fetching prompt:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// Update prompt
router.put('/', async (req, res) => {
    const { system_prompt, first_message } = req.body;
    
    if (!system_prompt || !first_message) {
        return res.status(400).json({ error: 'Both system_prompt and first_message are required' });
    }

    try {
        // Check if prompt exists
        const existingPrompt = await req.appState.pool.query('SELECT id FROM prompts ORDER BY created_at DESC LIMIT 1');
        
        let result;
        if (existingPrompt.rows.length > 0) {
            // Update existing prompt
            result = await req.appState.pool.query(`
                UPDATE prompts 
                SET system_prompt = $1, first_message = $2, updated_at = NOW() 
                WHERE id = $3 
                RETURNING *
            `, [system_prompt, first_message, existingPrompt.rows[0].id]);
        } else {
            // Insert new prompt
            result = await req.appState.pool.query(`
                INSERT INTO prompts (system_prompt, first_message) 
                VALUES ($1, $2) 
                RETURNING *
            `, [system_prompt, first_message]);
        }

        // Emit update to all connected clients
        req.appState.io.emit('promptUpdated', result.rows[0]);
        
        res.json({ 
            success: true, 
            message: 'Prompt updated successfully',
            prompt: result.rows[0]
        });
    } catch (error) {
        console.error('Error updating prompt:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// Get prompt history
router.get('/history', async (req, res) => {
    try {
        const result = await req.appState.pool.query('SELECT * FROM prompts ORDER BY created_at DESC LIMIT 10');
        res.json({ prompts: result.rows });
    } catch (error) {
        console.error('Error fetching prompt history:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

module.exports = router;