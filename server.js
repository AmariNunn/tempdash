const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Increase payload limit for ElevenLabs webhooks
app.use(express.static('public')); // Serve static files from public folder

// In-memory storage for call history (use a database in production)
let callHistory = [];

// Serve the main HTML page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Webhook endpoint - ElevenLabs will POST here
app.post('/webhook', (req, res) => {
    console.log('Webhook received:', JSON.stringify(req.body, null, 2));
    
    const webhookData = req.body;
    
    // Extract call data from ElevenLabs webhook payload
    const callData = {
        id: webhookData.data?.conversation_id || Date.now().toString(),
        timestamp: new Date().toISOString(),
        caller_number: webhookData.data?.metadata?.phone_call?.caller_number || 'Unknown',
        called_number: webhookData.data?.metadata?.phone_call?.called_number || 'Unknown',
        status: mapElevenLabsStatus(webhookData.data?.status, webhookData.type),
        agent_id: webhookData.data?.agent_id || 'Unknown',
        call_type: webhookData.data?.metadata?.conversation_initiation_source || 'unknown',
        duration: webhookData.data?.metadata?.call_duration_secs || 0,
        cost: webhookData.data?.metadata?.cost || 0,
        transcript_summary: webhookData.analysis?.transcript_summary || '',
        call_summary_title: webhookData.analysis?.call_summary_title || '',
        termination_reason: webhookData.data?.metadata?.termination_reason || '',
        main_language: webhookData.data?.metadata?.main_language || '',
        webhook_type: webhookData.type,
        // Store full data for debugging
        raw_data: webhookData
    };
    
    // Add to call history
    callHistory.unshift(callData); // Add to beginning
    
    // Keep only last 100 calls to prevent memory issues
    if (callHistory.length > 100) {
        callHistory = callHistory.slice(0, 100);
    }
    
    // Broadcast to all connected clients
    io.emit('newCall', callData);
    
    // Respond to webhook
    res.status(200).json({ success: true, message: 'Webhook received' });
});

// Helper function to map ElevenLabs status to our status
function mapElevenLabsStatus(status, webhookType) {
    if (webhookType === 'post_call_transcription') return 'completed';
    if (status === 'done') return 'completed';
    if (status === 'in_progress') return 'in_progress';
    if (status === 'failed') return 'failed';
    return status || 'unknown';
}

// API endpoint to get call history
app.get('/api/calls', (req, res) => {
    res.json({ calls: callHistory });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        uptime: process.uptime(),
        callCount: callHistory.length,
        timestamp: new Date().toISOString()
    });
});

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('Client connected');
    
    // Send current call history to new client
    socket.emit('callHistory', callHistory);
    
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
    console.log(`\n🎯 Configure this webhook URL in your ElevenLabs agent settings:`);
    console.log(`   ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}/webhook`);
});
