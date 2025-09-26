const express = require('express');
const router = express.Router();

// ElevenLabs webhook handler
router.post('/', async (req, res) => {
    try {
        const webhookData = req.body;
        console.log('📥 Received webhook:', JSON.stringify(webhookData, null, 2));

        // Check if this is a conversation initiation webhook
        if (webhookData.type === 'conversation_initiation_client_data' || 
            webhookData.event === 'conversation_initiation_client_data' ||
            webhookData.conversation_id) {
            
            // Handle conversation initiation - ElevenLabs expects specific response format
            console.log('🚀 Handling conversation initiation');
            
            // Get current prompt from database
            let currentPrompt = "You are a helpful AI assistant.";
            let firstMessage = "Hello! How can I help you today?";
            
            try {
                const promptResult = await req.appState.pool.query('SELECT * FROM prompts ORDER BY updated_at DESC LIMIT 1');
                if (promptResult.rows.length > 0) {
                    currentPrompt = promptResult.rows[0].system_prompt;
                    firstMessage = promptResult.rows[0].first_message;
                    console.log('📝 Using current prompt from database');
                } else {
                    console.log('⚠️ No prompts found, using default');
                }
            } catch (dbError) {
                console.error('❌ Database error, using default prompt:', dbError.message);
            }

            // Return the required format for ElevenLabs conversation initiation
            const response = {
                agent: {
                    prompt: {
                        prompt: currentPrompt
                    },
                    first_message: firstMessage
                }
            };

            console.log('✅ Sending conversation config:', JSON.stringify(response, null, 2));
            return res.status(200).json(response);
        }

        // Handle other webhook types (call tracking, etc.)
        let eventType = webhookData.event;
        
        // If no explicit event field, infer from the data structure
        if (!eventType) {
            if (webhookData.duration_seconds !== undefined || webhookData.duration !== undefined) {
                eventType = 'call_ended';
            } else if (webhookData.call_sid && webhookData.caller_id) {
                eventType = 'call_started';
            } else if (webhookData.transcript) {
                eventType = 'transcript';
            } else {
                eventType = 'unknown';
            }
        }

        console.log(`🔍 Inferred event type: ${eventType}`);

        // Handle different webhook event types
        switch (eventType) {
            case 'call_started':
                await handleCallStarted(webhookData, req.appState);
                break;
                
            case 'call_ended':
                await handleCallEnded(webhookData, req.appState);
                break;
                
            case 'transcript':
                await handleTranscript(webhookData, req.appState);
                break;
                
            default:
                console.log(`⚠️ Unhandled webhook event: ${eventType}`, webhookData);
                if (webhookData.call_sid || webhookData.caller_id) {
                    await handleCallStarted(webhookData, req.appState);
                }
        }

        res.status(200).send('Webhook processed successfully');
    } catch (error) {
        console.error('❌ Error processing webhook:', error);
        res.status(500).json({ error: 'Error processing webhook' });
    }
});

async function handleCallStarted(webhookData, appState) {
    try {
        const callId = webhookData.call_id || webhookData.call_sid || webhookData.conversation_id;
        const fromNumber = webhookData.from_number || webhookData.caller_id;
        const toNumber = webhookData.to_number || webhookData.called_number;
        const conversationId = webhookData.conversation_id || webhookData.call_sid || callId;
        
        console.log(`📞 Processing call start: ${fromNumber} → ${toNumber}`);
        
        const existingCall = await appState.pool.query(
            'SELECT id FROM calls WHERE conversation_id = $1 OR id = $2', 
            [conversationId, callId]
        );
        
        if (existingCall.rows.length === 0) {
            const callData = {
                id: callId || `inbound-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                timestamp: new Date().toISOString(),
                caller_number: fromNumber,
                called_number: toNumber,
                duration: 0,
                status: 'in-progress',
                call_type: 'inbound',
                transcript: '',
                conversation_id: conversationId || callId
            };

            await appState.pool.query(`
                INSERT INTO calls (id, timestamp, caller_number, called_number, duration, status, call_type, transcript, conversation_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            `, [callData.id, callData.timestamp, callData.caller_number, callData.called_number, 
                callData.duration, callData.status, callData.call_type, callData.transcript, callData.conversation_id]);

            console.log(`✅ Created new call record: ${callData.id}`);

            if (callData.call_type === 'inbound') {
                await sendCallNotification(callData, appState.mailerSend, appState.emailConfig);
            }

            if (appState.io) {
                appState.io.emit('newCall', callData);
            }
        } else {
            console.log(`📝 Call already exists, updating status`);
            await appState.pool.query(
                'UPDATE calls SET status = $1 WHERE conversation_id = $2 OR id = $3', 
                ['in-progress', conversationId, callId]
            );
        }

        console.log('✅ Call started event processed');
    } catch (error) {
        console.error('❌ Error handling call started event:', error);
    }
}

async function handleCallEnded(webhookData, appState) {
    try {
        const conversationId = webhookData.conversation_id || webhookData.call_sid || webhookData.call_id;
        const duration = webhookData.duration_seconds || webhookData.duration || 0;
        
        console.log(`📞 Processing call end: ${conversationId}, duration: ${duration}s`);
        
        await appState.pool.query(`
            UPDATE calls 
            SET status = $1, duration = $2 
            WHERE conversation_id = $3 OR id = $3
        `, ['completed', duration, conversationId]);

        await appState.pool.query(`
            UPDATE batch_calls 
            SET status = $1, completed_at = NOW() 
            WHERE call_id = $2 AND status = $3
        `, ['completed', conversationId, 'initiated']);

        if (appState.io) {
            appState.io.emit('callEnded', { conversation_id: conversationId, duration });
        }
        
        console.log('✅ Call ended event processed');

    } catch (error) {
        console.error('❌ Error handling call ended event:', error);
    }
}

async function handleTranscript(webhookData, appState) {
    try {
        const conversationId = webhookData.conversation_id || webhookData.call_sid || webhookData.call_id;
        const transcript = webhookData.transcript || webhookData.text || '';
        
        console.log(`📝 Processing transcript update for: ${conversationId}`);
        
        await appState.pool.query(`
            UPDATE calls 
            SET transcript = COALESCE(transcript, '') || $1 
            WHERE conversation_id = $2 OR id = $2
        `, [transcript + ' ', conversationId]);

        if (appState.io) {
            appState.io.emit('transcriptUpdate', { conversation_id: conversationId, transcript });
        }
        
        console.log('✅ Transcript updated');

    } catch (error) {
        console.error('❌ Error handling transcript event:', error);
    }
}

async function sendCallNotification(callData, mailerSend, emailConfig) {
    if (!emailConfig?.enabled || !emailConfig?.toEmail || !mailerSend || callData.call_type === 'outbound') {
        return;
    }

    try {
        const { MailerSend, EmailParams, Sender, Recipient } = require("mailersend");
        const sentFrom = new Sender(emailConfig.fromEmail, emailConfig.fromName);
        const recipients = [new Recipient(emailConfig.toEmail, emailConfig.toName)];

        const emailParams = new EmailParams()
            .setFrom(sentFrom)
            .setTo(recipients)
            .setSubject(`📞 Inbound Call - ${callData.caller_number} - SkyIQ`)
            .setHtml(`
                <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff;">
                    <div style="background: linear-gradient(135deg, #4f46e5, #06b6d4); padding: 30px 20px; text-align: center; color: white; border-radius: 12px 12px 0 0;">
                        <h1 style="margin: 0 0 8px 0; font-size: 28px; font-weight: 700;">New Inbound Call</h1>
                        <p style="margin: 0; opacity: 0.9; font-size: 16px;">SkyIQ Dashboard Notification</p>
                    </div>
                    
                    <div style="padding: 30px 20px; background: #f8fafc;">
                        <h2 style="color: #1e293b; margin: 0 0 20px 0; font-size: 20px; font-weight: 600;">📋 Call Details</h2>
                        
                        <div style="background: white; border-radius: 12px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
                            <p><strong>📞 Phone:</strong> ${callData.caller_number}</p>
                            <p><strong>📅 Date:</strong> ${new Date(callData.timestamp).toLocaleDateString()}</p>
                        </div>
                        
                        <div style="text-align: center; margin-top: 30px;">
                            <a href="${process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000'}" 
                               style="display: inline-block; background: linear-gradient(135deg, #4f46e5, #7c3aed); color: white; padding: 15px 30px; text-decoration: none; border-radius: 10px; font-weight: 600;">
                                🖥️ View Dashboard
                            </a>
                        </div>
                    </div>
                </div>
            `);

        await mailerSend.email.send(emailParams);
        console.log('📧 Email notification sent successfully');
    } catch (error) {
        console.error('❌ Email notification failed:', error.message);
    }
}

module.exports = router;
