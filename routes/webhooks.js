
const express = require('express');
const router = express.Router();

// ElevenLabs webhook handler
router.post('/', async (req, res) => {
    try {
        const webhookData = req.body;
        console.log('📥 Received webhook:', JSON.stringify(webhookData, null, 2));

        // Determine event type from the webhook data structure
        let eventType = webhookData.event;
        
        // If no explicit event field, infer from the data structure
        if (!eventType) {
            if (webhookData.call_sid && webhookData.caller_id) {
                // This looks like a call initiation
                eventType = 'call_started';
            } else if (webhookData.conversation_id && webhookData.duration_seconds !== undefined) {
                eventType = 'call_ended';
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
                // Still process it as a potential call start if it has the right fields
                if (webhookData.call_sid || webhookData.caller_id) {
                    await handleCallStarted(webhookData, req.appState);
                }
        }

        res.status(200).send('Webhook processed successfully');
    } catch (error) {
        console.error('Error processing webhook:', error);
        res.status(500).send('Error processing webhook');
    }
});

async function handleCallStarted(webhookData, appState) {
    try {
        // Handle different field names from different webhook formats
        const callId = webhookData.call_id || webhookData.call_sid || webhookData.conversation_id;
        const fromNumber = webhookData.from_number || webhookData.caller_id;
        const toNumber = webhookData.to_number || webhookData.called_number;
        const conversationId = webhookData.conversation_id || webhookData.call_sid || callId;
        
        console.log(`📞 Processing call start: ${fromNumber} → ${toNumber}`);
        
        // Check if call already exists
        const existingCall = await appState.pool.query(
            'SELECT id FROM calls WHERE conversation_id = $1 OR id = $2', 
            [conversationId, callId]
        );
        
        if (existingCall.rows.length === 0) {
            // Create new call record for inbound calls
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

            // Send email notification for inbound calls
            if (callData.call_type === 'inbound') {
                await sendCallNotification(callData, appState.mailerSend, appState.emailConfig);
            }

            // Emit to connected clients
            if (appState.io) {
                appState.io.emit('newCall', callData);
            }
        } else {
            console.log(`📝 Call already exists, updating status`);
            // Update existing call status
            await appState.pool.query(
                'UPDATE calls SET status = $1 WHERE conversation_id = $2 OR id = $3', 
                ['in-progress', conversationId, callId]
            );
        }

        console.log('✅ Call started event processed');
    } catch (error) {
        console.error('Error handling call started event:', error);
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

        // Update batch call if this was an outbound call
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
        console.error('Error handling call ended event:', error);
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
        console.error('Error handling transcript event:', error);
    }
}

// Email notification function (unchanged)
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

        await mailerSend.email.send(emailParams);
        console.log('📧 Email notification sent successfully');
    } catch (error) {
        console.error('❌ Email notification failed:', error.message);
    }
}

module.exports = router;
