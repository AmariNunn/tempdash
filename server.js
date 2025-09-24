const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { Pool } = require('pg');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Database setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://user:password@localhost:5432/elevenlabs_calls',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database tables
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
        call_type VARCHAR(50) DEFAULT 'inbound',
        transcript TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS prompts (
        id SERIAL PRIMARY KEY,
        prompt TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    console.log('✅ Database tables initialized');
  } catch (error) {
    console.error('Database initialization error:', error);
  }
}
initializeDatabase();

// Serve the main HTML page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- PROMPT ENDPOINTS ---
app.get('/api/prompt', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM prompts ORDER BY updated_at DESC LIMIT 1');
    if (result.rows.length === 0) {
      return res.json({ prompt: '' });
    }
    res.json({ prompt: result.rows[0].prompt });
  } catch (error) {
    console.error('Error fetching prompt:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/prompt', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  try {
    const existingPrompt = await pool.query('SELECT id FROM prompts ORDER BY updated_at DESC LIMIT 1');
    if (existingPrompt.rows.length > 0) {
      await pool.query(
        `UPDATE prompts SET prompt = $1, updated_at = NOW() WHERE id = $2`,
        [prompt, existingPrompt.rows[0].id]
      );
    } else {
      await pool.query(`INSERT INTO prompts (prompt) VALUES ($1)`, [prompt]);
    }
    res.json({ success: true, prompt });
  } catch (error) {
    console.error('Error updating prompt:', error);
    res.status(500).json({ error: 'Failed to update prompt' });
  }
});

// --- CALLS ENDPOINT (basic example) ---
app.get('/api/calls', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM calls ORDER BY timestamp DESC LIMIT 50');
    res.json({ calls: result.rows });
  } catch (error) {
    console.error('Database query error:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Webhook endpoint stub
app.post('/webhook', async (req, res) => {
  console.log('Webhook received:', req.body);
  io.emit('updateCall', req.body);
  res.json({ success: true });
});

// Socket.io connection
io.on('connection', async (socket) => {
  console.log('Client connected');
  try {
    const result = await pool.query('SELECT * FROM calls ORDER BY timestamp DESC LIMIT 50');
    socket.emit('callHistory', result.rows);
  } catch (error) {
    console.error('Error sending call history:', error);
  }
  socket.on('disconnect', () => console.log('Client disconnected'));
});

// Health check
app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) FROM calls');
    res.json({ status: 'healthy', callCount: result.rows[0].count });
  } catch (error) {
    res.status(500).json({ status: 'unhealthy', error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
