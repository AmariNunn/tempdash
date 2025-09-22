const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { Pool } = require('pg');
const { MailerSend, EmailParams, Sender, Recipient } = require("mailersend");

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// MailerSend configuration
const mailerSend = new MailerSend({
    apiKey: process.env.MAILERSEND_API_KEY,
});

// Email notification configuration
const emailConfig = {
    enabled: process.env.EMAIL_NOTIFICATIONS !== 'false', // Default to true
    fromEmail: process.env.MAILERSEND_FROM_EMAIL || 'notifications@yourdomain.com',
    fromName: 'SkyIQ Dashboard',
    toEmail: process.env.NOTIFICATION_EMAIL,
    toName: 'SkyIQ User'
};

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Increase payload limit for ElevenLabs webhooks
app.use(express.static('public')); // Serve static files from public folder

// Database setup
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:password@localhost:5432/elevenlabs_calls',
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

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

// Email notification function using MailerSend
async function sendCallNotification(callData) {
    // Skip if email notifications are disabled or missing configuration
    if (!emailConfig.enabled || !emailConfig.toEmail || !process.env.MAILERSEND_API_KEY) {
        if (!process.env.MAILERSEND_API_KEY) {
            console.log('📧 Email notifications skipped - MAILERSEND_API_KEY not configured');
        } else if (!emailConfig.toEmail) {
            console.log('📧 Email notifications skipped - NOTIFICATION_EMAIL not configured');
        } else {
            console.log('📧 Email notifications disabled via EMAIL_NOTIFICATIONS=false');
        }
        return;
    }

    const sentFrom = new Sender(emailConfig.fromEmail, emailConfig.fromName);
    const recipients = [new Recipient(emailConfig.toEmail, emailConfig.toName)];

    const emailParams = new EmailParams()
        .setFrom(sentFrom)
        .setTo(recipients)
        .setSubject(`📞 New Call from ${callData.caller_number} - SkyIQ`)
        .setHtml(`
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff;">
                <!-- Header -->
                <div style="background: linear-gradient(135deg, #4f46e5, #06b6d4); padding: 30px 20px; text-align: center; color: white; border-radius: 12px 12px 0 0;">
                    <div style="display: inline-block; background: rgba(255,255,255,0.2); padding: 12px; border-radius: 50%; margin-bottom: 15px; font-size: 24px;">
                        📞
                    </div>
                    <h1 style="margin: 0 0 8px 0; font-size: 28px; font-weight: 700;">New Call Received</h1>
                    <p style="margin: 0; opacity: 0.9; font-size: 16px;">SkyIQ Dashboard Notification</p>
                </div>
                
                <!-- Content -->
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
                                <td style="padding: 12px 0; font-weight: 600; color: #4f46e5; vertical-align: top;">🕒 Time:</td>
                                <td style="padding: 12px 0; color: #1e293b;">${new Date(callData.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}</td>
                            </tr>
                            <tr style="border-top: 1px solid #e2e8f0;">
                                <td style="padding: 12px 0; font-weight: 600; color: #4f46e5; vertical-align: top;">⏱️ Duration:</td>
                                <td style="padding: 12px 0; color: #1e293b;">${formatDuration(callData.duration)}</td>
                            </tr>
                            <tr style="border-top: 1px solid #e2e8f0;">
                                <td style="padding: 12px 0; font-weight: 600; color: #4f46e5; vertical-align: top;">✅ Status:</td>
                                <td style="padding: 12px 0;">
                                    <span style="background: linear-gradient(135deg, #dcfce7, #bbf7d0); color: #166534; padding: 6px 12px; border-radius: 16px; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">
                                        ${callData.status}
                                    </span>
                                </td>
                            </tr>
                        </table>
                    </div>
                    
                    ${callData.transcript ? `
                        <h3 style="color: #1e293b; margin: 0 0 15px 0; font-size: 18px; font-weight: 600;">📝 Transcript Preview</h3>
                        <div style="background: white; padding: 20px; border-radius: 12px; border-left: 4px solid #4f46e5; box-shadow: 0 2px 8px rgba(0,0,0,0.08); margin-bottom: 25px;">
                            <div style="font-style: italic; color: #475569; line-height: 1.6; font-size: 15px;">
                                "${callData.transcript.substring(0, 400)}${callData.transcript.length > 400 ? '...' : ''}"
                            </div>
                            ${callData.transcript.length > 400 ? '<p style="margin: 15px 0 0 0; color: #64748b; font-size: 13px;"><em>View full transcript in dashboard</em></p>' : ''}
                        </div>
                    ` : `
                        <div style="background: #fef3c7; border: 1px solid #f59e0b; color: #92400e; padding: 15px; border-radius: 8px; text-align: center; margin-bottom: 25px;">
                            <strong>⚠️ No transcript available</strong><br>
                            <small style="opacity: 0.8;">The call may still be processing or no transcript was generated.</small>
                        </div>
                    `}
                    
                    <!-- CTA Button -->
                    <div style="text-align: center; margin-top: 30px;">
                        <a href="${process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000'}" 
                           style="display: inline-block; background: linear-gradient(135deg, #4f46e5, #7c3aed); color: white; padding: 15px 30px; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 12px rgba(79, 70, 229, 0.3);">
                            🖥️ View Full Dashboard
                        </a>
                    </div>
                </div>
                
                <!-- Footer -->
                <div style="text-align: center; padding: 20px; background: #f1f5f9; border-radius: 0 0 12px 12px; border-top: 1px solid #e2e8f0;">
                    <p style="margin: 0; color: #64748b; font-size: 14px;">
                        🤖 This is an automated notification from your SkyIQ webhook server
                    </p>
                    <p style="margin: 8px 0 0 0; color: #94a3b8; font-size: 12px;">
                        Powered by MailerSend • ${new Date().toISOString()}
                    </p>
                </div>
            </div>
        `)
        .setText(`
🔔 New Call Received - SkyIQ Dashboard

📞 Call Details:
• Phone Number: ${callData.caller_number}
• Date: ${new Date(callData.timestamp).toLocaleDateString()}
• Time: ${new Date(callData.timestamp).toLocaleTimeString()}
• Duration: ${formatDuration(callData.duration)}
• Status: ${callData.status}

📝 Transcript Preview:
${callData.transcript ? callData.transcript.substring(0, 300) + '...' : 'No transcript available'}

🖥️ View full details at: ${process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000'}

---
This is an automated notification from your SkyIQ webhook server.
        `);

    try {
        const response = await mailerSend.email.send(emailParams);
        console.log('📧 MailerSend notification sent successfully:', response.body?.message_id || 'OK');
    } catch (error) {
        console.error('❌ MailerSend notification failed:', error.message);
        if (error.body) {
            console.error('Error details:', JSON.stringify(error.body, null, 2));
        }
    }
}

// Initialize database table
async function initializeDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS calls (
                id VARCHAR(255) PRIMARY KEY,
                timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                caller_number VARCHAR(50),
                called_number VARCHAR(50),
                duration INTEGER DEFAULT 0,
                status VARCHAR(50) DEFAULT 'completed',
                call_type VARCHAR(50) DEFAULT 'phone',
                transcript TEXT,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )
        `);
        console.log('Database table initialized successfully');
    } catch (error) {
        console.error('Database initialization error:', error);
    }
}

// Call database initialization
initializeDatabase();

// Serve the main HTML page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
    
    // Extract only essential call data - simplified
    const callData = {
        id: webhookData.data?.conversation_id || Date.now().toString(),
        timestamp: new Date().toISOString(),
        // Extract phone numbers from the correct path
        caller_number: webhookData.data?.metadata?.phone_call?.external_number || 
                      webhookData.data?.conversation_initiation_client_data?.dynamic_variables?.system__caller_id || 
                      'Unknown',
        called_number: webhookData.data?.metadata?.phone_call?.agent_number || 
                      webhookData.data?.conversation_initiation_client_data?.dynamic_variables?.system__called_number || 
                      'Unknown',
        // Call duration in seconds
        duration: webhookData.data?.metadata?.call_duration_secs || 
                 webhookData.data?.conversation_initiation_client_data?.dynamic_variables?.system__call_duration_secs || 
                 0,
        status: 'completed',
        call_type: 'phone',
        transcript: transcript || ''
    };
    
    // Log the actual transcript for debugging
    console.log('Processed call data:', {
        id: callData.id,
        duration: callData.duration,
        transcript_length: transcript.length,
        transcript_preview: transcript.substring(0, 100) + (transcript.length > 100 ? '...' : '')
    });
    
    try {
        // Check if call already exists in database
        const existingCall = await pool.query('SELECT id FROM calls WHERE id = $1', [callData.id]);
        
        if (existingCall.rows.length > 0) {
            // Update existing call if this one has more/better data
            if (callData.caller_number !== 'Unknown' || callData.duration > 0 || callData.transcript) {
                console.log('Updating existing call with better data');
                await pool.query(`
                    UPDATE calls 
                    SET caller_number = COALESCE(NULLIF($2, 'Unknown'), caller_number),
                        called_number = COALESCE(NULLIF($3, 'Unknown'), called_number),
                        duration = GREATEST($4, duration),
                        transcript = CASE WHEN LENGTH($5) > LENGTH(COALESCE(transcript, '')) THEN $5 ELSE transcript END
                    WHERE id = $1
                `, [callData.id, callData.caller_number, callData.called_number, callData.duration, callData.transcript]);
                
                // Get updated call and broadcast
                const updatedCall = await pool.query('SELECT * FROM calls WHERE id = $1', [callData.id]);
                io.emit('updateCall', updatedCall.rows[0]);
            } else {
                console.log('Ignoring duplicate webhook with less data');
            }
        } else {
            // Only add if we have useful data (phone numbers, duration, or transcript)
            if (callData.caller_number !== 'Unknown' || callData.duration > 0 || callData.transcript) {
                console.log('Adding new call to database');
                
                await pool.query(`
                    INSERT INTO calls (id, timestamp, caller_number, called_number, duration, status, call_type, transcript)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                `, [callData.id, callData.timestamp, callData.caller_number, callData.called_number, 
                    callData.duration, callData.status, callData.call_type, callData.transcript]);
                
                // 🔥 SEND EMAIL NOTIFICATION FOR NEW CALLS
                await sendCallNotification(callData);
                
                // Broadcast to all connected clients
                io.emit('newCall', callData);
            } else {
                console.log('Ignoring webhook with no useful data');
            }
        }
    } catch (error) {
        console.error('Database error:', error);
    }
    
    // Respond to webhook
    res.status(200).json({ success: true, message: 'Webhook received' });
});

// API endpoint to get call history
app.get('/api/calls', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM calls ORDER BY timestamp DESC LIMIT 50');
        console.log('API call - sending', result.rows.length, 'calls');
        if (result.rows.length > 0) {
            console.log('First call transcript length:', result.rows[0].transcript ? result.rows[0].transcript.length : 0);
        }
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

// Test email endpoint (useful for testing)
app.post('/test-email', async (req, res) => {
    const testCallData = {
        id: 'test-' + Date.now(),
        timestamp: new Date().toISOString(),
        caller_number: '+1 (555) 123-4567',
        called_number: '+1 (555) 987-6543',
        duration: 180,
        status: 'completed',
        call_type: 'phone',
        transcript: 'This is a test call to verify email notifications are working properly. The system should send this email with all the formatting and styling intact.'
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
        // Send current call history to new client from database
        const result = await pool.query('SELECT * FROM calls ORDER BY timestamp DESC LIMIT 50');
        socket.emit('callHistory', result.rows);
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
    console.log(`🧪 Test email: POST http://localhost:${PORT}/test-email`);
    console.log(`\n🎯 Configure this webhook URL in your ElevenLabs agent settings:`);
    console.log(`   ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}/webhook`);
    console.log(`🗃️ Database: ${process.env.DATABASE_URL ? 'Connected' : 'Local/Test mode'}`);
    console.log(`📧 Email notifications: ${emailConfig.enabled ? 'Enabled' : 'Disabled'}`);
    if (emailConfig.enabled) {
        console.log(`   From: ${emailConfig.fromEmail}`);
        console.log(`   To: ${emailConfig.toEmail || 'Not configured'}`);
        console.log(`   API Key: ${process.env.MAILERSEND_API_KEY ? 'Configured' : 'Missing'}`);
    }
});
