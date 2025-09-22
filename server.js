const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { Pool } = require('pg');
const { MailerSend, EmailParams, Sender, Recipient } = require("mailersend");
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Configure multer for file uploads
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// ElevenLabs API configuration
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const ELEVENLABS_PHONE_NUMBER_ID = process.env.ELEVENLABS_PHONE_NUMBER_ID;
const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1/convai/twilio/outbound-call';

// MailerSend configuration
const mailerSend = new MailerSend({
    apiKey: process.env.MAILERSEND_API_KEY,
});

// Email notification configuration
const emailConfig = {
    enabled: process.env.EMAIL_NOTIFICATIONS !== 'false',
    fromEmail: process.env.MAILERSEND_FROM_EMAIL || 'notifications@yourdomain.com',
    fromName: 'SkyIQ Dashboard',
    toEmail: process.env.NOTIFICATION_EMAIL,
    toName: 'SkyIQ User'
};

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Database setup
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:password@localhost:5432/elevenlabs_calls',
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Global batch processing state
let currentBatch = null;
let batchQueue = [];

// Helper function for duration formatting
function formatDuration(seconds) {
    if (!seconds || seconds === 0) return '0m 0s';
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
        return `${hours}h ${mins}m ${secs}s`;
    } else {
        return `${mins}m ${secs}s`;
    }
}

// Email notification function using MailerSend (only for inbound calls)
async function sendCallNotification(callData) {
    if (!emailConfig.enabled || !emailConfig.toEmail || !process.env.MAILERSEND_API_KEY || callData.call_type === 'outbound') {
        return;
    }

    const sentFrom = new Sender(emailConfig.fromEmail, emailConfig.fromName);
    const recipients = [new Recipient(emailConfig.toEmail, emailConfig.toName)];

    const emailParams = new EmailParams()
        .setFrom(sentFrom)
        .setTo(recipients)
        .setSubject(`📞 Inbound Call - ${callData.caller_number} - SkyIQ`)
        .setHtml(`
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff;">
                <div style="background: linear-gradient(135deg, #4f46e5, #06b6d4); padding: 30px 20px; text-align: center; color: white; border-radius: 12px 12px 0 0;">
                    <div style="display: inline-block; background: rgba(255,255,255,0.2); padding: 12px; border-radius: 50%; margin-bottom: 15px; font-size: 24px;">📞</div>
                    <h1 style="margin: 0 0 8px 0; font-size: 28px; font-weight: 700;">New Inbound Call</h1>
                    <p style="margin: 0; opacity: 0.9; font-size: 16px;">SkyIQ Dashboard Notification</p>
                </div>
                
                <div style="padding: 30px 20px; background: #f8fafc;">
                    <h2 style="color: #1e293b; margin: 0 0 20px 0; font-size: 20px; font-weight: 600;">📋 Call Details</h2>
                    
                    <div style="background: white; border-radius: 12px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); margin-bottom: 25px;">
                        <table style="width: 100%; border-collapse: collapse;">
                            <tr>
                                <td style="padding: 12px 0; font-weight: 600; color: #4f46e5; width: 130px; vertical-align: top;">📞 Phone:</td>
                                <td style="padding: 12px 0; font-family: 'SF Mono', Monaco, monospace; font-size: 16px; color: #1e293b;">${callData.caller_number}</td>
                            </tr>
                            <tr style="border-top: 1px solid #e2e8f0;">
                                <td style="padding: 12px 0; font-weight: 600; color: #4f46e5; vertical-align: top;">📅 Date:</td>
                                <td style="padding: 12px 0; color: #1e293b;">${new Date(callData.timestamp).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</td>
                            </tr>
                            <tr style="border-top: 1px solid #e2e8f0;">
                                <td style="padding: 12px 0; font-weight: 600; color: #4f46e5; vertical-align: top;">⏱️ Duration:</td>
                                <td style="padding: 12px 0; color: #1e293b;">${formatDuration(callData.duration)}</td>
                            </tr>
                        </table>
                    </div>
                    
                    <div style="text-align: center; margin-top: 30px;">
                        <a href="${process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000'}" 
                           style="display: inline-block; background: linear-gradient(135deg, #4f46e5, #7c3aed); color: white; padding: 15px 30px; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 12px rgba(79, 70, 229, 0.3);">
                            🖥️ View Dashboard
                        </a>
                    </div>
                </div>
            </div>
        `);

    try {
        await mailerSend.email.send(emailParams);
        console.log('📧 Email notification sent successfully');
    } catch (error) {
        console.error('❌ Email notification failed:', error.message);
    }
}

// Initialize database tables
async function initializeDatabase() {
    try {
        // Create calls table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS calls (
                id VARCHAR(255) PRIMARY KEY,
                timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                caller_number VARCHAR(50),
                called_number VARCHAR(50),
                duration INTEGER DEFAULT 0,
                status VARCHAR(50) DEFAULT 'completed',
                call_type VARCHAR(50) DEFAULT 'inbound',
                transcript TEXT,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )
        `);

        // Check if conversation_id column exists and add it if missing
        const checkColumn = await pool.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'calls' AND column_name = 'conversation_id'
        `);

        if (checkColumn.rows.length === 0) {
            console.log('🔧 Adding missing conversation_id column...');
            await pool.query(`
                ALTER TABLE calls 
                ADD COLUMN conversation_id VARCHAR(255)
            `);
            console.log('✅ conversation_id column added successfully');
        }

        // Create batches table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS batches (
                id VARCHAR(255) PRIMARY KEY,
                name VARCHAR(255),
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                status VARCHAR(50) DEFAULT 'pending',
                total_calls INTEGER DEFAULT 0,
                completed_calls INTEGER DEFAULT 0,
                successful_calls INTEGER DEFAULT 0,
                failed_calls INTEGER DEFAULT 0
            )
        `);

        // Create batch_calls table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS batch_calls (
                id VARCHAR(255) PRIMARY KEY,
                batch_id VARCHAR(255) REFERENCES batches(id),
                phone_number VARCHAR(50),
                status VARCHAR(50) DEFAULT 'pending',
                call_id VARCHAR(255),
                error_message TEXT,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                completed_at TIMESTAMP WITH TIME ZONE
            )
        `);

        console.log('Database tables initialized successfully');
    } catch (error) {
        console.error('Database initialization error:', error);
    }
}

initializeDatabase();

// Function to initiate outbound call via ElevenLabs API
async function initiateOutboundCall(phoneNumber) {
    if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID || !ELEVENLABS_PHONE_NUMBER_ID) {
        throw new Error('ElevenLabs configuration incomplete. Please set ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, and ELEVENLABS_PHONE_NUMBER_ID environment variables.');
    }

    try {
        const requestBody = {
            agent_id: ELEVENLABS_AGENT_ID,
            agent_phone_number_id: ELEVENLABS_PHONE_NUMBER_ID,
            to_number: phoneNumber,
            conversation_initiation_client_data: {}
        };

        const response = await fetch(ELEVENLABS_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'xi-api-key': ELEVENLABS_API_KEY
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorData = await response.text();
            throw new Error(`ElevenLabs API error: ${response.status} - ${errorData}`);
        }

        const data = await response.json();
        
        return {
            conversation_id: data.conversation_id || data.id,
            call_sid: data.callSid || data.call_sid,
            status: 'initiated',
            message: data.message || 'Call initiated successfully'
        };
    } catch (error) {
        throw error;
    }
}

// Process batch calls sequentially
async function processBatch(batchId) {
    try {
        console.log(`📞 Starting batch processing for batch: ${batchId}`);
        
        // Update batch status to processing
        await pool.query(
            'UPDATE batches SET status = $1 WHERE id = $2',
            ['processing', batchId]
        );

        // Get all pending calls for this batch
        const batchCalls = await pool.query(
            'SELECT * FROM batch_calls WHERE batch_id = $1 AND status = $2 ORDER BY created_at',
            [batchId, 'pending']
        );

        for (const batchCall of batchCalls.rows) {
            try {
                console.log(`📞 Calling ${batchCall.phone_number}...`);
                
                // Update call status to processing
                await pool.query(
                    'UPDATE batch_calls SET status = $1 WHERE id = $2',
                    ['processing', batchCall.id]
                );

                // Broadcast progress update
                io.emit('batchProgress', {
                    batchId: batchId,
                    currentCall: batchCall.phone_number,
                    progress: await getBatchProgress(batchId)
                });

                // Initiate the call
                const callResult = await initiateOutboundCall(batchCall.phone_number);
                
                // Create call record
                const callData = {
                    id: `batch-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                    timestamp: new Date().toISOString(),
                    caller_number: batchCall.phone_number,
                    called_number: 'Agent',
                    duration: 0,
                    status: 'initiated',
                    call_type: 'outbound',
                    transcript: '',
                    conversation_id: callResult.conversation_id
                };

                // Save call to database
                await pool.query(`
                    INSERT INTO calls (id, timestamp, caller_number, called_number, duration, status, call_type, transcript, conversation_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                `, [callData.id, callData.timestamp, callData.caller_number, callData.called_number, 
                    callData.duration, callData.status, callData.call_type, callData.transcript, callData.conversation_id]);

                // Update batch call status
                await pool.query(
                    'UPDATE batch_calls SET status = $1, call_id = $2, completed_at = NOW() WHERE id = $3',
                    ['completed', callData.id, batchCall.id]
                );

                // Update batch counters
                await pool.query(
                    'UPDATE batches SET completed_calls = completed_calls + 1, successful_calls = successful_calls + 1 WHERE id = $1',
                    [batchId]
                );

                // Broadcast new call
                io.emit('newCall', callData);

                console.log(`✅ Call initiated successfully to ${batchCall.phone_number}`);

                // Wait 2 seconds between calls to be respectful
                await new Promise(resolve => setTimeout(resolve, 2000));

            } catch (error) {
                console.error(`❌ Failed to call ${batchCall.phone_number}:`, error.message);
                
                // Update batch call with error
                await pool.query(
                    'UPDATE batch_calls SET status = $1, error_message = $2, completed_at = NOW() WHERE id = $3',
                    ['failed', error.message, batchCall.id]
                );

                // Update batch counters
                await pool.query(
                    'UPDATE batches SET completed_calls = completed_calls + 1, failed_calls = failed_calls + 1 WHERE id = $1',
                    [batchId]
                );

                // Continue with next call
                continue;
            }
        }

        // Mark batch as completed
        await pool.query(
            'UPDATE batches SET status = $1 WHERE id = $2',
            ['completed', batchId]
        );

        // Broadcast batch completion
        const finalProgress = await getBatchProgress(batchId);
        io.emit('batchCompleted', {
            batchId: batchId,
            progress: finalProgress
        });

        console.log(`🎉 Batch ${batchId} completed!`);

    } catch (error) {
        console.error(`💥 Batch processing failed for ${batchId}:`, error);
        
        // Mark batch as failed
        await pool.query(
            'UPDATE batches SET status = $1 WHERE id = $2',
            ['failed', batchId]
        );
    }

    // Clear current batch
    currentBatch = null;
    
    // Process next batch in queue if any
    if (batchQueue.length > 0) {
        const nextBatchId = batchQueue.shift();
        currentBatch = nextBatchId;
        processBatch(nextBatchId);
    }
}

// Get batch progress
async function getBatchProgress(batchId) {
    const result = await pool.query(
        'SELECT * FROM batches WHERE id = $1',
        [batchId]
    );
    return result.rows[0];
}

// Parse CSV content
function parseCSV(csvContent) {
    const lines = csvContent.trim().split('\n');
    const phoneNumbers = [];
    
    // Skip header row if it exists
    const startIndex = lines[0].toLowerCase().includes('phone') ? 1 : 0;
    
    for (let i = startIndex; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line) {
            // Extract phone number (first column)
            const phoneNumber = line.split(',')[0].trim().replace(/['"]/g, '');
            if (phoneNumber && phoneNumber.length >= 10) {
                phoneNumbers.push(phoneNumber);
            }
        }
    }
    
    return phoneNumbers;
}

// Serve the main HTML page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API endpoint to initiate single outbound call
app.post('/api/calls/initiate', async (req, res) => {
    const { phoneNumber } = req.body;
    
    if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number is required' });
    }

    // Validate phone number format
    const phoneRegex = /^[\+]?[1-9][\d\s\-\(\)\.]{7,15}$/;
    const cleanedPhone = phoneNumber.replace(/[\s\-\(\)\.]/g, '');
    
    if (!phoneRegex.test(cleanedPhone)) {
        return res.status(400).json({ error: 'Invalid phone number format' });
    }

    // Format phone number
    let formattedPhone = cleanedPhone;
    if (!formattedPhone.startsWith('+')) {
        if (formattedPhone.length === 10) {
            formattedPhone = '+1' + formattedPhone;
        } else if (formattedPhone.length === 11 && formattedPhone.startsWith('1')) {
            formattedPhone = '+' + formattedPhone;
        } else {
            return res.status(400).json({ error: 'Please include country code (e.g., +1 for US numbers)' });
        }
    }

    try {
        const callResult = await initiateOutboundCall(formattedPhone);
        
        const callData = {
            id: `outbound-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            timestamp: new Date().toISOString(),
            caller_number: formattedPhone,
            called_number: 'Agent',
            duration: 0,
            status: 'initiated',
            call_type: 'outbound',
            transcript: '',
            conversation_id: callResult.conversation_id
        };

        await pool.query(`
            INSERT INTO calls (id, timestamp, caller_number, called_number, duration, status, call_type, transcript, conversation_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [callData.id, callData.timestamp, callData.caller_number, callData.called_number, 
            callData.duration, callData.status, callData.call_type, callData.transcript, callData.conversation_id]);

        io.emit('newCall', callData);

        res.json({ 
            success: true, 
            message: 'Call initiated successfully',
            callId: callData.id,
            conversationId: callResult.conversation_id
        });

    } catch (error) {
        console.error('Failed to initiate call:', error);
        res.status(500).json({ 
            error: 'Failed to initiate call', 
            details: error.message 
        });
    }
});

// API endpoint to upload CSV and create batch
app.post('/api/batch/upload', upload.single('csvFile'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No CSV file uploaded' });
        }

        const csvContent = req.file.buffer.toString('utf-8');
        const phoneNumbers = parseCSV(csvContent);

        if (phoneNumbers.length === 0) {
            return res.status(400).json({ error: 'No valid phone numbers found in CSV' });
        }

        // Create batch record
        const batchId = `batch-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const batchName = req.body.batchName || `Batch ${new Date().toLocaleDateString()}`;

        await pool.query(
            'INSERT INTO batches (id, name, total_calls) VALUES ($1, $2, $3)',
            [batchId, batchName, phoneNumbers.length]
        );

        // Create batch call records
        for (const phoneNumber of phoneNumbers) {
            const batchCallId = `bc-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            await pool.query(
                'INSERT INTO batch_calls (id, batch_id, phone_number) VALUES ($1, $2, $3)',
                [batchCallId, batchId, phoneNumber]
            );
        }

        res.json({
            success: true,
            message: `Batch created with ${phoneNumbers.length} phone numbers`,
            batchId: batchId,
            totalCalls: phoneNumbers.length
        });

    } catch (error) {
        console.error('Batch upload error:', error);
        res.status(500).json({ error: 'Failed to process CSV file' });
    }
});

// API endpoint to start batch processing
app.post('/api/batch/:batchId/start', async (req, res) => {
    const { batchId } = req.params;

    try {
        // Check if batch exists
        const batch = await pool.query('SELECT * FROM batches WHERE id = $1', [batchId]);
        if (batch.rows.length === 0) {
            return res.status(404).json({ error: 'Batch not found' });
        }

        if (batch.rows[0].status !== 'pending') {
            return res.status(400).json({ error: 'Batch has already been processed' });
        }

        // Add to queue or start immediately
        if (currentBatch === null) {
            currentBatch = batchId;
            processBatch(batchId);
        } else {
            batchQueue.push(batchId);
        }

        res.json({ 
            success: true, 
            message: currentBatch === batchId ? 'Batch processing started' : 'Batch added to queue'
        });

    } catch (error) {
        console.error('Batch start error:', error);
        res.status(500).json({ error: 'Failed to start batch processing' });
    }
});

// API endpoint to get batch status
app.get('/api/batch/:batchId', async (req, res) => {
    const { batchId } = req.params;

    try {
        const batch = await pool.query('SELECT * FROM batches WHERE id = $1', [batchId]);
        if (batch.rows.length === 0) {
            return res.status(404).json({ error: 'Batch not found' });
        }

        const calls = await pool.query(
            'SELECT * FROM batch_calls WHERE batch_id = $1 ORDER BY created_at',
            [batchId]
        );

        res.json({
            batch: batch.rows[0],
            calls: calls.rows
        });

    } catch (error) {
        console.error('Batch status error:', error);
        res.status(500).json({ error: 'Failed to get batch status' });
    }
});

// API endpoint to get all batches
app.get('/api/batches', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM batches ORDER BY created_at DESC LIMIT 10');
        res.json({ batches: result.rows });
    } catch (error) {
        console.error('Batches query error:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// Webhook endpoint - ElevenLabs will POST here
app.post('/webhook', async (req, res) => {
    console.log('Webhook received from ElevenLabs');
    
    const webhookData = req.body;
    
    // Extract transcript from the webhook
    let transcript = '';
    if (webhookData.data?.transcript && Array.isArray(webhookData.data.transcript)) {
        transcript = webhookData.data.transcript
            .map(turn => `${turn.role === 'agent' ? 'Agent' : 'Caller'}: ${turn.message}`)
            .join('\n');
    }
    
    // Extract call data
    const callData = {
        id: webhookData.data?.conversation_id || Date.now().toString(),
        timestamp: new Date().toISOString(),
        caller_number: webhookData.data?.metadata?.phone_call?.external_number || 
                      webhookData.data?.conversation_initiation_client_data?.dynamic_variables?.system__caller_id || 
                      'Unknown',
        called_number: webhookData.data?.metadata?.phone_call?.agent_number || 
                      webhookData.data?.conversation_initiation_client_data?.dynamic_variables?.system__called_number || 
                      'Unknown',
        duration: webhookData.data?.metadata?.call_duration_secs || 
                 webhookData.data?.conversation_initiation_client_data?.dynamic_variables?.system__call_duration_secs || 
                 0,
        status: 'completed',
        call_type: 'inbound',
        transcript: transcript || '',
        conversation_id: webhookData.data?.conversation_id
    };
    
    try {
        // Check if this is an outbound call we initiated
        const outboundCall = await pool.query(
            'SELECT * FROM calls WHERE conversation_id = $1 AND call_type = $2', 
            [callData.conversation_id, 'outbound']
        );
        
        if (outboundCall.rows.length > 0) {
            // Update existing outbound call
            await pool.query(`
                UPDATE calls 
                SET duration = $2, status = $3, transcript = $4, timestamp = $5
                WHERE conversation_id = $1 AND call_type = 'outbound'
            `, [callData.conversation_id, callData.duration, callData.status, callData.transcript, callData.timestamp]);
            
            const updatedCall = await pool.query('SELECT * FROM calls WHERE conversation_id = $1 AND call_type = $2', [callData.conversation_id, 'outbound']);
            if (updatedCall.rows.length > 0) {
                io.emit('updateCall', updatedCall.rows[0]);
            }
        } else {
            // Handle inbound call
            const existingCall = await pool.query('SELECT id FROM calls WHERE id = $1', [callData.id]);
            
            if (existingCall.rows.length > 0) {
                await pool.query(`
                    UPDATE calls 
                    SET caller_number = COALESCE(NULLIF($2, 'Unknown'), caller_number),
                        called_number = COALESCE(NULLIF($3, 'Unknown'), called_number),
                        duration = GREATEST($4, duration),
                        transcript = CASE WHEN LENGTH($5) > LENGTH(COALESCE(transcript, '')) THEN $5 ELSE transcript END,
                        conversation_id = COALESCE($6, conversation_id)
                    WHERE id = $1
                `, [callData.id, callData.caller_number, callData.called_number, callData.duration, callData.transcript, callData.conversation_id]);
                
                const updatedCall = await pool.query('SELECT * FROM calls WHERE id = $1', [callData.id]);
                io.emit('updateCall', updatedCall.rows[0]);
            } else {
                if (callData.caller_number !== 'Unknown' || callData.duration > 0 || callData.transcript) {
                    await pool.query(`
                        INSERT INTO calls (id, timestamp, caller_number, called_number, duration, status, call_type, transcript, conversation_id)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    `, [callData.id, callData.timestamp, callData.caller_number, callData.called_number, 
                        callData.duration, callData.status, callData.call_type, callData.transcript, callData.conversation_id]);
                    
                    await sendCallNotification(callData);
                    io.emit('newCall', callData);
                }
            }
        }
    } catch (error) {
        console.error('Database error:', error);
    }
    
    res.status(200).json({ success: true, message: 'Webhook received' });
});

// API endpoint to get call history
app.get('/api/calls', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM calls ORDER BY timestamp DESC LIMIT 50');
        res.json({ calls: result.rows });
    } catch (error) {
        console.error('Database query error:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// Health check endpoint
app.get('/health', async (req, res) => {
    try {
        const result = await pool.query('SELECT COUNT(*) FROM calls');
        res.json({ 
            status: 'healthy', 
            uptime: process.uptime(),
            callCount: result.rows[0].count,
            emailNotifications: emailConfig.enabled,
            elevenLabsConfigured: !!(ELEVENLABS_API_KEY && ELEVENLABS_AGENT_ID && ELEVENLABS_PHONE_NUMBER_ID),
            currentBatch: currentBatch,
            queueLength: batchQueue.length,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ 
            status: 'unhealthy', 
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Test ElevenLabs API connection
app.get('/test-elevenlabs', async (req, res) => {
    try {
        if (!ELEVENLABS_API_KEY) {
            return res.status(400).json({ 
                error: 'ELEVENLABS_API_KEY not configured',
                configured: {
                    apiKey: false,
                    agentId: !!ELEVENLABS_AGENT_ID,
                    phoneNumberId: !!ELEVENLABS_PHONE_NUMBER_ID
                }
            });
        }

        // Test API key by making a simple request to get voice models
        const response = await fetch('https://api.elevenlabs.io/v1/models', {
            headers: {
                'xi-api-key': ELEVENLABS_API_KEY
            }
        });

        if (!response.ok) {
            const errorData = await response.text();
            return res.status(response.status).json({
                error: 'ElevenLabs API test failed',
                status: response.status,
                details: errorData,
                configured: {
                    apiKey: !!ELEVENLABS_API_KEY,
                    agentId: !!ELEVENLABS_AGENT_ID,
                    phoneNumberId: !!ELEVENLABS_PHONE_NUMBER_ID
                }
            });
        }

        const data = await response.json();
        res.json({
            success: true,
            message: 'ElevenLabs API connection successful',
            configured: {
                apiKey: true,
                agentId: !!ELEVENLABS_AGENT_ID,
                phoneNumberId: !!ELEVENLABS_PHONE_NUMBER_ID
            },
            availableModels: data.length || 0
        });

    } catch (error) {
        res.status(500).json({
            error: 'Failed to test ElevenLabs API',
            details: error.message,
            configured: {
                apiKey: !!ELEVENLABS_API_KEY,
                agentId: !!ELEVENLABS_AGENT_ID,
                phoneNumberId: !!ELEVENLABS_PHONE_NUMBER_ID
            }
        });
    }
});

// Test email endpoint
app.post('/test-email', async (req, res) => {
    const testCallData = {
        id: 'test-' + Date.now(),
        timestamp: new Date().toISOString(),
        caller_number: '+1 (555) 123-4567',
        called_number: '+1 (555) 987-6543',
        duration: 180,
        status: 'completed',
        call_type: 'inbound',
        transcript: 'This is a test call to verify email notifications are working properly.'
    };
    
    try {
        await sendCallNotification(testCallData);
        res.json({ success: true, message: 'Test email sent successfully' });
    } catch (error) {
        console.error('Test email failed:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Socket.io connection handling
io.on('connection', async (socket) => {
    console.log('Client connected');
    
    try {
        const result = await pool.query('SELECT * FROM calls ORDER BY timestamp DESC LIMIT 50');
        socket.emit('callHistory', result.rows);
        
        // Send current batches
        const batches = await pool.query('SELECT * FROM batches ORDER BY created_at DESC LIMIT 5');
        socket.emit('batchHistory', batches.rows);
    } catch (error) {
        console.error('Error sending call history:', error);
    }
    
    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`✅ ElevenLabs Webhook Server running on port ${PORT}`);
    console.log(`📡 Webhook endpoint: http://localhost:${PORT}/webhook`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    console.log(`🏥 Health check: http://localhost:${PORT}/health`);
    console.log(`📞 Initiate call: POST http://localhost:${PORT}/api/calls/initiate`);
    console.log(`📁 Batch upload: POST http://localhost:${PORT}/api/batch/upload`);
    console.log(`🧪 Test email: POST http://localhost:${PORT}/test-email`);
    console.log(`\n🎯 Configure this webhook URL in your ElevenLabs agent settings:`);
    console.log(`   ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}/webhook`);
    console.log(`🗃️ Database: ${process.env.DATABASE_URL ? 'Connected' : 'Local/Test mode'}`);
    console.log(`📧 Email notifications: ${emailConfig.enabled ? 'Enabled (inbound only)' : 'Disabled'}`);
    console.log(`🤖 ElevenLabs API: ${ELEVENLABS_API_KEY && ELEVENLABS_AGENT_ID && ELEVENLABS_PHONE_NUMBER_ID ? 'Configured' : 'Not configured'}`);
    if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID || !ELEVENLABS_PHONE_NUMBER_ID) {
        console.log(`⚠️  Set ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, and ELEVENLABS_PHONE_NUMBER_ID environment variables to enable outbound calling`);
    }
});
