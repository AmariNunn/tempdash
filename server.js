const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { Pool } = require('pg');
const { MailerSend, EmailParams, Sender, Recipient } = require("mailersend");
const multer = require('multer');
const cheerio = require('cheerio');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const fs = require('fs');
const path = require('path');
//const puppeteer = require('puppeteer');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Configure multer for file uploads
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit for documents
});

// ElevenLabs API configuration
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const ELEVENLABS_PHONE_NUMBER_ID = process.env.ELEVENLABS_PHONE_NUMBER_ID;
const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1/convai/twilio/outbound-call';
const ELEVENLABS_AGENT_UPDATE_URL = 'https://api.elevenlabs.io/v1/convai/agents';

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

// Web scraping configuration
const scrapingConfig = {
    maxContentLength: 50000, // Maximum content length per URL
    timeout: 30000, // 30 second timeout
    maxConcurrentScrapes: 3, // Maximum concurrent scraping operations
    userAgent: 'SkyIQ-Bot/1.0 (+https://skyiq.ai/bot)',
    retryAttempts: 2
};

// Document parsing configuration
const documentConfig = {
    maxContentLength: 100000, // Maximum content length per document
    supportedTypes: {
        'application/pdf': 'pdf',
        'text/plain': 'txt',
        'application/msword': 'doc',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        'application/rtf': 'rtf',
        'text/markdown': 'md'
    },
    maxFileSize: 10 * 1024 * 1024 // 10MB
};

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Database setup
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:password@localhost:5432/skyiq_calls',
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Global batch processing state
let currentBatch = null;
let batchQueue = [];
let scrapingQueue = [];
let activeScrapes = 0;

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

// Text cleaning and extraction utilities
function cleanText(text) {
    return text
        .replace(/\s+/g, ' ') // Replace multiple spaces with single space
        .replace(/\n\s*\n/g, '\n') // Remove empty lines
        .replace(/[^\w\s\.,!?;:()\-'"]/g, '') // Remove special characters except basic punctuation
        .trim()
        .substring(0, scrapingConfig.maxContentLength);
}

function extractMainContent($) {
    // Remove unwanted elements
    $('script, style, nav, header, footer, aside, .advertisement, .ad, .sidebar, .menu').remove();
    
    // Try to find main content areas
    const contentSelectors = [
        'main',
        '[role="main"]',
        '.main-content',
        '.content',
        'article',
        '.post-content',
        '.entry-content',
        '.page-content',
        '#content',
        '#main'
    ];
    
    for (const selector of contentSelectors) {
        const element = $(selector);
        if (element.length && element.text().trim().length > 200) {
            return cleanText(element.text());
        }
    }
    
    // Fallback to body content
    return cleanText($('body').text());
}

// Web scraping function with multiple strategies
async function scrapeWebsite(url) {
    console.log(`🕷️ Starting scrape for: ${url}`);
    
    let browser;
    let lastError;
    
    for (let attempt = 1; attempt <= scrapingConfig.retryAttempts; attempt++) {
        try {
            // Strategy 1: Try simple fetch with Cheerio first
            if (attempt === 1) {
                console.log(`🔍 Attempt ${attempt}: Using fetch + Cheerio for ${url}`);
                
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), scrapingConfig.timeout);
                
                const response = await fetch(url, {
                    headers: {
                        'User-Agent': scrapingConfig.userAgent,
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.5',
                        'Accept-Encoding': 'gzip, deflate',
                        'Connection': 'keep-alive',
                        'Upgrade-Insecure-Requests': '1'
                    },
                    signal: controller.signal,
                    timeout: scrapingConfig.timeout
                });
                
                clearTimeout(timeoutId);
                
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
                
                const html = await response.text();
                const $ = cheerio.load(html);
                const content = extractMainContent($);
                
                if (content.length < 100) {
                    throw new Error('Content too short, trying browser method');
                }
                
                console.log(`✅ Successfully scraped ${url} with Cheerio (${content.length} chars)`);
                return {
                    content,
                    method: 'cheerio',
                    contentLength: content.length,
                    title: $('title').text().trim() || 'Untitled'
                };
            }
            
            // Strategy 2: Use Puppeteer for JavaScript-heavy sites
            console.log(`🤖 Attempt ${attempt}: Using Puppeteer for ${url}`);
            
            browser = await puppeteer.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--single-process',
                    '--disable-gpu'
                ]
            });
            
            const page = await browser.newPage();
            
            // Set user agent and viewport
            await page.setUserAgent(scrapingConfig.userAgent);
            await page.setViewport({ width: 1366, height: 768 });
            
            // Block unnecessary resources to speed up loading
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                const resourceType = req.resourceType();
                if (['image', 'font', 'media'].includes(resourceType)) {
                    req.abort();
                } else {
                    req.continue();
                }
            });
            
            // Navigate to the page
            await page.goto(url, {
                waitUntil: 'networkidle0',
                timeout: scrapingConfig.timeout
            });
            
            // Wait a bit for dynamic content to load
            await page.waitForTimeout(2000);
            
            // Extract content
            const result = await page.evaluate(() => {
                // Remove unwanted elements
                const unwantedSelectors = [
                    'script', 'style', 'nav', 'header', 'footer', 'aside',
                    '.advertisement', '.ad', '.sidebar', '.menu', '.popup',
                    '.modal', '.overlay', '.cookie-banner'
                ];
                
                unwantedSelectors.forEach(selector => {
                    const elements = document.querySelectorAll(selector);
                    elements.forEach(el => el.remove());
                });
                
                // Try to find main content
                const contentSelectors = [
                    'main', '[role="main"]', '.main-content', '.content',
                    'article', '.post-content', '.entry-content', '.page-content',
                    '#content', '#main'
                ];
                
                let content = '';
                const title = document.title || 'Untitled';
                
                for (const selector of contentSelectors) {
                    const element = document.querySelector(selector);
                    if (element && element.innerText.trim().length > 200) {
                        content = element.innerText.trim();
                        break;
                    }
                }
                
                // Fallback to body content
                if (!content) {
                    content = document.body.innerText.trim();
                }
                
                return { content, title };
            });
            
            await browser.close();
            browser = null;
            
            const cleanedContent = cleanText(result.content);
            
            if (cleanedContent.length < 100) {
                throw new Error('Extracted content too short');
            }
            
            console.log(`✅ Successfully scraped ${url} with Puppeteer (${cleanedContent.length} chars)`);
            return {
                content: cleanedContent,
                method: 'puppeteer',
                contentLength: cleanedContent.length,
                title: result.title
            };
            
        } catch (error) {
            lastError = error;
            console.log(`❌ Attempt ${attempt} failed for ${url}: ${error.message}`);
            
            if (browser) {
                try {
                    await browser.close();
                } catch (closeError) {
                    console.error('Error closing browser:', closeError);
                }
                browser = null;
            }
            
            if (attempt < scrapingConfig.retryAttempts) {
                console.log(`⏳ Waiting before retry ${attempt + 1}...`);
                await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
            }
        }
    }
    
    throw new Error(`Failed to scrape ${url} after ${scrapingConfig.retryAttempts} attempts. Last error: ${lastError.message}`);
}

// Queue-based scraping to prevent overload
async function processScrapeQueue() {
    while (scrapingQueue.length > 0 && activeScrapes < scrapingConfig.maxConcurrentScrapes) {
        const { url, resolve, reject } = scrapingQueue.shift();
        activeScrapes++;
        
        scrapeWebsite(url)
            .then(result => {
                activeScrapes--;
                resolve(result);
                processScrapeQueue(); // Process next in queue
            })
            .catch(error => {
                activeScrapes--;
                reject(error);
                processScrapeQueue(); // Process next in queue
            });
    }
}

function queueScrape(url) {
    return new Promise((resolve, reject) => {
        scrapingQueue.push({ url, resolve, reject });
        processScrapeQueue();
    });
}

// Document parsing functions
async function parseDocument(file) {
    console.log(`📄 Parsing document: ${file.originalname} (${file.mimetype})`);
    
    const fileType = documentConfig.supportedTypes[file.mimetype];
    if (!fileType) {
        throw new Error(`Unsupported file type: ${file.mimetype}`);
    }

    if (file.size > documentConfig.maxFileSize) {
        throw new Error(`File too large: ${file.size} bytes (max: ${documentConfig.maxFileSize})`);
    }

    let content = '';
    let title = file.originalname;

    try {
        switch (fileType) {
            case 'pdf':
                const pdfData = await pdf(file.buffer);
                content = pdfData.text;
                title = pdfData.info?.Title || file.originalname;
                break;

            case 'txt':
            case 'md':
                content = file.buffer.toString('utf-8');
                break;

            case 'docx':
                const docxResult = await mammoth.extractRawText({ buffer: file.buffer });
                content = docxResult.value;
                if (docxResult.messages.length > 0) {
                    console.log('Mammoth warnings:', docxResult.messages);
                }
                break;

            case 'doc':
                // For .doc files, we'll try to extract as much as possible
                // This is a basic implementation - you might want to use a more robust library
                content = file.buffer.toString('utf-8');
                // Remove binary data and extract readable text
                content = content.replace(/[^\x20-\x7E\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim();
                break;

            case 'rtf':
                // Basic RTF parsing - remove RTF formatting codes
                content = file.buffer.toString('utf-8');
                content = content.replace(/\{[^}]*\}/g, '').replace(/\\[a-z]+\d*\s?/g, ' ').replace(/\s+/g, ' ').trim();
                break;

            default:
                throw new Error(`Unsupported file type: ${fileType}`);
        }

        // Clean and validate content
        content = cleanText(content);
        
        if (content.length < 50) {
            throw new Error('Document appears to be empty or contains very little text');
        }

        if (content.length > documentConfig.maxContentLength) {
            content = content.substring(0, documentConfig.maxContentLength) + '...';
        }

        console.log(`✅ Successfully parsed ${file.originalname} (${content.length} characters)`);
        
        return {
            content,
            title: title || file.originalname,
            contentLength: content.length,
            fileType: fileType,
            originalName: file.originalname
        };

    } catch (error) {
        console.error(`❌ Error parsing ${file.originalname}:`, error);
        throw new Error(`Failed to parse document: ${error.message}`);
    }
}

// Email notification function using MailerSend (updated with SkyIQ branding)
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
                <div style="background: linear-gradient(135deg, #009AEE, #0080CC); padding: 30px 20px; text-align: center; color: white; border-radius: 12px 12px 0 0;">
                    <div style="display: inline-block; background: rgba(255,255,255,0.2); padding: 12px; border-radius: 50%; margin-bottom: 15px; font-size: 24px;">📞</div>
                    <h1 style="margin: 0 0 8px 0; font-size: 28px; font-weight: 700;">New Inbound Call</h1>
                    <p style="margin: 0; opacity: 0.9; font-size: 16px;">SkyIQ Dashboard Notification</p>
                </div>
                
                <div style="padding: 30px 20px; background: #f8fafc;">
                    <h2 style="color: #1e293b; margin: 0 0 20px 0; font-size: 20px; font-weight: 600;">📋 Call Details</h2>
                    
                    <div style="background: white; border-radius: 12px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); margin-bottom: 25px;">
                        <table style="width: 100%; border-collapse: collapse;">
                            <tr>
                                <td style="padding: 12px 0; font-weight: 600; color: #009AEE; width: 130px; vertical-align: top;">📞 Phone:</td>
                                <td style="padding: 12px 0; font-family: 'SF Mono', Monaco, monospace; font-size: 16px; color: #1e293b;">${callData.caller_number}</td>
                            </tr>
                            <tr style="border-top: 1px solid #e2e8f0;">
                                <td style="padding: 12px 0; font-weight: 600; color: #009AEE; vertical-align: top;">📅 Date:</td>
                                <td style="padding: 12px 0; color: #1e293b;">${new Date(callData.timestamp).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</td>
                            </tr>
                            <tr style="border-top: 1px solid #e2e8f0;">
                                <td style="padding: 12px 0; font-weight: 600; color: #009AEE; vertical-align: top;">⏱️ Duration:</td>
                                <td style="padding: 12px 0; color: #1e293b;">${formatDuration(callData.duration)}</td>
                            </tr>
                        </table>
                    </div>
                    
                    <div style="text-align: center; margin-top: 30px;">
                        <a href="${process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000'}" 
                           style="display: inline-block; background: linear-gradient(135deg, #009AEE, #0080CC); color: white; padding: 15px 30px; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 12px rgba(0, 154, 238, 0.3);">
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
                conversation_id VARCHAR(255),
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )
        `);

        // Create scraped_data table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS scraped_data (
                id VARCHAR(255) PRIMARY KEY,
                url TEXT NOT NULL,
                title VARCHAR(500),
                content TEXT NOT NULL,
                content_length INTEGER DEFAULT 0,
                scraping_method VARCHAR(50),
                scraped_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                status VARCHAR(50) DEFAULT 'active',
                error_message TEXT
            )
        `);

        // Create parsed_documents table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS parsed_documents (
                id VARCHAR(255) PRIMARY KEY,
                filename VARCHAR(500) NOT NULL,
                original_name VARCHAR(500) NOT NULL,
                title VARCHAR(500),
                content TEXT NOT NULL,
                content_length INTEGER DEFAULT 0,
                file_type VARCHAR(50),
                file_size INTEGER DEFAULT 0,
                parsed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                status VARCHAR(50) DEFAULT 'active',
                error_message TEXT
            )
        `);

        // Create agent_prompts table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS agent_prompts (
                id SERIAL PRIMARY KEY,
                system_prompt TEXT NOT NULL,
                first_message TEXT,
                includes_scraped_data BOOLEAN DEFAULT false,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                is_current BOOLEAN DEFAULT true
            )
        `);

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

        console.log('✅ Database tables initialized successfully');
    } catch (error) {
        console.error('❌ Database initialization error:', error);
    }
}

initializeDatabase();

// Function to update ElevenLabs agent prompt
async function updateElevenLabsPrompt(systemPrompt, firstMessage = '') {
    if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
        throw new Error('ElevenLabs configuration incomplete');
    }

    try {
        const response = await fetch(`${ELEVENLABS_AGENT_UPDATE_URL}/${ELEVENLABS_AGENT_ID}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'xi-api-key': ELEVENLABS_API_KEY
            },
            body: JSON.stringify({
                prompt: {
                    prompt: systemPrompt,
                    ...(firstMessage && { first_message: firstMessage })
                }
            })
        });

        if (!response.ok) {
            const errorData = await response.text();
            throw new Error(`ElevenLabs API error: ${response.status} - ${errorData}`);
        }

        const result = await response.json();
        console.log('✅ ElevenLabs agent prompt updated successfully');
        return result;

    } catch (error) {
        console.error('❌ Failed to update ElevenLabs prompt:', error);
        throw error;
    }
}

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

// API endpoint for web scraping
app.post('/api/scrape', async (req, res) => {
    const { url } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    try {
        // Validate URL
        const urlObj = new URL(url);
        if (!['http:', 'https:'].includes(urlObj.protocol)) {
            return res.status(400).json({ error: 'Only HTTP and HTTPS URLs are supported' });
        }

        console.log(`🕷️ Scraping request for: ${url}`);

        // Check if URL was recently scraped
        const existingScrape = await pool.query(
            'SELECT * FROM scraped_data WHERE url = $1 AND scraped_at > NOW() - INTERVAL \'1 hour\' ORDER BY scraped_at DESC LIMIT 1',
            [url]
        );

        if (existingScrape.rows.length > 0) {
            console.log(`📋 Using cached data for: ${url}`);
            return res.json({
                success: true,
                data: existingScrape.rows[0].content,
                cached: true,
                scrapedAt: existingScrape.rows[0].scraped_at,
                method: existingScrape.rows[0].scraping_method,
                title: existingScrape.rows[0].title
            });
        }

        // Perform scraping
        const result = await queueScrape(url);
        
        // Store in database
        const scrapeId = `scrape-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        await pool.query(
            `INSERT INTO scraped_data (id, url, title, content, content_length, scraping_method) 
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [scrapeId, url, result.title, result.content, result.contentLength, result.method]
        );

        console.log(`✅ Scraping completed for: ${url} (${result.contentLength} characters)`);

        res.json({
            success: true,
            data: result.content,
            cached: false,
            scrapedAt: new Date().toISOString(),
            method: result.method,
            title: result.title,
            contentLength: result.contentLength
        });

    } catch (error) {
        console.error(`❌ Scraping failed for ${url}:`, error);
        
        // Store error in database
        try {
            const scrapeId = `scrape-error-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            await pool.query(
                `INSERT INTO scraped_data (id, url, content, status, error_message) 
                 VALUES ($1, $2, $3, $4, $5)`,
                [scrapeId, url, '', 'error', error.message]
            );
        } catch (dbError) {
            console.error('Error storing scrape error:', dbError);
        }

        res.status(500).json({
            success: false,
            error: error.message,
            url: url
        });
    }
});

// API endpoint to get scraped data
app.get('/api/scraped-data', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM scraped_data WHERE status = $1 ORDER BY scraped_at DESC LIMIT 50',
            ['active']
        );
        
        res.json({
            success: true,
            data: result.rows
        });
    } catch (error) {
        console.error('Error fetching scraped data:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// API endpoint to delete scraped data
app.delete('/api/scraped-data/:id', async (req, res) => {
    const { id } = req.params;
    
    try {
        await pool.query('DELETE FROM scraped_data WHERE id = $1', [id]);
        res.json({ success: true, message: 'Scraped data deleted' });
    } catch (error) {
        console.error('Error deleting scraped data:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// API endpoint for document parsing
app.post('/api/parse-document', upload.single('document'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No document uploaded' });
    }

    try {
        console.log(`📄 Document upload request: ${req.file.originalname} (${req.file.size} bytes)`);

        // Parse the document
        const result = await parseDocument(req.file);
        
        // Store in database
        const docId = `doc-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        await pool.query(
            `INSERT INTO parsed_documents (id, filename, original_name, title, content, content_length, file_type, file_size) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [docId, req.file.originalname, req.file.originalname, result.title, result.content, 
             result.contentLength, result.fileType, req.file.size]
        );

        console.log(`✅ Document stored successfully: ${req.file.originalname} (${result.contentLength} characters)`);

        res.json({
            success: true,
            data: result.content,
            title: result.title,
            contentLength: result.contentLength,
            fileType: result.fileType,
            docId: docId,
            parsedAt: new Date().toISOString()
        });

    } catch (error) {
        console.error(`❌ Document parsing failed for ${req.file.originalname}:`, error);
        
        // Store error in database
        try {
            const docId = `doc-error-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            await pool.query(
                `INSERT INTO parsed_documents (id, filename, original_name, content, status, error_message) 
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [docId, req.file.originalname, req.file.originalname, '', 'error', error.message]
            );
        } catch (dbError) {
            console.error('Error storing document error:', dbError);
        }

        res.status(500).json({
            success: false,
            error: error.message,
            filename: req.file.originalname
        });
    }
});

// API endpoint to get parsed documents
app.get('/api/parsed-documents', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM parsed_documents WHERE status = $1 ORDER BY parsed_at DESC LIMIT 50',
            ['active']
        );
        
        res.json({
            success: true,
            data: result.rows
        });
    } catch (error) {
        console.error('Error fetching parsed documents:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// API endpoint to delete parsed document
app.delete('/api/parsed-documents/:id', async (req, res) => {
    const { id } = req.params;
    
    try {
        await pool.query('DELETE FROM parsed_documents WHERE id = $1', [id]);
        res.json({ success: true, message: 'Parsed document deleted' });
    } catch (error) {
        console.error('Error deleting parsed document:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// API endpoint to get current agent prompt
app.get('/api/prompt', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM agent_prompts WHERE is_current = true ORDER BY updated_at DESC LIMIT 1'
        );
        
        if (result.rows.length > 0) {
            res.json({
                success: true,
                system_prompt: result.rows[0].system_prompt,
                first_message: result.rows[0].first_message,
                includes_scraped_data: result.rows[0].includes_scraped_data
            });
        } else {
            // Return default prompt if none exists
            res.json({
                success: true,
                system_prompt: 'You are a helpful AI assistant for SkyIQ. Please assist callers professionally and courteously.',
                first_message: '',
                includes_scraped_data: false
            });
        }
    } catch (error) {
        console.error('Error fetching prompt:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// API endpoint to update agent prompt
app.post('/api/prompt', async (req, res) => {
    const { system_prompt, first_message = '', auto_include_scraped_data = false } = req.body;
    
    if (!system_prompt) {
        return res.status(400).json({ error: 'System prompt is required' });
    }

    try {
        let finalPrompt = system_prompt;
        let includesScrapedData = false;

        // Auto-include scraped data and parsed documents if requested
        if (auto_include_scraped_data) {
            const scrapedDataResult = await pool.query(
                'SELECT url, title, content FROM scraped_data WHERE status = $1 ORDER BY scraped_at DESC LIMIT 5',
                ['active']
            );

            const parsedDocsResult = await pool.query(
                'SELECT original_name, title, content FROM parsed_documents WHERE status = $1 ORDER BY parsed_at DESC LIMIT 5',
                ['active']
            );

            if (scrapedDataResult.rows.length > 0 || parsedDocsResult.rows.length > 0) {
                let knowledgeSection = '\n\n--- KNOWLEDGE BASE ---\n';
                
                // Add scraped website data
                for (const item of scrapedDataResult.rows) {
                    const contentPreview = item.content.substring(0, 2000);
                    knowledgeSection += `\n[Website: ${item.url}]\n[Title: ${item.title}]\n${contentPreview}${item.content.length > 2000 ? '...' : ''}\n`;
                }
                
                // Add parsed document data
                for (const item of parsedDocsResult.rows) {
                    const contentPreview = item.content.substring(0, 2000);
                    knowledgeSection += `\n[Document: ${item.original_name}]\n[Title: ${item.title}]\n${contentPreview}${item.content.length > 2000 ? '...' : ''}\n`;
                }
                
                knowledgeSection += '--- END KNOWLEDGE BASE ---\n';
                finalPrompt += knowledgeSection;
                includesScrapedData = true;
            }
        }

        // Mark all existing prompts as not current
        await pool.query('UPDATE agent_prompts SET is_current = false');

        // Insert new prompt
        await pool.query(
            `INSERT INTO agent_prompts (system_prompt, first_message, includes_scraped_data, is_current) 
             VALUES ($1, $2, $3, true)`,
            [finalPrompt, first_message, includesScrapedData]
        );

        // Update ElevenLabs agent if configured
        try {
            if (ELEVENLABS_API_KEY && ELEVENLABS_AGENT_ID) {
                await updateElevenLabsPrompt(finalPrompt, first_message);
                console.log('✅ ElevenLabs agent prompt updated');
            }
        } catch (elevenLabsError) {
            console.error('❌ Failed to update ElevenLabs prompt:', elevenLabsError);
            // Don't fail the whole request if ElevenLabs update fails
        }

        res.json({ 
            success: true, 
            message: 'Prompt updated successfully',
            includes_scraped_data: includesScrapedData,
            prompt_length: finalPrompt.length
        });

    } catch (error) {
        console.error('Error updating prompt:', error);
        res.status(500).json({ 
            error: 'Failed to update prompt', 
            details: error.message 
        });
    }
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
    console.log('📞 Webhook received from ElevenLabs');
    
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
        console.error('❌ Database error:', error);
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
        const scrapedResult = await pool.query('SELECT COUNT(*) FROM scraped_data WHERE status = $1', ['active']);
        const documentsResult = await pool.query('SELECT COUNT(*) FROM parsed_documents WHERE status = $1', ['active']);
        
        res.json({ 
            status: 'healthy', 
            uptime: process.uptime(),
            callCount: result.rows[0].count,
            scrapedDataCount: scrapedResult.rows[0].count,
            parsedDocumentsCount: documentsResult.rows[0].count,
            emailNotifications: emailConfig.enabled,
            elevenLabsConfigured: !!(ELEVENLABS_API_KEY && ELEVENLABS_AGENT_ID && ELEVENLABS_PHONE_NUMBER_ID),
            currentBatch: currentBatch,
            queueLength: batchQueue.length,
            scrapingQueueLength: scrapingQueue.length,
            activeScrapes: activeScrapes,
            documentParsingEnabled: true,
            supportedDocumentTypes: Object.keys(documentConfig.supportedTypes),
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

// Test web scraping endpoint
app.post('/test-scraping', async (req, res) => {
    const testUrl = req.body.url || 'https://example.com';
    
    try {
        console.log(`🧪 Testing scraping with: ${testUrl}`);
        const result = await queueScrape(testUrl);
        
        res.json({
            success: true,
            message: 'Scraping test successful',
            url: testUrl,
            method: result.method,
            contentLength: result.contentLength,
            title: result.title,
            preview: result.content.substring(0, 200) + (result.content.length > 200 ? '...' : '')
        });

    } catch (error) {
        console.error('Scraping test failed:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            url: testUrl
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
    console.log('🔌 Client connected');
    
    try {
        // Send call history
        const result = await pool.query('SELECT * FROM calls ORDER BY timestamp DESC LIMIT 50');
        socket.emit('callHistory', result.rows);
        
        // Send batch history
        const batches = await pool.query('SELECT * FROM batches ORDER BY created_at DESC LIMIT 5');
        socket.emit('batchHistory', batches.rows);
        
        // Send scraped data
        const scrapedData = await pool.query('SELECT * FROM scraped_data WHERE status = $1 ORDER BY scraped_at DESC LIMIT 20', ['active']);
        socket.emit('scrapedData', scrapedData.rows);
        
        // Send parsed documents
        const parsedDocs = await pool.query('SELECT * FROM parsed_documents WHERE status = $1 ORDER BY parsed_at DESC LIMIT 20', ['active']);
        socket.emit('parsedDocuments', parsedDocs.rows);
        
    } catch (error) {
        console.error('Error sending initial data:', error);
    }
    
    socket.on('disconnect', () => {
        console.log('🔌 Client disconnected');
    });
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Graceful shutdown initiated...');
    
    try {
        // Close database connections
        await pool.end();
        console.log('✅ Database connections closed');
        
        // Close server
        server.close(() => {
            console.log('✅ HTTP server closed');
            process.exit(0);
        });
        
    } catch (error) {
        console.error('❌ Error during shutdown:', error);
        process.exit(1);
    }
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`\n🚀 SkyIQ Server running on port ${PORT}`);
    console.log(`📡 Webhook endpoint: http://localhost:${PORT}/webhook`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    console.log(`🏥 Health check: http://localhost:${PORT}/health`);
    console.log(`📞 Initiate call: POST http://localhost:${PORT}/api/calls/initiate`);
    console.log(`🕷️  Web scraping: POST http://localhost:${PORT}/api/scrape`);
    console.log(`📄 Document parsing: POST http://localhost:${PORT}/api/parse-document`);
    console.log(`📁 Batch upload: POST http://localhost:${PORT}/api/batch/upload`);
    console.log(`🤖 Update prompt: POST http://localhost:${PORT}/api/prompt`);
    console.log(`🧪 Test email: POST http://localhost:${PORT}/test-email`);
    console.log(`🧪 Test scraping: POST http://localhost:${PORT}/test-scraping`);
    console.log(`\n🎯 Configure this webhook URL in your ElevenLabs agent settings:`);
    console.log(`   ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}/webhook`);
    console.log(`\n📊 System Status:`);
    console.log(`🗃️  Database: ${process.env.DATABASE_URL ? 'Connected' : 'Local/Test mode'}`);
    console.log(`📧 Email notifications: ${emailConfig.enabled ? 'Enabled (inbound only)' : 'Disabled'}`);
    console.log(`🤖 ElevenLabs API: ${ELEVENLABS_API_KEY && ELEVENLABS_AGENT_ID && ELEVENLABS_PHONE_NUMBER_ID ? 'Configured' : 'Not configured'}`);
    console.log(`🕷️  Web Scraping: Enabled (Max concurrent: ${scrapingConfig.maxConcurrentScrapes})`);
    console.log(`📄 Document Parsing: Enabled (Max file size: ${documentConfig.maxFileSize / (1024 * 1024)}MB)`);
    console.log(`📋 Supported formats: ${Object.keys(documentConfig.supportedTypes).join(', ')}`);
    
    if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID || !ELEVENLABS_PHONE_NUMBER_ID) {
        console.log(`⚠️  Set ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, and ELEVENLABS_PHONE_NUMBER_ID environment variables to enable outbound calling`);
    }
    
    console.log(`\n✨ SkyIQ Dashboard Ready! Open http://localhost:${PORT} in your browser\n`);
});
