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
    
    // Check if we already have this call (by conversation ID)
    const existingIndex = callHistory.findIndex(call => call.id === callData.id);
    
    if (existingIndex >= 0) {
        // Update existing call if this one has more/better data
        const existing = callHistory[existingIndex];
        if (callData.caller_number !== 'Unknown' || callData.duration > 0 || callData.transcript) {
            console.log('Updating existing call with better data');
            callHistory[existingIndex] = {
                ...existing,
                ...callData,
                // Keep the original timestamp if it exists
                timestamp: existing.timestamp
            };
            // Broadcast updated call
            io.emit('updateCall', callHistory[existingIndex]);
        } else {
            console.log('Ignoring duplicate webhook with less data');
        }
    } else {
        // Only add if we have useful data (phone numbers, duration, or transcript)
        if (callData.caller_number !== 'Unknown' || callData.duration > 0 || callData.transcript) {
            console.log('Adding new call to history');
            // Add to call history
            callHistory.unshift(callData);
            
            // Keep only last 50 calls to prevent memory issues
            if (callHistory.length > 50) {
                callHistory = callHistory.slice(0, 50);
            }
            
            // Broadcast to all connected clients
            io.emit('newCall', callData);
        } else {
            console.log('Ignoring webhook with no useful data');
        }
    }
    
    // Respond to webhook
    res.status(200).json({ success: true, message: 'Webhook received' });
});

// API endpoint to get call history
app.get('/api/calls', (req, res) => {
    // Log what we're sending to help debug
    console.log('API call - sending', callHistory.length, 'calls');
    if (callHistory.length > 0) {
        console.log('First call transcript length:', callHistory[0].transcript ? callHistory[0].transcript.length : 0);
    }
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
