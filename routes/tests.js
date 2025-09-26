const express = require('express');
const router = express.Router();

// Test endpoint for webhook simulation
router.post('/webhook', async (req, res) => {
    try {
        const { event, conversation_id, from_number, to_number, duration_seconds, transcript } = req.body;
        
        const testData = {
            event: event || 'call_ended',
            conversation_id: conversation_id || `test-conv-${Date.now()}`,
            from_number: from_number || '+15551234567',
            to_number: to_number || '+15557654321',
            duration_seconds: duration_seconds || 120,
            transcript: transcript || 'This is a test transcript from a simulated call.'
        };

        // Simulate webhook processing
        console.log('🧪 Testing webhook with data:', testData);

        // Update call record if it exists
        await req.appState.pool.query(`
            UPDATE calls 
            SET status = $1, duration = $2, transcript = COALESCE(transcript, '') || $3
            WHERE conversation_id = $4
        `, ['completed', testData.duration_seconds, testData.transcript + ' ', testData.conversation_id]);

        // Emit to connected clients
        req.appState.io.emit('testWebhook', testData);

        res.json({ 
            success: true, 
            message: 'Webhook test completed',
            data: testData
        });

    } catch (error) {
        console.error('Webhook test error:', error);
        res.status(500).json({ error: 'Test failed' });
    }
});

// Test endpoint for email notifications
router.post('/email', async (req, res) => {
    try {
        const { toEmail } = req.body;
        
        if (!req.appState.emailConfig.enabled) {
            return res.json({ 
                success: false, 
                message: 'Email notifications are disabled' 
            });
        }

        const testCallData = {
            id: `test-${Date.now()}`,
            timestamp: new Date().toISOString(),
            caller_number: '+15551234567',
            called_number: 'Agent',
            duration: 145,
            status: 'completed',
            call_type: 'inbound',
            transcript: 'This is a test call for email notification testing.'
        };

        const emailConfig = { ...req.appState.emailConfig };
        if (toEmail) {
            emailConfig.toEmail = toEmail;
        }

        await sendCallNotification(testCallData, req.appState.mailerSend, emailConfig);

        res.json({ 
            success: true, 
            message: 'Test email sent successfully' 
        });

    } catch (error) {
        console.error('Email test error:', error);
        res.status(500).json({ error: 'Email test failed' });
    }
});

// Test endpoint for ElevenLabs API connectivity
router.get('/elevenlabs', async (req, res) => {
    try {
        const { elevenLabsConfig } = req.appState;
        
        if (!elevenLabsConfig.apiKey) {
            return res.status(400).json({ error: 'ElevenLabs API key not configured' });
        }

        // Test agents endpoint
        const response = await fetch(elevenLabsConfig.agentsUrl, {
            headers: {
                'xi-api-key': elevenLabsConfig.apiKey
            }
        });

        if (!response.ok) {
            throw new Error(`API test failed: ${response.status} ${response.statusText}`);
        }

        const agents = await response.json();
        
        res.json({ 
            success: true,
            message: 'ElevenLabs API connectivity test passed',
            agentsCount: agents.agents ? agents.agents.length : 'Unknown',
            configuredAgent: elevenLabsConfig.agentId
        });

    } catch (error) {
        console.error('ElevenLabs test error:', error);
        res.status(500).json({ 
            error: 'ElevenLabs API test failed',
            details: error.message 
        });
    }
});

// Test database connectivity
router.get('/database', async (req, res) => {
    try {
        const result = await req.appState.pool.query('SELECT COUNT(*) as call_count FROM calls');
        const batchesResult = await req.appState.pool.query('SELECT COUNT(*) as batch_count FROM batches');
        const promptsResult = await req.appState.pool.query('SELECT COUNT(*) as prompt_count FROM prompts');

        res.json({ 
            success: true,
            message: 'Database connectivity test passed',
            stats: {
                calls: parseInt(result.rows[0].call_count),
                batches: parseInt(batchesResult.rows[0].batch_count),
                prompts: parseInt(promptsResult.rows[0].prompt_count)
            }
        });
    } catch (error) {
        console.error('Database test error:', error);
        res.status(500).json({ error: 'Database test failed' });
    }
});

// Test socket.io connectivity
router.get('/socket', async (req, res) => {
    try {
        req.appState.io.emit('testEvent', { 
            message: 'Test event from API',
            timestamp: new Date().toISOString()
        });

        res.json({ 
            success: true,
            message: 'Socket.io test event emitted to all connected clients'
        });
    } catch (error) {
        console.error('Socket test error:', error);
        res.status(500).json({ error: 'Socket test failed' });
    }
});

// Helper function for email notification (copied for completeness)
async function sendCallNotification(callData, mailerSend, emailConfig) {
    if (!emailConfig.enabled || !emailConfig.toEmail || !mailerSend) {
        return;
    }

    const { MailerSend, EmailParams, Sender, Recipient } = require("mailersend");
    const sentFrom = new Sender(emailConfig.fromEmail, emailConfig.fromName);
    const recipients = [new Recipient(emailConfig.toEmail, emailConfig.toName)];

    const emailParams = new EmailParams()
        .setFrom(sentFrom)
        .setTo(recipients)
        .setSubject(`🧪 Test Email - SkyIQ Dashboard`)
        .setHtml(`
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff;">
                <div style="background: linear-gradient(135deg, #10b981, #06b6d4); padding: 30px 20px; text-align: center; color: white; border-radius: 12px 12px 0 0;">
                    <div style="display: inline-block; background: rgba(255,255,255,0.2); padding: 12px; border-radius: 50%; margin-bottom: 15px; font-size: 24px;">🧪</div>
                    <h1 style="margin: 0 0 8px 0; font-size: 28px; font-weight: 700;">Test Email Successful</h1>
                    <p style="margin: 0; opacity: 0.9; font-size: 16px;">SkyIQ Dashboard Test Notification</p>
                </div>
                
                <div style="padding: 30px 20px; background: #f8fafc;">
                    <div style="background: white; border-radius: 12px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); margin-bottom: 25px;">
                        <p style="margin: 0 0 15px 0; color: #1e293b;">This is a test email to verify that email notifications are working correctly in your SkyIQ Dashboard.</p>
                        
                        <div style="background: #f0f9ff; border-left: 4px solid #06b6d4; padding: 12px 15px; margin: 15px 0;">
                            <p style="margin: 0; color: #0369a1; font-size: 14px;">
                                <strong>Test Details:</strong><br>
                                Timestamp: ${new Date().toLocaleString()}<br>
                                Server: ${process.env.RENDER_EXTERNAL_URL || 'localhost:3000'}
                            </p>
                        </div>
                    </div>
                    
                    <div style="text-align: center; margin-top: 30px;">
                        <a href="${process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000'}" 
                           style="display: inline-block; background: linear-gradient(135deg, #10b981, #06b6d4); color: white; padding: 15px 30px; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 16px;">
                            🖥️ View Dashboard
                        </a>
                    </div>
                </div>
            </div>
        `);

    try {
        await mailerSend.email.send(emailParams);
        console.log('📧 Test email sent successfully');
    } catch (error) {
        console.error('❌ Test email failed:', error.message);
        throw error;
    }
}

module.exports = router;
