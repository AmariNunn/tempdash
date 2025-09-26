const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');

// Helper function to initiate outbound call
async function initiateOutboundCall(phoneNumber, elevenLabsConfig) {
    if (!elevenLabsConfig.apiKey || !elevenLabsConfig.agentId || !elevenLabsConfig.phoneNumberId) {
        throw new Error('ElevenLabs configuration incomplete');
    }

    const requestBody = {
        agent_id: elevenLabsConfig.agentId,
        agent_phone_number_id: elevenLabsConfig.phoneNumberId,
        to_number: phoneNumber,
        conversation_initiation_client_data: {}
    };

    const response = await fetch(elevenLabsConfig.apiUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'xi-api-key': elevenLabsConfig.apiKey
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`ElevenLabs API error: ${response.status} - ${errorData}`);
    }

    const data = await response.json();
    return data;
}

// Process batch calls with rate limiting
async function processBatchQueue(appState) {
    if (appState.currentBatch || appState.batchQueue.length === 0) {
        return;
    }

    const batchId = appState.batchQueue.shift();
    appState.currentBatch = batchId;

    try {
        // Get batch details
        const batchResult = await appState.pool.query('SELECT * FROM batches WHERE id = $1', [batchId]);
        if (batchResult.rows.length === 0) {
            throw new Error('Batch not found');
        }

        const batch = batchResult.rows[0];
        
        // Get batch calls
        const callsResult = await appState.pool.query(
            'SELECT * FROM batch_calls WHERE batch_id = $1 AND status = $2 ORDER BY created_at',
            [batchId, 'pending']
        );

        const calls = callsResult.rows;
        let successfulCalls = 0;
        let failedCalls = 0;

        // Process calls with rate limiting (1 call every 2 seconds)
        for (const call of calls) {
            try {
                await new Promise(resolve => setTimeout(resolve, 2000)); // Rate limiting
                
                const formattedPhone = formatPhoneNumber(call.phone_number);
                const callResult = await initiateOutboundCall(formattedPhone, appState.elevenLabsConfig);

                // Update batch call record
                await appState.pool.query(
                    `UPDATE batch_calls SET status = $1, call_id = $2, error_message = NULL WHERE id = $3`,
                    ['initiated', callResult.conversation_id || callResult.id, call.id]
                );

                // Create call record
                const callData = {
                    id: `batch-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                    timestamp: new Date().toISOString(),
                    caller_number: formattedPhone,
                    called_number: 'Agent',
                    duration: 0,
                    status: 'initiated',
                    call_type: 'outbound',
                    transcript: '',
                    conversation_id: callResult.conversation_id || callResult.id
                };

                await appState.pool.query(`
                    INSERT INTO calls (id, timestamp, caller_number, called_number, duration, status, call_type, transcript, conversation_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                `, [callData.id, callData.timestamp, callData.caller_number, callData.called_number, 
                    callData.duration, callData.status, callData.call_type, callData.transcript, callData.conversation_id]);

                appState.io.emit('newCall', callData);
                successfulCalls++;

            } catch (error) {
                console.error(`Failed to initiate call to ${call.phone_number}:`, error);
                await appState.pool.query(
                    `UPDATE batch_calls SET status = $1, error_message = $2 WHERE id = $3`,
                    ['failed', error.message, call.id]
                );
                failedCalls++;
            }

            // Update batch progress
            const completedCalls = successfulCalls + failedCalls;
            await appState.pool.query(
                `UPDATE batches SET completed_calls = $1, successful_calls = $2, failed_calls = $3 WHERE id = $4`,
                [completedCalls, successfulCalls, failedCalls, batchId]
            );

            // Emit progress update
            appState.io.emit('batchProgress', {
                batchId,
                completed: completedCalls,
                total: batch.total_calls,
                successful: successfulCalls,
                failed: failedCalls
            });
        }

        // Mark batch as completed
        const finalStatus = failedCalls === calls.length ? 'failed' : 
                           successfulCalls === calls.length ? 'completed' : 'partial';
        
        await appState.pool.query(
            `UPDATE batches SET status = $1, completed_calls = $2, successful_calls = $3, failed_calls = $4 WHERE id = $5`,
            [finalStatus, calls.length, successfulCalls, failedCalls, batchId]
        );

        appState.io.emit('batchCompleted', {
            batchId,
            status: finalStatus,
            total: calls.length,
            successful: successfulCalls,
            failed: failedCalls
        });

    } catch (error) {
        console.error('Batch processing error:', error);
        await appState.pool.query('UPDATE batches SET status = $1 WHERE id = $2', ['failed', batchId]);
        appState.io.emit('batchError', { batchId, error: error.message });
    } finally {
        appState.currentBatch = null;
        
        // Process next batch if any
        if (appState.batchQueue.length > 0) {
            setTimeout(() => processBatchQueue(appState), 1000);
        }
    }
}

function formatPhoneNumber(phoneNumber) {
    const cleanedPhone = phoneNumber.replace(/[\s\-\(\)\.]/g, '');
    let formattedPhone = cleanedPhone;
    
    if (!formattedPhone.startsWith('+')) {
        if (formattedPhone.length === 10) {
            formattedPhone = '+1' + formattedPhone;
        } else if (formattedPhone.length === 11 && formattedPhone.startsWith('1')) {
            formattedPhone = '+' + formattedPhone;
        }
    }
    
    return formattedPhone;
}

// Create new batch
router.post('/', async (req, res) => {
    const { name, calls } = req.body;
    
    if (!name || !calls || !Array.isArray(calls) || calls.length === 0) {
        return res.status(400).json({ error: 'Batch name and calls array are required' });
    }

    if (calls.length > 1000) {
        return res.status(400).json({ error: 'Batch size cannot exceed 1000 calls' });
    }

    const batchId = uuidv4();
    const client = await req.appState.pool.connect();

    try {
        await client.query('BEGIN');

        // Create batch record
        await client.query(`
            INSERT INTO batches (id, name, total_calls, status) 
            VALUES ($1, $2, $3, $4)
        `, [batchId, name, calls.length, 'pending']);

        // Create batch call records
        for (const call of calls) {
            const callId = uuidv4();
            await client.query(`
                INSERT INTO batch_calls (id, batch_id, phone_number, first_name, last_name, company, status)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [callId, batchId, call.phoneNumber, call.firstName || '', call.lastName || '', call.company || '', 'pending']);
        }

        await client.query('COMMIT');

        // Add to processing queue
        req.appState.batchQueue.push(batchId);
        
        // Start processing if not already processing
        if (!req.appState.currentBatch) {
            setTimeout(() => processBatchQueue(req.appState), 1000);
        }

        res.json({ 
            success: true, 
            message: 'Batch created successfully',
            batchId,
            totalCalls: calls.length,
            queuePosition: req.appState.batchQueue.length
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating batch:', error);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

// Get batch status
router.get('/:batchId', async (req, res) => {
    try {
        const batchResult = await req.appState.pool.query('SELECT * FROM batches WHERE id = $1', [req.params.batchId]);
        
        if (batchResult.rows.length === 0) {
            return res.status(404).json({ error: 'Batch not found' });
        }

        const callsResult = await req.appState.pool.query(
            'SELECT * FROM batch_calls WHERE batch_id = $1 ORDER BY created_at',
            [req.params.batchId]
        );

        res.json({ 
            batch: batchResult.rows[0],
            calls: callsResult.rows
        });
    } catch (error) {
        console.error('Error fetching batch:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// Get all batches
router.get('/', async (req, res) => {
    try {
        const result = await req.appState.pool.query('SELECT * FROM batches ORDER BY created_at DESC LIMIT 20');
        res.json({ batches: result.rows });
    } catch (error) {
        console.error('Error fetching batches:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// Cancel batch
router.post('/:batchId/cancel', async (req, res) => {
    try {
        await req.appState.pool.query('UPDATE batches SET status = $1 WHERE id = $2 AND status = $3', 
            ['cancelled', req.params.batchId, 'pending']);
        
        // Remove from queue if not yet processing
        const queueIndex = req.appState.batchQueue.indexOf(req.params.batchId);
        if (queueIndex > -1) {
            req.appState.batchQueue.splice(queueIndex, 1);
        }

        res.json({ success: true, message: 'Batch cancelled successfully' });
    } catch (error) {
        console.error('Error cancelling batch:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

module.exports = router;
