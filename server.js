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
app.use(express.json());
app.use(express.static('public')); // Serve static files from public folder

// In-memory storage for call history (use a database in production)
let callHistory = [];

// Serve the main HTML page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Webhook endpoint - ElevenLabs will POST here
app.post('/webhook', (req, res) => {
    console.log('Webhook received:', req.body);
    
    const callData = {
        id: req.body.call_id || Date.now().toString(),
        timestamp: new Date().toISOString(),
        caller_number: req.body.caller_number || 'Unknown',
        called_number: req.body.called_number || 'Unknown',
        status: req.body.status || 'initiated',
        agent_id: req.body.agent_id || 'Unknown',
        call_type: req.body.call_type || 'unknown',
        duration: req.body.duration || 0,
        // Add any other fields from ElevenLabs webhook
        raw_data: req.body
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