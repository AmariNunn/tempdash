const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { Pool } = require('pg');
const { MailerSend, EmailParams, Sender, Recipient } = require("mailersend");
const multer = require('multer');
const { v4: uuidv4 } = require('uuid'); // Added UUID

// Import route handlers
const callRoutes = require('./routes/calls');
const promptRoutes = require('./routes/prompts');
const batchRoutes = require('./routes/batches');
const webhookRoutes = require('./routes/webhooks');
const testRoutes = require('./routes/tests');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Configure multer for file uploads
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// Configuration
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const ELEVENLABS_PHONE_NUMBER_ID = process.env.ELEVENLABS_PHONE_NUMBER_ID;
const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1/convai/twilio/outbound-call';
const ELEVENLABS_AGENTS_URL = 'https://api.elevenlabs.io/v1/convai/agents';

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

// Database setup
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:password@localhost:5432/elevenlabs_calls',
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Global state
const appState = {
    currentBatch: null,
    batchQueue: [],
    io: io,
    pool: pool,
    elevenLabsConfig: {
        apiKey: ELEVENLABS_API_KEY,
        agentId: ELEVENLABS_AGENT_ID,
        phoneNumberId: ELEVENLABS_PHONE_NUMBER_ID,
        apiUrl: ELEVENLABS_API_URL,
        agentsUrl: ELEVENLABS_AGENTS_URL
    },
    emailConfig: emailConfig,
    mailerSend: mailerSend
};

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Inject appState into request object
app.use((req, res, next) => {
    req.appState = appState;
    next();
});

// Routes
app.use('/api/calls', callRoutes);
app.use('/api/prompt', promptRoutes);
app.use('/api/batch', batchRoutes);
app.use('/webhook', webhookRoutes);
app.use('/test', testRoutes);

// Serve the main HTML page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
            currentBatch: appState.currentBatch,
            queueLength: appState.batchQueue.length,
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

// Email notification function
async function sendCallNotification(callData, mailerSend, emailConfig) {
    if (!emailConfig.enabled || !emailConfig.toEmail || !mailerSend || callData.call_type === 'outbound') {
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

// Function to initiate outbound call via ElevenLabs API
async function initiateOutboundCall(phoneNumber, elevenLabsConfig) {
    if (!elevenLabsConfig.apiKey || !elevenLabsConfig.agentId || !elevenLabsConfig.phoneNumberId) {
        throw new Error('ElevenLabs configuration incomplete. Please set ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, and ELEVENLABS_PHONE_NUMBER_ID environment variables.');
    }

    try {
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

// Initialize database and start server
async function startServer() {
    try {
        await initializeDatabase(pool);
        
        const PORT = process.env.PORT || 3000;
        server.listen(PORT, () => {
            console.log(`✅ SkyIQ Dashboard Server running on port ${PORT}`);
            console.log(`📡 Webhook endpoint: http://localhost:${PORT}/webhook`);
            console.log(`📊 Dashboard: http://localhost:${PORT}`);
            console.log(`🏥 Health check: http://localhost:${PORT}/health`);
            console.log(`\n🎯 Configure this webhook URL in your ElevenLabs agent settings:`);
            console.log(`   ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}/webhook`);
            console.log(`🗃️ Database: ${process.env.DATABASE_URL ? 'Connected' : 'Local/Test mode'}`);
            console.log(`📧 Email notifications: ${emailConfig.enabled ? 'Enabled (inbound only)' : 'Disabled'}`);
            console.log(`🤖 ElevenLabs API: ${ELEVENLABS_API_KEY && ELEVENLABS_AGENT_ID && ELEVENLABS_PHONE_NUMBER_ID ? 'Configured' : 'Not configured'}`);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

// Initialize database tables
async function initializeDatabase(pool) {
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
            await pool.query(`ALTER TABLE calls ADD COLUMN conversation_id VARCHAR(255)`);
            console.log('✅ conversation_id column added successfully');
        }

        // Create prompts table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS prompts (
                id SERIAL PRIMARY KEY,
                system_prompt TEXT,
                first_message TEXT,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )
        `);

        // Insert default prompt if none exists
        const existingPrompt = await pool.query('SELECT COUNT(*) FROM prompts');
        if (existingPrompt.rows[0].count === '0') {
            await pool.query(`
                INSERT INTO prompts (system_prompt, first_message) VALUES ($1, $2)
            `, [getDefaultPrompt(), "Hello! This is Andy from SkyIQ. Thanks for taking my call. How are you doing today?"]);
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
                first_name VARCHAR(100),
                last_name VARCHAR(100),
                company VARCHAR(200),
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
        throw error;
    }
}

function getDefaultPrompt() {
    return `You are Andy, a professional AI voice agent for SkyIQ, specializing in AI voice solutions and customer service automation.

**Your Role:**
- Handle both inbound customer inquiries and outbound sales calls
- Provide expert guidance on AI voice technology
- Maintain a professional, helpful, and engaging demeanor
- Focus on understanding customer needs and providing valuable solutions

**For Inbound Calls:**
- Greet warmly: "Thank you for calling SkyIQ! This is Andy. How can I help you today?"
- Listen actively to understand their specific needs
- Ask clarifying questions to better serve them
- Provide detailed information about SkyIQ's AI voice solutions
- Collect contact information when appropriate
- Always end with clear next steps and follow-up commitments

**For Outbound Calls:**
- Introduce yourself: "Hi, this is Andy calling from SkyIQ. Is this [Customer Name]?"
- Ask for permission: "Do you have a moment to discuss how AI voice technology could benefit your business?"
- Clearly explain the purpose of your call
- Focus on how SkyIQ's solutions can solve their specific challenges
- Schedule demos or follow-up meetings when appropriate

**Key Topics You Can Discuss:**
- AI voice agent implementation and benefits
- Automated customer service solutions
- Sales call automation and lead qualification
- Custom voice application development
- Integration with existing business systems
- ROI and cost savings from AI voice solutions
- Technical specifications and requirements

**Conversation Guidelines:**
- Keep responses conversational and concise (1-2 sentences typically)
- Show genuine interest in their business challenges
- Use examples and case studies when relevant
- Handle objections professionally and with empathy
- If you don't know something specific, offer to connect them with a specialist
- Always maintain confidence in SkyIQ's capabilities while being honest about limitations

**Data Collection Priority:**
- Company name and industry
- Current communication/customer service challenges
- Contact information (name, email, phone)
- Decision-making timeline
- Budget considerations (when appropriate)

Remember: Every conversation is an opportunity to build trust and demonstrate SkyIQ's commitment to solving real business problems with advanced AI voice technology.`;
}

startServer();
