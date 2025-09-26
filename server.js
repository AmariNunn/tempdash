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
//const { chromium } = require('playwright');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Configure multer for file uploads
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
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
    maxContentLength: 50000,
    timeout: 30000,
    maxConcurrentScrapes: 3,
    userAgent: 'SkyIQ-Bot/1.0 (+https://skyiq.ai/bot)',
    retryAttempts: 2
};

// Document parsing configuration
const documentConfig = {
    maxContentLength: 100000,
    supportedTypes: {
        'application/pdf': 'pdf',
        'text/plain': 'txt',
        'application/msword': 'doc',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        'application/rtf': 'rtf',
        'text/markdown': 'md'
    },
    maxFileSize: 10 * 1024 * 1024
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

// Global state
let currentBatch = null;
let batchQueue = [];
let scrapingQueue = [];
let activeScrapes = 0;

// Helper functions
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

function cleanText(text) {
    return text
        .replace(/\s+/g, ' ')
        .replace(/\n\s*\n/g, '\n')
        .replace(/[^\w\s\.,!?;:()\-'"]/g, '')
        .trim()
        .substring(0, scrapingConfig.maxContentLength);
}

function extractMainContent($) {
    $('script, style, nav, header, footer, aside, .advertisement, .ad, .sidebar, .menu').remove();
    
    const contentSelectors = [
        'main', '[role="main"]', '.main-content', '.content', 'article',
        '.post-content', '.entry-content', '.page-content', '#content', '#main'
    ];
    
    for (const selector of contentSelectors) {
        const element = $(selector);
        if (element.length && element.text().trim().length > 200) {
            return cleanText(element.text());
        }
    }
    
    return cleanText($('body').text());
}

// Document parsing function
async function parseDocument(file) {
    console.log(`Document parsing: ${file.originalname} (${file.mimetype})`);
    
    const fileType = documentConfig.supportedTypes[file.mimetype];
    if (!fileType) {
        throw new Error(`Unsupported file type: ${file.mimetype}`);
    }

    if (file.size > documentConfig.maxFileSize) {
        throw new Error(`File too large: ${(file.size / (1024 * 1024)).toFixed(2)}MB`);
    }

    let content = '';
    let title = file.originalname;
    let metadata = {};

    try {
        switch (fileType) {
            case 'pdf':
                const pdfData = await pdf(file.buffer);
                content = pdfData.text;
                title = pdfData.info?.Title || file.originalname;
                metadata = { pages: pdfData.numpages };
                
                if (!content || content.trim().length === 0) {
                    throw new Error('PDF contains no readable text');
                }
                break;

            case 'txt':
            case 'md':
                content = file.buffer.toString('utf-8');
                if (!content || content.trim().length === 0) {
                    content = file.buffer.toString('latin1');
                }
                break;

            case 'docx':
                const docxResult = await mammoth.extractRawText({ buffer: file.buffer });
                content = docxResult.value;
                if (docxResult.messages && docxResult.messages.length > 0) {
                    metadata.warnings = docxResult.messages;
                }
                
                if (!content || content.trim().length === 0) {
                    throw new Error('DOCX contains no readable text');
                }
                break;

            case 'doc':
                content = file.buffer.toString('utf-8');
                content = content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, ' ');
                content = content.replace(/[^\x20-\x7E\n\r\t]/g, ' ');
                content = content.replace(/\s+/g, ' ').trim();
                
                const sentences = content.split(/[.!?]+/).filter(sentence => {
                    const trimmed = sentence.trim();
                    return trimmed.length > 10 && /[a-zA-Z]/.test(trimmed);
                });
                
                content = sentences.join('. ').trim();
                
                if (!content || content.length < 50) {
                    throw new Error('Could not extract readable text from DOC file');
                }
                
                metadata.note = 'Legacy DOC format - text extraction may be incomplete';
                break;

            case 'rtf':
                content = file.buffer.toString('utf-8');
                content = content.replace(/\{\\[^}]*\}/g, '');
                content = content.replace(/\\[a-z]+\d*\s?/gi, ' ');
                content = content.replace(/\{|\}/g, '');
                content = content.replace(/\s+/g, ' ').trim();
                
                if (!content || content.length < 10) {
                    throw new Error('Could not extract readable text from RTF file');
                }
                
                metadata.note = 'RTF format - formatting stripped';
                break;

            default:
                throw new Error(`Unsupported file type: ${fileType}`);
        }

        content = cleanText(content);
        
        if (!content || content.length < 10) {
            throw new Error('Document appears to be empty');
        }

        if (content.length > documentConfig.maxContentLength) {
            metadata.truncated = true;
            metadata.originalLength = content.length;
            content = content.substring(0, documentConfig.maxContentLength) + '...';
        }

        console.log(`Successfully parsed ${file.originalname} (${content.length} characters)`);
        
        return {
            content,
            title: title || file.originalname,
            contentLength: content.length,
            fileType: fileType,
            originalName: file.originalname,
            metadata
        };

    } catch (error) {
        console.error(`Error parsing ${file.originalname}:`, error);
        throw new Error(`Failed to parse document: ${error.message}`);
    }
}

// Enhanced prompt update function
async function updateAgentPromptWithData(systemPrompt, firstMessage = '', includeScrapedData = false, includeDocuments = false) {
    console.log('Updating agent prompt with data integration');

    if (!systemPrompt) {
        throw new Error('System prompt is required');
    }

    try {
        let finalPrompt = systemPrompt;
        let includesExternalData = false;
        let knowledgeStats = {
            scrapedSites: 0,
            documents: 0,
            totalCharacters: 0
        };

        if (includeScrapedData || includeDocuments) {
            let knowledgeSection = '\n\n=== KNOWLEDGE BASE ===\n';
            knowledgeSection += 'Use the following information to answer questions:\n\n';

            if (includeScrapedData) {
                const scrapedDataResult = await pool.query(
                    'SELECT url, title, content, scraped_at FROM scraped_data WHERE status = $1 ORDER BY scraped_at DESC LIMIT 10',
                    ['active']
                );

                if (scrapedDataResult.rows.length > 0) {
                    knowledgeSection += '--- WEB CONTENT ---\n';
                    
                    for (const item of scrapedDataResult.rows) {
                        const contentPreview = item.content.substring(0, 3000);
                        knowledgeSection += `\n[SOURCE: ${item.url}]\n`;
                        knowledgeSection += `[TITLE: ${item.title || 'Untitled'}]\n`;
                        knowledgeSection += `${contentPreview}${item.content.length > 3000 ? '...\n' : '\n'}`;
                        knowledgeSection += '---\n';
                        
                        knowledgeStats.scrapedSites++;
                        knowledgeStats.totalCharacters += contentPreview.length;
                    }
                }
            }
            
            if (includeDocuments) {
                const parsedDocsResult = await pool.query(
                    'SELECT original_name, title, content, parsed_at, file_type FROM parsed_documents WHERE status = $1 ORDER BY parsed_at DESC LIMIT 10',
                    ['active']
                );

                if (parsedDocsResult.rows.length > 0) {
                    knowledgeSection += '\n--- DOCUMENTS ---\n';
                    
                    for (const item of parsedDocsResult.rows) {
                        const contentPreview = item.content.substring(0, 3000);
                        knowledgeSection += `\n[DOCUMENT: ${item.original_name}]\n`;
                        knowledgeSection += `[TITLE: ${item.title || 'Untitled'}]\n`;
                        knowledgeSection += `[TYPE: ${item.file_type?.toUpperCase() || 'Unknown'}]\n`;
                        knowledgeSection += `${contentPreview}${item.content.length > 3000 ? '...\n' : '\n'}`;
                        knowledgeSection += '---\n';
                        
                        knowledgeStats.documents++;
                        knowledgeStats.totalCharacters += contentPreview.length;
                    }
                }
            }

            if (knowledgeStats.scrapedSites > 0 || knowledgeStats.documents > 0) {
                knowledgeSection += '\n=== END KNOWLEDGE BASE ===\n';
                knowledgeSection += '\nIMPORTANT: Use this knowledge base to provide accurate information. Always cite sources when using this information.';
                
                finalPrompt += knowledgeSection;
                includesExternalData = true;
            }
        }

        if (finalPrompt.length > 50000) {
            console.log('Prompt is very long, truncating to fit limits');
            finalPrompt = finalPrompt.substring(0, 50000) + '\n\n[Note: Knowledge base was truncated due to length limits]';
        }

        await pool.query('UPDATE agent_prompts SET is_current = false');

        const insertResult = await pool.query(
            'INSERT INTO agent_prompts (system_prompt, first_message, includes_scraped_data, is_current) VALUES ($1, $2, $3, true) RETURNING id',
            [finalPrompt, firstMessage, includesExternalData]
        );

        let elevenLabsSuccess = false;
        let elevenLabsError = null;
        
        try {
            if (ELEVENLABS_API_KEY && ELEVENLABS_AGENT_ID) {
                await updateElevenLabsPrompt(finalPrompt, firstMessage);
                elevenLabsSuccess = true;
                console.log('ElevenLabs agent prompt updated');
            }
        } catch (error) {
            elevenLabsError = error.message;
            console.error('Failed to update ElevenLabs prompt:', error);
        }

        return {
            success: true,
            message: 'Prompt updated successfully',
            promptId: insertResult.rows[0].id,
            includes_external_data: includesExternalData,
            prompt_length: finalPrompt.length,
            knowledge_stats: knowledgeStats,
            elevenlabs_updated: elevenLabsSuccess,
            elevenlabs_error: elevenLabsError
        };

    } catch (error) {
        console.error('Error updating prompt:', error);
        throw new Error(`Failed to update prompt: ${error.message}`);
    }
}

// Web scraping function with Playwright
async function scrapeWebsite(url) {
    console.log(`Starting scrape for: ${url}`);
    
    let browser;
    let lastError;
    
    for (let attempt = 1; attempt <= scrapingConfig.retryAttempts; attempt++) {
        try {
            if (attempt === 1) {
                console.log(`Attempt ${attempt}: Using fetch + Cheerio for ${url}`);
                
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), scrapingConfig.timeout);
                
                const response = await fetch(url, {
                    headers: {
                        'User-Agent': scrapingConfig.userAgent,
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                    },
                    signal: controller.signal
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
                
                console.log(`Successfully scraped ${url} with Cheerio (${content.length} chars)`);
                return {
                    content,
                    method: 'cheerio',
                    contentLength: content.length,
                    title: $('title').text().trim() || 'Untitled'
                };
            }
            
            console.log(`Attempt ${attempt}: Using Playwright for ${url}`);
            
            browser = await chromium.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
            
            const page = await browser.newPage();
            await page.setUserAgent(scrapingConfig.userAgent);
            
            await page.goto(url, { 
                waitUntil: 'networkidle',
                timeout: scrapingConfig.timeout 
            });
            
            const result = await page.evaluate(() => {
                const unwantedSelectors = [
                    'script', 'style', 'nav', 'header', 'footer', 'aside',
                    '.advertisement', '.ad', '.sidebar', '.menu'
                ];
                
                unwantedSelectors.forEach(selector => {
                    document.querySelectorAll(selector).forEach(el => el.remove());
                });
                
                const contentSelectors = [
                    'main', '[role="main"]', '.main-content', '.content',
                    'article', '.post-content', '#content', '#main'
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
            
            console.log(`Successfully scraped ${url} with Playwright (${cleanedContent.length} chars)`);
            return {
                content: cleanedContent,
                method: 'playwright',
                contentLength: cleanedContent.length,
                title: result.title
            };
            
        } catch (error) {
            lastError = error;
            console.log(`Attempt ${attempt} failed for ${url}: ${error.message}`);
            
            if (browser) {
                try {
                    await browser.close();
                } catch (closeError) {
                    console.error('Error closing browser:', closeError);
                }
                browser = null;
            }
            
            if (attempt < scrapingConfig.retryAttempts) {
                await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
            }
        }
    }
    
    throw new Error(`Failed to scrape ${url} after ${scrapingConfig.retryAttempts} attempts. Last error: ${lastError.message}`);
}

// Queue-based scraping
async function processScrapeQueue() {
    while (scrapingQueue.length > 0 && activeScrapes < scrapingConfig.maxConcurrentScrapes) {
        const { url, resolve, reject } = scrapingQueue.shift();
        activeScrapes++;
        
        scrapeWebsite(url)
            .then(result => {
                activeScrapes--;
                resolve(result);
                processScrapeQueue();
            })
            .catch(error => {
                activeScrapes--;
                reject(error);
                processScrapeQueue();
            });
    }
}

function queueScrape(url) {
    return new Promise((resolve, reject) => {
        scrapingQueue.push({ url, resolve, reject });
        processScrapeQueue();
    });
}

// Email notification function
async function sendCallNotification(callData) {
    if (!emailConfig.enabled || !emailConfig.toEmail || !process.env.MAILERSEND_API_KEY || callData.call_type === 'outbound') {
        return;
    }

    try {
        const sentFrom = new Sender(emailConfig.fromEmail, emailConfig.fromName);
        const recipients = [new Recipient(emailConfig.toEmail, emailConfig.toName)];

        const emailParams = new EmailParams()
            .setFrom(sentFrom)
            .setTo(recipients)
            .setSubject(`New Inbound Call - ${callData.caller_number} - SkyIQ`)
            .setHtml(`
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2>New Inbound Call</h2>
                    <p><strong>Phone:</strong> ${callData.caller_number}</p>
                    <p><strong>Duration:</strong> ${formatDuration(callData.duration)}</p>
                    <p><strong>Date:</strong> ${new Date(callData.timestamp).toLocaleDateString()}</p>
                    <a href="${process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000'}" 
                       style="background: #009AEE; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
                        View Dashboard
                    </a>
                </div>
            `);

        await mailerSend.email.send(emailParams);
        console.log('Email notification sent successfully');
    } catch (error) {
        console.error('Email notification failed:', error.message);
    }
}

// Initialize database
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
                conversation_id VARCHAR(255),
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )
        `);

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

// ElevenLabs functions
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
        console.log('ElevenLabs agent prompt updated successfully');
        return result;

    } catch (error) {
        console.error('Failed to update ElevenLabs prompt:', error);
        throw error;
    }
}

async function initiateOutboundCall(phoneNumber) {
    if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID || !ELEVENLABS_PHONE_NUMBER_ID) {
        throw new Error('ElevenLabs configuration incomplete');
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

// Batch processing
async function processBatch(batchId) {
    try {
        console.log(`Starting batch processing for batch: ${batchId}`);
        
        await pool.query('UPDATE batches SET status = $1 WHERE id = $2', ['processing', batchId]);

        const batchCalls = await pool.query(
            'SELECT * FROM batch_calls WHERE batch_id = $1 AND status = $2 ORDER BY created_at',
            [batchId, 'pending']
        );

        for (const batchCall of batchCalls.rows) {
            try {
                console.log(`Calling ${batchCall.phone_number}...`);
                
                await pool.query('UPDATE batch_calls SET status = $1 WHERE id = $2', ['processing', batchCall.id]);

                io.emit('batchProgress', {
                    batchId: batchId,
                    currentCall: batchCall.phone_number,
                    progress: await getBatchProgress(batchId)
                });

                const callResult = await initiateOutboundCall(batchCall.phone_number);
                
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

                await pool.query(`
                    INSERT INTO calls (id, timestamp, caller_number, called_number, duration, status, call_type, transcript, conversation_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                `, [callData.id, callData.timestamp, callData.caller_number, callData.called_number, 
                    callData.duration, callData.status, callData.call_type, callData.transcript, callData.conversation_id]);

                await pool.query(
                    'UPDATE batch_calls SET status = $1, call_id = $2, completed_at = NOW() WHERE id = $3',
                    ['completed', callData.id, batchCall.id]
                );

                await pool.query(
                    'UPDATE batches SET completed_calls = completed_calls + 1, successful_calls = successful_calls + 1 WHERE id = $1',
                    [batchId]
                );

                io.emit('newCall', callData);
                console.log(`Call initiated successfully to ${batchCall.phone_number}`);

                await new Promise(resolve => setTimeout(resolve, 2000));

            } catch (error) {
                console.error(`Failed to call ${batchCall.phone_number}:`, error.message);
                
                await pool.query(
                    'UPDATE batch_calls SET status = $1, error_message = $2, completed_at = NOW() WHERE id = $3',
                    ['failed', error.message, batchCall.id]
                );

                await pool.query(
                    'UPDATE batches SET completed_calls = completed_calls + 1, failed_calls = failed_calls + 1 WHERE id = $1',
                    [batchId]
                );

                continue;
            }
        }

        await pool.query('UPDATE batches SET status = $1 WHERE id = $2', ['completed', batchId]);

        const finalProgress = await getBatchProgress(batchId);
        io.emit('batchCompleted', {
            batchId: batchId,
            progress: finalProgress
        });

        console.log(`Batch ${batchId} completed!`);

    } catch (error) {
        console.error(`Batch processing failed for ${batchId}:`, error);
        
        await pool.query('UPDATE batches SET status = $1 WHERE id = $2', ['failed', batchId]);
    }

    currentBatch = null;
    
    if (batchQueue.length > 0) {
        const nextBatchId = batchQueue.shift();
        currentBatch = nextBatchId;
        processBatch(nextBatchId);
    }
}

async function getBatchProgress(batchId) {
    const result = await pool.query('SELECT * FROM batches WHERE id = $1', [batchId]);
    return result.rows[0];
}

function parseCSV(csvContent) {
    const lines = csvContent.trim().split('\n');
    const phoneNumbers = [];
    
    const startIndex = lines[0].toLowerCase().includes('phone') ? 1 : 0;
    
    for (let i = startIndex; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line) {
            const phoneNumber = line.split(',')[0].trim().replace(/['"]/g, '');
            if (phoneNumber && phoneNumber.length >= 10) {
                phoneNumbers.push(phoneNumber);
            }
        }
    }
    
    return phoneNumbers;
}

// ROUTES
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Web scraping API
app.post('/api/scrape', async (req, res) => {
    const { url } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    try {
        const urlObj = new URL(url);
        if (!['http:', 'https:'].includes(urlObj.protocol)) {
            return res.status(400).json({ error: 'Only HTTP and HTTPS URLs are supported' });
        }

        console.log(`Scraping request for: ${url}`);

        const existingScrape = await pool.query(
            'SELECT * FROM scraped_data WHERE url = $1 AND scraped_at > NOW() - INTERVAL \'1 hour\' ORDER BY scraped_at DESC LIMIT 1',
            [url]
        );

        if (existingScrape.rows.length > 0) {
            console.log(`Using cached data for: ${url}`);
            return res.json({
                success: true,
                data: existingScrape.rows[0].content,
                cached: true,
                scrapedAt: existingScrape.rows[0].scraped_at,
                method: existingScrape.rows[0].scraping_method,
                title: existingScrape.rows[0].title
            });
        }

        const result = await queueScrape(url);
        
        const scrapeId = `scrape-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        await pool.query(
            'INSERT INTO scraped_data (id, url, title, content, content_length, scraping_method) VALUES ($1, $2, $3, $4, $5, $6)',
            [scrapeId, url, result.title, result.content, result.contentLength, result.method]
        );

        console.log(`Scraping completed for: ${url} (${result.contentLength} characters)`);

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
        console.error(`Scraping failed for ${url}:`, error);
        
        try {
            const scrapeId = `scrape-error-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            await pool.query(
                'INSERT INTO scraped_data (id, url, content, status, error_message) VALUES ($1, $2, $3, $4, $5)',
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

// Document parsing API
app.post('/api/parse-document', upload.single('document'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ 
            success: false,
            error: 'No document uploaded. Please select a file to upload.' 
        });
    }

    try {
        console.log(`Document upload request: ${req.file.originalname} (${req.file.size} bytes, ${req.file.mimetype})`);

        const result = await parseDocument(req.file);
        
        const docId = `doc-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        await pool.query(
            'INSERT INTO parsed_documents (id, filename, original_name, title, content, content_length, file_type, file_size) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [docId, req.file.originalname, req.file.originalname, result.title, result.content, 
             result.contentLength, result.fileType, req.file.size]
        );

        io.emit('documentParsed', {
            id: docId,
            original_name: req.file.originalname,
            title: result.title,
            content_length: result.contentLength,
            file_type: result.fileType,
            parsed_at: new Date().toISOString()
        });

        console.log(`Document stored successfully: ${req.file.originalname} (${result.contentLength} characters)`);

        res.json({
            success: true,
            message: 'Document parsed and stored successfully',
            data: {
                content: result.content,
                title: result.title,
                contentLength: result.contentLength,
                fileType: result.fileType,
                docId: docId,
                parsedAt: new Date().toISOString(),
                metadata: result.metadata
            }
        });

    } catch (error) {
        console.error(`Document parsing failed for ${req.file?.originalname}:`, error);
        
        try {
            const docId = `doc-error-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            await pool.query(
                'INSERT INTO parsed_documents (id, filename, original_name, content, status, error_message) VALUES ($1, $2, $3, $4, $5, $6)',
                [docId, req.file?.originalname || 'unknown', req.file?.originalname || 'unknown', '', 'error', error.message]
            );
        } catch (dbError) {
            console.error('Error storing document error:', dbError);
        }

        res.status(500).json({
            success: false,
            error: error.message,
            filename: req.file?.originalname || 'unknown'
        });
    }
});

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

// Prompt APIs
app.get('/api/prompt', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM agent_prompts WHERE is_current = true ORDER BY updated_at DESC LIMIT 1'
        );
        
        if (result.rows.length > 0) {
            const prompt = result.rows[0];
            
            const scrapedCount = await pool.query('SELECT COUNT(*) FROM scraped_data WHERE status = $1', ['active']);
            const docsCount = await pool.query('SELECT COUNT(*) FROM parsed_documents WHERE status = $1', ['active']);
            
            res.json({
                success: true,
                system_prompt: prompt.system_prompt,
                first_message: prompt.first_message,
                includes_scraped_data: prompt.includes_scraped_data,
                created_at: prompt.created_at,
                updated_at: prompt.updated_at,
                knowledge_stats: {
                    available_scraped_sites: parseInt(scrapedCount.rows[0].count),
                    available_documents: parseInt(docsCount.rows[0].count)
                }
            });
        } else {
            res.json({
                success: true,
                system_prompt: 'You are a helpful AI assistant for SkyIQ. Please assist callers professionally and courteously.',
                first_message: 'Hello! I\'m your SkyIQ assistant. How can I help you today?',
                includes_scraped_data: false,
                knowledge_stats: {
                    available_scraped_sites: 0,
                    available_documents: 0
                }
            });
        }
    } catch (error) {
        console.error('Error fetching prompt:', error);
        res.status(500).json({ 
            success: false,
            error: 'Database error',
            details: error.message 
        });
    }
});

app.post('/api/prompt', async (req, res) => {
    const { 
        system_prompt, 
        first_message = '', 
        include_scraped_data = false, 
        include_documents = false,
        auto_include_scraped_data 
    } = req.body;
    
    const includeScrapedData = include_scraped_data || auto_include_scraped_data || false;

    console.log('Prompt update request received:', {
        hasSystemPrompt: !!system_prompt,
        firstMessage: !!first_message,
        includeScrapedData,
        includeDocuments,
        promptLength: system_prompt?.length || 0
    });

    if (!system_prompt) {
        return res.status(400).json({ 
            success: false,
            error: 'System prompt is required' 
        });
    }

    try {
        const result = await updateAgentPromptWithData(
            system_prompt, 
            first_message, 
            includeScrapedData, 
            include_documents
        );

        io.emit('promptUpdated', {
            includes_external_data: result.includes_external_data,
            prompt_length: result.prompt_length,
            knowledge_stats: result.knowledge_stats,
            updated_at: new Date().toISOString()
        });

        res.json(result);

    } catch (error) {
        console.error('Error updating prompt:', error);
        res.status(500).json({ 
            success: false,
            error: 'Failed to update prompt', 
            details: error.message 
        });
    }
});

// Call APIs
app.post('/api/calls/initiate', async (req, res) => {
    const { phoneNumber } = req.body;
    
    if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number is required' });
    }

    const phoneRegex = /^[\+]?[1-9][\d\s\-\(\)\.]{7,15}$/;
    const cleanedPhone = phoneNumber.replace(/[\s\-\(\)\.]/g, '');
    
    if (!phoneRegex.test(cleanedPhone)) {
        return res.status(400).json({ error: 'Invalid phone number format' });
    }

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

app.get('/api/calls', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM calls ORDER BY timestamp DESC LIMIT 50');
        res.json({ calls: result.rows });
    } catch (error) {
        console.error('Database query error:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// Batch APIs
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

        const batchId = `batch-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const batchName = req.body.batchName || `Batch ${new Date().toLocaleDateString()}`;

        await pool.query(
            'INSERT INTO batches (id, name, total_calls) VALUES ($1, $2, $3)',
            [batchId, batchName, phoneNumbers.length]
        );

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

app.post('/api/batch/:batchId/start', async (req, res) => {
    const { batchId } = req.params;

    try {
        const batch = await pool.query('SELECT * FROM batches WHERE id = $1', [batchId]);
        if (batch.rows.length === 0) {
            return res.status(404).json({ error: 'Batch not found' });
        }

        if (batch.rows[0].status !== 'pending') {
            return res.status(400).json({ error: 'Batch has already been processed' });
        }

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

app.get('/api/batches', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM batches ORDER BY created_at DESC LIMIT 10');
        res.json({ batches: result.rows });
    } catch (error) {
        console.error('Batches query error:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// Webhook endpoint
app.post('/webhook', async (req, res) => {
    console.log('Webhook received from ElevenLabs');
    
    const webhookData = req.body;
    
    let transcript = '';
    if (webhookData.data?.transcript && Array.isArray(webhookData.data.transcript)) {
        transcript = webhookData.data.transcript
            .map(turn => `${turn.role === 'agent' ? 'Agent' : 'Caller'}: ${turn.message}`)
            .join('\n');
    }
    
    const callData = {
        id: webhookData.data?.conversation_id || Date.now().toString(),
        timestamp: new Date().toISOString(),
        caller_number: webhookData.data?.metadata?.phone_call?.external_number || 'Unknown',
        called_number: webhookData.data?.metadata?.phone_call?.agent_number || 'Unknown',
        duration: webhookData.data?.metadata?.call_duration_secs || 0,
        status: 'completed',
        call_type: 'inbound',
        transcript: transcript || '',
        conversation_id: webhookData.data?.conversation_id
    };
    
    try {
        const outboundCall = await pool.query(
            'SELECT * FROM calls WHERE conversation_id = $1 AND call_type = $2', 
            [callData.conversation_id, 'outbound']
        );
        
        if (outboundCall.rows.length > 0) {
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

// Health check
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
        
        const batches = await pool.query('SELECT * FROM batches ORDER BY created_at DESC LIMIT 5');
        socket.emit('batchHistory', batches.rows);
        
        const scrapedData = await pool.query('SELECT * FROM scraped_data WHERE status = $1 ORDER BY scraped_at DESC LIMIT 20', ['active']);
        socket.emit('scrapedData', scrapedData.rows);
        
        const parsedDocs = await pool.query('SELECT * FROM parsed_documents WHERE status = $1 ORDER BY parsed_at DESC LIMIT 20', ['active']);
        socket.emit('parsedDocuments', parsedDocs.rows);
        
    } catch (error) {
        console.error('Error sending initial data:', error);
    }
    
    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nGraceful shutdown initiated...');
    
    try {
        await pool.end();
        console.log('Database connections closed');
        
        server.close(() => {
            console.log('HTTP server closed');
            process.exit(0);
        });
        
    } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
    }
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`\nSkyIQ Server running on port ${PORT}`);
    console.log(`Webhook endpoint: http://localhost:${PORT}/webhook`);
    console.log(`Dashboard: http://localhost:${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`\nConfigure this webhook URL in your ElevenLabs agent settings:`);
    console.log(`   ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}/webhook`);
    console.log(`\nSystem Status:`);
    console.log(`Database: ${process.env.DATABASE_URL ? 'Connected' : 'Local/Test mode'}`);
    console.log(`Email notifications: ${emailConfig.enabled ? 'Enabled' : 'Disabled'}`);
    console.log(`ElevenLabs API: ${ELEVENLABS_API_KEY && ELEVENLABS_AGENT_ID && ELEVENLABS_PHONE_NUMBER_ID ? 'Configured' : 'Not configured'}`);
    console.log(`Document Parsing: Enabled (${Object.keys(documentConfig.supportedTypes).join(', ')})`);
    console.log(`Web Scraping: Enabled with Playwright fallback`);
    
    if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID || !ELEVENLABS_PHONE_NUMBER_ID) {
        console.log(`Set ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, and ELEVENLABS_PHONE_NUMBER_ID environment variables to enable calling`);
    }
    
    console.log(`\nSkyIQ Dashboard Ready! Open http://localhost:${PORT} in your browser\n`);
});
