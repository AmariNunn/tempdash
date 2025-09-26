// Configuration
const config = {
    appName: 'SkyIQ',
    companyName: 'AI Voice Dashboard',
    userInitials: 'SQ',
    maxCallsToShow: 10,
    autoRefreshInterval: 30000
};

// Global variables
let calls = [];
let settings = {
    responseSpeed: 'balanced',
    conversationStyle: 'friendly',
    autoUpdateKnowledge: true,
    maxKnowledgeLength: 5000
};

// Prompt templates
const promptTemplates = {
    sales: `You are a professional sales agent for our company. Your goal is to:
- Greet callers warmly and professionally
- Listen to their needs and understand their pain points
- Present our solutions in a compelling way
- Handle objections with empathy and expertise
- Guide the conversation toward scheduling a demo or next steps
- Always be helpful, knowledgeable, and customer-focused

Keep responses concise and conversational. Ask qualifying questions to understand their business needs.`,

    support: `You are a helpful customer support agent. Your primary objectives are to:
- Provide excellent customer service with patience and empathy
- Listen carefully to customer issues and concerns
- Offer clear, step-by-step solutions
- Escalate complex technical issues when appropriate
- Ensure customer satisfaction before ending the call
- Document any issues for follow-up

Always remain calm and professional, even with frustrated customers. Focus on resolving their problems efficiently.`,

    appointment: `You are an appointment scheduling specialist. Your role is to:
- Greet callers professionally and understand their scheduling needs
- Check availability and offer suitable time slots
- Collect necessary information for the appointment
- Confirm all details including date, time, and contact information
- Send confirmation and any preparation instructions
- Handle rescheduling requests professionally

Be efficient but thorough. Always double-check appointment details before confirming.`,

    receptionist: `You are a friendly and professional receptionist. Your responsibilities include:
- Greeting callers with warmth and professionalism
- Directing calls to the appropriate department or person
- Taking detailed messages when needed
- Providing basic company information and hours
- Handling general inquiries politely
- Maintaining a helpful and courteous tone

Always ask for the caller's name and reason for calling to provide the best assistance.`
};

// Initialize app
function initializeApp() {
    loadCurrentPrompt();
    refreshData();
    loadSettings();
    
    // Initialize knowledge length slider
    const slider = document.getElementById('maxKnowledgeLength');
    const valueDisplay = document.getElementById('knowledgeLengthValue');
    
    if (slider && valueDisplay) {
        slider.addEventListener('input', (e) => {
            const value = parseInt(e.target.value);
            valueDisplay.textContent = `${Math.round(value/1000)}K characters`;
        });
    }
}

// Tab switching functionality
function switchTab(tabId, tabButton) {
    document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    
    tabButton.classList.add('active');
    document.getElementById(tabId).classList.add('active');
}

// Template loading functionality
function loadTemplate(templateName) {
    if (promptTemplates[templateName]) {
        document.getElementById('promptEditor').value = promptTemplates[templateName];
        showNotification(`${templateName.charAt(0).toUpperCase() + templateName.slice(1)} template loaded`);
    }
}

// Call management
async function initiateCall() {
    const phoneNumber = document.getElementById('phoneInput').value.trim();
    
    if (!phoneNumber) {
        showCallStatus('Please enter a phone number', 'error');
        return;
    }

    const phoneRegex = /^[\+]?[1-9][\d\s\-\(\)\.]{7,15}$/;
    if (!phoneRegex.test(phoneNumber)) {
        showCallStatus('Please enter a valid phone number', 'error');
        return;
    }

    try {
        const callButton = document.getElementById('callButton');
        callButton.disabled = true;
        callButton.innerHTML = '<span class="btn-icon">📞</span> Initiating...';
        showCallStatus('Initiating call...', 'loading');

        const response = await fetch('/api/calls/initiate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ phoneNumber })
        });

        const result = await response.json();

        if (result.success) {
            showCallStatus(`Call initiated successfully to ${phoneNumber}`, 'success');
            document.getElementById('phoneInput').value = '';
            showNotification('Outbound call initiated successfully');
            
            setTimeout(() => {
                refreshData();
            }, 1000);
        } else {
            showCallStatus(result.error || 'Failed to initiate call', 'error');
        }
    } catch (error) {
        console.error('Error initiating call:', error);
        showCallStatus('Error initiating call. Please try again.', 'error');
    } finally {
        const callButton = document.getElementById('callButton');
        callButton.disabled = false;
        callButton.innerHTML = '<span class="btn-icon">📞</span> Start Call';
        
        setTimeout(() => {
            hideCallStatus();
        }, 5000);
    }
}

// Prompt management
async function loadCurrentPrompt() {
    try {
        showPromptStatus('Loading current prompt...', 'loading');
        const response = await fetch('/api/prompt');
        
        if (response.ok) {
            const data = await response.json();
            document.getElementById('promptEditor').value = data.prompt?.system_prompt || '';
            showPromptStatus('Prompt loaded successfully', 'success');
        } else {
            showPromptStatus('Failed to load current prompt', 'error');
        }
    } catch (error) {
        console.error('Error loading prompt:', error);
        showPromptStatus('Error loading prompt', 'error');
    } finally {
        setTimeout(() => {
            hidePromptStatus();
        }, 3000);
    }
}

async function savePrompt() {
    const prompt = document.getElementById('promptEditor').value.trim();
    
    if (!prompt) {
        showPromptStatus('Please enter a prompt before saving', 'error');
        return;
    }

    try {
        const savePromptBtn = document.getElementById('savePromptBtn');
        savePromptBtn.disabled = true;
        savePromptBtn.innerHTML = '<span class="btn-icon">💾</span> Saving...';
        showPromptStatus('Saving prompt...', 'loading');

        const response = await fetch('/api/prompt', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ 
                system_prompt: prompt, 
                first_message: 'Hello! This is Andy from SkyIQ. How can I help you today?'
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const result = await response.json();

        if (result.success) {
            showPromptStatus('Prompt saved successfully!', 'success');
            showNotification('AI agent prompt updated successfully');
        } else {
            showPromptStatus(result.error || 'Failed to save prompt', 'error');
        }
    } catch (error) {
        console.error('Error saving prompt:', error);
        showPromptStatus(`Error saving prompt: ${error.message}`, 'error');
    } finally {
        const savePromptBtn = document.getElementById('savePromptBtn');
        savePromptBtn.disabled = false;
        savePromptBtn.innerHTML = '<span class="btn-icon">💾</span> Save Prompt';
        
        setTimeout(() => {
            hidePromptStatus();
        }, 5000);
    }
}

// Data refresh
async function refreshData() {
    try {
        const refreshBtn = document.querySelector('button[onclick="refreshData()"]');
        if (refreshBtn) {
            refreshBtn.innerHTML = '<span class="btn-icon">🔄</span> Refreshing...';
            refreshBtn.disabled = true;
        }
        
        const response = await fetch('/api/calls');
        if (response.ok) {
            const data = await response.json();
            calls = data.calls || [];
            renderCallHistory();
            updateStats();
            showNotification('Data refreshed successfully');
        } else {
            showNotification('Failed to refresh data', true);
        }
    } catch (error) {
        console.error('Error refreshing data:', error);
        showNotification('Error refreshing data', true);
    } finally {
        const refreshBtn = document.querySelector('button[onclick="refreshData()"]');
        if (refreshBtn) {
            refreshBtn.innerHTML = '<span class="btn-icon">🔄</span> Refresh Data';
            refreshBtn.disabled = false;
        }
    }
}

// Render call history
function renderCallHistory() {
    const callHistory = document.getElementById('callHistory');
    
    if (calls.length === 0) {
        callHistory.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📞</div>
                <div class="empty-title">No calls yet</div>
                <div class="empty-subtitle">Your call data will appear here</div>
                <div class="webhook-url">Webhook: ${window.location.origin}/webhook</div>
            </div>
        `;
        return;
    }

    const callsToShow = calls.slice(0, config.maxCallsToShow);
    const cardsHTML = `
        <div class="call-cards">
            ${callsToShow.map(call => `
                <div class="call-card">
                    <div class="call-card-header">
                        <div class="call-phone">${formatPhoneNumber(call.caller_number || 'Unknown')}</div>
                        <div class="call-datetime">
                            <div class="call-date">${formatDate(call.timestamp)}</div>
                            <div class="call-time">${formatTime(call.timestamp)}</div>
                        </div>
                    </div>
                    <div class="call-details">
                        <div class="call-duration">${formatDuration(call.duration)}</div>
                        <div class="call-type-badge call-type-${call.call_type || 'inbound'}">
                            ${call.call_type === 'outbound' ? '📤 Out' : '📥 In'}
                        </div>
                        <span class="status-badge status-${getStatusClass(call.status)}">
                            ${call.status || 'Unknown'}
                        </span>
                    </div>
                    <div class="call-actions">
                        ${call.transcript ? 
                            `<button class="transcript-btn" onclick="showTranscript('${call.id}')">View Transcript</button>` : 
                            `<button class="transcript-btn" disabled>No Transcript</button>`
                        }
                    </div>
                </div>
            `).join('')}
        </div>
    `;
    callHistory.innerHTML = cardsHTML;
}

// Update stats
function updateStats() {
    const totalCalls = document.getElementById('totalCalls');
    const inboundCalls = document.getElementById('inboundCalls');
    const outboundCalls = document.getElementById('outboundCalls');
    const lastUpdate = document.getElementById('lastUpdate');
    
    if (totalCalls) totalCalls.textContent = calls.length;
    
    const inboundCallCount = calls.filter(call => call.call_type !== 'outbound').length;
    if (inboundCalls) inboundCalls.textContent = inboundCallCount;
    
    const outboundCallCount = calls.filter(call => call.call_type === 'outbound').length;
    if (outboundCalls) outboundCalls.textContent = outboundCallCount;
    
    if (lastUpdate) lastUpdate.textContent = new Date().toLocaleTimeString();
}

function viewAllCalls() {
    config.maxCallsToShow = calls.length;
    renderCallHistory();
    
    const viewBtn = document.querySelector('button[onclick="viewAllCalls()"]');
    if (viewBtn) {
        const originalText = viewBtn.innerHTML;
        viewBtn.innerHTML = `<span class="btn-icon">✅</span> Showing All ${calls.length}`;
        setTimeout(() => {
            viewBtn.innerHTML = originalText;
            config.maxCallsToShow = 10;
        }, 2000);
    }
}

// Modal management
function showTranscript(callId) {
    const call = calls.find(c => c.id === callId);
    if (call && call.transcript) {
        const phoneNumber = formatPhoneNumber(call.caller_number || 'Unknown');
        const callDate = formatDate(call.timestamp);
        const callTime = formatTime(call.timestamp);
        
        const modalTitle = document.getElementById('modalTitle');
        const modalTranscript = document.getElementById('modalTranscript');
        const transcriptModal = document.getElementById('transcriptModal');
        
        modalTitle.textContent = `Transcript - ${phoneNumber}`;
        
        const transcriptWithHeader = `Call Details:
Phone: ${phoneNumber}
Type: ${call.call_type === 'outbound' ? 'Outbound Call' : 'Inbound Call'}
Date: ${callDate} at ${callTime}
Duration: ${formatDuration(call.duration)}
Status: ${call.status || 'Unknown'}

Transcript:
${call.transcript}`;
        
        modalTranscript.textContent = transcriptWithHeader;
        transcriptModal.style.display = 'flex';
    }
}

function closeTranscriptModal() {
    const transcriptModal = document.getElementById('transcriptModal');
    transcriptModal.style.display = 'none';
}

// Settings management
function loadSettings() {
    const stored = localStorage.getItem('skyiq-settings');
    if (stored) {
        try {
            settings = {...settings, ...JSON.parse(stored)};
        } catch (e) {
            console.error('Error loading settings:', e);
        }
    }
    
    const responseSpeed = document.getElementById('responseSpeed');
    const conversationStyle = document.getElementById('conversationStyle');
    const autoUpdateKnowledge = document.getElementById('autoUpdateKnowledge');
    const maxKnowledgeLength = document.getElementById('maxKnowledgeLength');
    const valueDisplay = document.getElementById('knowledgeLengthValue');
    
    if (responseSpeed) responseSpeed.value = settings.responseSpeed;
    if (conversationStyle) conversationStyle.value = settings.conversationStyle;
    if (autoUpdateKnowledge) autoUpdateKnowledge.checked = settings.autoUpdateKnowledge;
    if (maxKnowledgeLength) maxKnowledgeLength.value = settings.maxKnowledgeLength;
    if (valueDisplay) valueDisplay.textContent = `${Math.round(settings.maxKnowledgeLength/1000)}K characters`;
}

function saveSettings() {
    const responseSpeed = document.getElementById('responseSpeed');
    const conversationStyle = document.getElementById('conversationStyle');
    const autoUpdateKnowledge = document.getElementById('autoUpdateKnowledge');
    const maxKnowledgeLength = document.getElementById('maxKnowledgeLength');
    
    if (responseSpeed) settings.responseSpeed = responseSpeed.value;
    if (conversationStyle) settings.conversationStyle = conversationStyle.value;
    if (autoUpdateKnowledge) settings.autoUpdateKnowledge = autoUpdateKnowledge.checked;
    if (maxKnowledgeLength) settings.maxKnowledgeLength = parseInt(maxKnowledgeLength.value);
    
    localStorage.setItem('skyiq-settings', JSON.stringify(settings));
    showNotification('Settings saved successfully');
}

function resetSettings() {
    settings = {
        responseSpeed: 'balanced',
        conversationStyle: 'friendly',
        autoUpdateKnowledge: true,
        maxKnowledgeLength: 5000
    };
    loadSettings();
    localStorage.removeItem('skyiq-settings');
    showNotification('Settings reset to default');
}

// Knowledge base placeholders
function exportKnowledgeBase() {
    showNotification('Export functionality coming soon');
}

function clearKnowledgeBase() {
    showNotification('Clear functionality coming soon');
}

// Utility functions
function showCallStatus(message, type) {
    const callStatus = document.getElementById('callStatus');
    if (callStatus) {
        callStatus.textContent = message;
        callStatus.className = `call-status ${type}`;
    }
}

function hideCallStatus() {
    const callStatus = document.getElementById('callStatus');
    if (callStatus) {
        callStatus.className = 'call-status';
    }
}

function showPromptStatus(message, type) {
    const promptStatus = document.getElementById('promptStatus');
    if (promptStatus) {
        promptStatus.textContent = message;
        promptStatus.className = `prompt-status ${type}`;
    }
}

function hidePromptStatus() {
    const promptStatus = document.getElementById('promptStatus');
    if (promptStatus) {
        promptStatus.className = 'prompt-status';
    }
}

function showNotification(message, isError = false) {
    const notification = document.getElementById('notification');
    if (notification) {
        notification.textContent = message;
        notification.className = `notification ${isError ? 'error' : ''}`;
        notification.classList.add('show');
        setTimeout(() => {
            notification.classList.remove('show');
        }, 4000);
    }
}

function getStatusClass(status) {
    if (!status) return 'unknown';
    const statusLower = status.toLowerCase();
    if (statusLower.includes('complete') || statusLower === 'answered') return 'completed';
    if (statusLower.includes('fail') || statusLower === 'busy') return 'failed';
    if (statusLower.includes('initiat')) return 'initiated';
    return statusLower.replace(/[^a-z0-9]/g, '-');
}

function formatPhoneNumber(phone) {
    if (!phone || phone === 'Unknown') return phone;
    
    const cleaned = phone.replace(/\D/g, '');
    
    if (cleaned.length === 10) {
        return `(${cleaned.substr(0, 3)}) ${cleaned.substr(3, 3)}-${cleaned.substr(6, 4)}`;
    } else if (cleaned.length === 11 && cleaned.charAt(0) === '1') {
        return `+1 (${cleaned.substr(1, 3)}) ${cleaned.substr(4, 3)}-${cleaned.substr(7, 4)}`;
    }
    
    return phone;
}

function formatDate(dateString) {
    if (!dateString) return 'Unknown';
    const date = new Date(dateString);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    
    if (date.toDateString() === today.toDateString()) {
        return 'Today';
    } else if (date.toDateString() === yesterday.toDateString()) {
        return 'Yesterday';
    } else {
        return date.toLocaleDateString();
    }
}

function formatTime(dateString) {
    if (!dateString) return 'Unknown';
    return new Date(dateString).toLocaleTimeString([], {
        hour: '2-digit', 
        minute: '2-digit',
        hour12: true
    });
}

function formatDuration(seconds) {
    if (!seconds || seconds === 0) return '0s';
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
        return `${hours}h ${mins}m`;
    } else if (mins > 0) {
        return `${mins}m ${secs}s`;
    } else {
        return `${secs}s`;
    }
}

// Event listeners
document.addEventListener('DOMContentLoaded', () => {
    const phoneInput = document.getElementById('phoneInput');
    const transcriptModal = document.getElementById('transcriptModal');
    
    // Phone input formatting
    if (phoneInput) {
        phoneInput.addEventListener('input', (e) => {
            let value = e.target.value.replace(/\D/g, '');
            
            if (value.length >= 10) {
                if (value.length === 10) {
                    value = `(${value.substr(0, 3)}) ${value.substr(3, 3)}-${value.substr(6, 4)}`;
                } else if (value.length === 11 && value.charAt(0) === '1') {
                    value = `+1 (${value.substr(1, 3)}) ${value.substr(4, 3)}-${value.substr(7, 4)}`;
                }
            }
            
            e.target.value = value;
        });

        phoneInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                initiateCall();
            }
        });
    }

    // Modal event listeners
    if (transcriptModal) {
        transcriptModal.addEventListener('click', (e) => {
            if (e.target === transcriptModal) {
                closeTranscriptModal();
            }
        });
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && transcriptModal && transcriptModal.style.display === 'flex') {
            closeTranscriptModal();
        }
        if (e.key === 'r' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            refreshData();
        }
    });

    // Initialize the app
    initializeApp();
});
