import * as vscode from 'vscode';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

interface ChatSession {
    id: string;
    title: string;
    messages: { text: string, isUser: boolean }[];
}

interface LLMConfig {
    provider: string;
    model: string;
    universityApiUrl: string;
}

class LLMService {
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    private async getConfig(): Promise<LLMConfig> {
        const config = vscode.workspace.getConfiguration('jupyter-chatbot');
        return {
            provider: config.get('llmProvider', 'ollama'),
            model: config.get('model', 'deepseek-r1:70b'),
            universityApiUrl: config.get('universityApiUrl', 'http://chat.ese.ic.ac.uk:8080')
        };
    }

    async getAvailableModels(): Promise<string[]> {
        const config = await this.getConfig();
        if (config.provider === 'university-server') {
            const apiKey = await this.context.secrets.get('universityApiKey');
            if (!apiKey) {return [];}
            
            try {
                const modelsUrl = `${config.universityApiUrl}/api/models`;
                const response = await axios.get(modelsUrl, {
                    headers: { 'Authorization': `Bearer ${apiKey}` },
                    timeout: 10000
                });
                
                if (response.data?.data && Array.isArray(response.data.data)) {
                    return response.data.data.map((m: any) => m.id);
                }
                return [];
            } catch (error) {
                console.error('Model fetch error:', error);
                return [];
            }
        } else {
            try {
                const response = await axios.get('http://localhost:11435/api/tags', { timeout: 5000 });
                return response.data.models.map((m: any) => m.name);
            } catch (error) {
                return [];
            }
        }
    }

    async getResponse(prompt: string, context: string): Promise<string> {
        const config = await this.getConfig();
        const fullPrompt = `Notebook Context:\n${context}\n\nQuestion: ${prompt}\nAnswer:`;

        if (config.provider === 'university-server') {
            const apiKey = await this.context.secrets.get('universityApiKey');
            if (apiKey) {
                const models = await this.getAvailableModels();
                if (!models.includes(config.model)) {
                    throw new Error(`Model ${config.model} not available on server`);
                }
            }
        }

        switch (config.provider) {
            case 'ollama':
                return this.queryOllama(fullPrompt, config.model);
            case 'university-server':
                return this.queryUniversityServer(fullPrompt, config.model, config.universityApiUrl);
            default:
                throw new Error(`Unsupported provider: ${config.provider}`);
        }
    }

    private async queryOllama(prompt: string, model: string): Promise<string> {
        try {
            const response = await axios.post('http://localhost:11435/api/generate', {
                model,
                prompt,
                stream: false,
                options: {
                    temperature: 0.7,
                    num_ctx: 4096
                }
            }, { timeout: 300000 });
            return response.data.response || "No response from model";
        } catch (error) {
            console.error('Ollama API error:', error);
            throw new Error(`Ollama API error: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async queryUniversityServer(prompt: string, model: string, apiUrl: string): Promise<string> {
        try {
            const apiKey = await this.context.secrets.get('universityApiKey');
            if (!apiKey) {
                throw new Error('University API key not configured. Use "Set University API Key" command');
            }

            const fullApiUrl = `${apiUrl}/api/chat/completions`;

            const response = await axios.post(fullApiUrl, {
                model,
                messages: [
                    { role: "user", content: prompt }
                ],
                temperature: 0.7,
                max_tokens: 4096
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                timeout: 30000
            });

            if (response.data.choices && response.data.choices[0] && response.data.choices[0].message) {
                return response.data.choices[0].message.content;
            } else {
                console.error('Unexpected API response:', response.data);
                return "Error: Unexpected response format from university server";
            }
        } catch (error) {
            console.error('University API error:', error);
            if (axios.isAxiosError(error)) {
                let errorDetails = `Status: ${error.response?.status || 'Unknown'}`;
                if (error.response?.data?.error) {
                    errorDetails += ` | ${error.response.data.error}`;
                }
                throw new Error(`University API error: ${errorDetails}`);
            }
            throw new Error(`University API error: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}

class ChatbotViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _context: vscode.ExtensionContext;
    private _llmService: LLMService;
    private _disposables: vscode.Disposable[] = [];
    private _sessions: ChatSession[] = [];
    private _currentSessionId: string | null = null;
    private _availableModels: string[] = [];

    constructor(context: vscode.ExtensionContext, llmService: LLMService) {
        this._context = context;
        this._llmService = llmService;
        
        // Load saved sessions
        this._sessions = context.globalState.get<ChatSession[]>('chatSessions', []);
        
        // Create initial session if none exists
        if (this._sessions.length === 0) {
            this.createNewChat();
        } else {
            // Set current session to the first session
            this._currentSessionId = this._sessions[0].id;
        }

        // Notebook change listeners
        vscode.window.onDidChangeActiveNotebookEditor(() => {
            this._updateContext();
        }, null, this._disposables);

        vscode.workspace.onDidSaveTextDocument(doc => {
            if (doc.uri.fsPath.endsWith('.ipynb')) {
                this._updateContext();
            }
        }, null, this._disposables);
        
        // Load models on activation
        this._refreshModels();
    }

    private async _refreshModels() {
        try {
            this._availableModels = await this._llmService.getAvailableModels();
            
            if (this._view) {
                this._view.webview.postMessage({
                    command: 'updateModels',
                    models: this._availableModels
                });
            }
        } catch (error) {
            console.error('Failed to refresh models:', error);
            vscode.window.showErrorMessage(
                `Model refresh failed: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    private _saveSessions() {
        this._context.globalState.update('chatSessions', this._sessions);
    }

    private get _currentSession(): ChatSession | undefined {
        return this._sessions.find(session => session.id === this._currentSessionId);
    }

    public createNewChat() {
        const newSession: ChatSession = {
            id: uuidv4(),
            title: "New Chat",
            messages: []
        };
        
        this._sessions.unshift(newSession);
        this._currentSessionId = newSession.id;
        this._saveSessions();
        this._updateWebview();
        return newSession;
    }

    public deleteChat(sessionId: string) {
        const sessionIndex = this._sessions.findIndex(s => s.id === sessionId);
        if (sessionIndex === -1) {return;}
        
        this._sessions.splice(sessionIndex, 1);
        
        if (this._currentSessionId === sessionId) {
            this._currentSessionId = this._sessions.length > 0 ? this._sessions[0].id : null;
        }
        
        this._saveSessions();
        this._updateWebview();
    }

    public clearCurrentChat() {
        const session = this._currentSession;
        if (session) {
            session.messages = [];
            session.title = "New Chat"; // Reset title
            this._saveSessions();
            this._updateWebview();
        }
    }

    private _updateWebview() {
        if (!this._view) {return;}
        
        this._view.webview.postMessage({ 
            command: 'updateSessions',
            sessions: this._sessions,
            currentSessionId: this._currentSessionId
        });
        
        if (this._currentSession) {
            this._view.webview.postMessage({ 
                command: 'updateHistory',
                history: this._currentSession.messages
            });
        }
        
        // Send updated model list
        this._view.webview.postMessage({
            command: 'updateModels',
            models: this._availableModels
        });
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._context.extensionUri,
                vscode.Uri.joinPath(this._context.extensionUri, 'node_modules')
            ]
        };

        webviewView.webview.html = this._getWebviewContent(webviewView.webview);
        webviewView.show?.(true);

        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'submit':
                    const session = this._currentSession;
                    if (!session) {return;}
                    
                    session.messages.push({ text: message.text, isUser: true });
                    if (session.messages.length === 1) {
                        // Set title based on first message
                        session.title = message.text.substring(0, 30) + 
                                      (message.text.length > 30 ? "..." : "");
                    }
                    
                    this._saveSessions();
                    this._updateWebview();
                    
                    try {
                        const context = this._getNotebookContext();
                        const response = await this._llmService.getResponse(message.text, context);
                        session.messages.push({ text: response, isUser: false });
                        this._saveSessions();
                        this._updateWebview();
                    } catch (error) {
                        const errorMessage = `Error: ${error instanceof Error ? error.message : String(error)}`;
                        session.messages.push({ text: errorMessage, isUser: false });
                        this._saveSessions();
                        this._updateWebview();
                    }
                    break;
                
                case 'getContext':
                    this._updateContext();
                    break;
                
                case 'getSessions':
                    this._updateWebview();
                    break;
                
                case 'switchSession':
                    this._currentSessionId = message.sessionId;
                    this._updateWebview();
                    break;
                
                case 'createSession':
                    this.createNewChat();
                    break;
                
                case 'deleteSession':
                    this.deleteChat(message.sessionId);
                    break;
                
                case 'updateConfig':
                    await this._updateConfig(message.provider, message.model, message.universityUrl);
                    await this._refreshModels();
                    this._sendConfigToWebview();
                    break;
                
                case 'setUniversityApiKey':
                    await this._setUniversityApiKey();
                    await this._refreshModels();
                    this._sendConfigToWebview();
                    break;
                
                case 'refreshModels':
                    await this._refreshModels();
                    this._sendConfigToWebview();
                    break;
            }
        });

        // CRITICAL FIX: Send initial state after webview is ready
        setTimeout(() => {
            this._updateWebview();
            this._updateContext();
        }, 300);
    }

    private async _setUniversityApiKey() {
        const apiKey = await vscode.window.showInputBox({
            prompt: 'Enter your University API Key',
            password: true
        });
        if (apiKey) {
            await this._context.secrets.store('universityApiKey', apiKey);
            vscode.window.showInformationMessage('University API key saved securely');
            await this._refreshModels();
        }
    }

    private async _updateConfig(provider: string, model: string, universityUrl: string) {
        const config = vscode.workspace.getConfiguration('jupyter-chatbot');
        await config.update('llmProvider', provider, vscode.ConfigurationTarget.Global);
        await config.update('model', model, vscode.ConfigurationTarget.Global);
        await config.update('universityApiUrl', universityUrl, vscode.ConfigurationTarget.Global);
        await this._refreshModels();
    }

    private _sendConfigToWebview() {
        if (!this._view) {return;}
        
        const config = vscode.workspace.getConfiguration('jupyter-chatbot');
        this._view.webview.postMessage({
            command: 'configUpdate',
            provider: config.get('llmProvider', 'ollama'),
            model: config.get('model', 'deepseek-r1:70b'),
            universityUrl: config.get('universityApiUrl', 'http://chat.ese.ic.ac.uk:8080')
        });
    }

    private _updateContext() {
        const context = this._getNotebookContext();
        this._view?.webview.postMessage({ 
            command: 'contextUpdate',
            context: context
        });
    }

    private _getNotebookContext(): string {
        try {
            const notebookEditor = vscode.window.activeNotebookEditor;
            if (!notebookEditor) {
                return "No active Jupyter notebook found. Open a notebook first.";
            }
            
            const cells = notebookEditor.notebook.getCells();
            if (!cells.length) {
                return "Notebook is empty.";
            }
            
            return cells
                .map((cell, index) => {
                    if (!cell.document) {return '';}
                    const content = cell.document.getText();
                    const cellNumber = index + 1;  
                    if (cell.kind === vscode.NotebookCellKind.Code) {
                        return `[${cellNumber}. CODE CELL]\n${content}`;
                    } else if (cell.kind === vscode.NotebookCellKind.Markup) {
                        return `[${cellNumber}. MARKDOWN CELL]\n${content}`;
                    }
                    return '';
                })
                .filter(Boolean)
                .join('\n\n');
        } catch (error) {
            console.error('Notebook parsing error:', error);
            return `Error parsing notebook: ${error instanceof Error ? error.message : 'Check console for details'}`;
        }
    }

    private _getWebviewContent(webview: vscode.Webview): string {
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._context.extensionUri, 'media', 'styles.css')
        );
        
        const toolkitUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._context.extensionUri, 'media', 'toolkit.min.js')
        );
        
        const csp = `<meta http-equiv="Content-Security-Policy" 
    content="default-src 'none'; 
    script-src ${webview.cspSource} 'unsafe-inline' https:; 
    style-src ${webview.cspSource} 'unsafe-inline';">`;
        
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    ${csp}
    <title>Jupyter Chatbot</title>
    <link href="${styleUri}" rel="stylesheet">
    <script type="module" src="${toolkitUri}"></script>
    <style>
        .toggle-container {
            display: flex;
            justify-content: flex-end;
            margin-bottom: 5px;
        }
        
        #toggle-llm-btn {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border);
            padding: 3px 8px;
            cursor: pointer;
            border-radius: 4px;
            font-size: 0.9em;
        }
        
        #toggle-llm-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        
        #llm-info-container {
            transition: opacity 0.3s ease;
        }
        
        .chat-container {
            display: flex;
            flex-direction: column;
            height: 100%;
            padding: 10px;
            box-sizing: border-box;
        }
        
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
            padding-bottom: 10px;
            border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
        }
        
        .session-controls {
            display: flex;
            gap: 10px;
            align-items: center;
        }
        
        #sessions-dropdown {
            flex: 1;
            min-width: 150px;
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            padding: 5px;
            border-radius: 4px;
        }
        
        .session-button {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 28px;
            height: 28px;
            font-size: 16px;
            font-weight: bold;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            cursor: pointer;
            border-radius: 4px;
        }
        
        .session-button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        
        #delete-session-btn {
            background: var(--vscode-inputValidation-errorBackground);
        }
        
        #delete-session-btn:hover {
            background: var(--vscode-inputValidation-errorBorder);
        }
        
        #context-content {
            white-space: pre-wrap;
            font-family: monospace;
            background: var(--vscode-input-background);
            padding: 8px;
            border-radius: 4px;
            max-height: 200px;
            overflow-y: auto;
            margin-bottom: 10px;
        }
        
        #chat-history {
            flex: 1;
            overflow-y: auto;
            padding: 10px;
            margin-bottom: 10px;
            background: var(--vscode-editorWidget-background);
            border-radius: 4px;
        }
        
        .user-message {
            align-self: flex-end;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-radius: 10px;
            padding: 8px 12px;
            margin: 5px 0;
            max-width: 80%;
        }
        
        .bot-message {
            align-self: flex-start;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 10px;
            padding: 8px 12px;
            margin: 5px 0;
            max-width: 80%;
        }
        
        .error-message {
            background: var(--vscode-inputValidation-errorBackground);
            color: var(--vscode-inputValidation-errorForeground);
        }
        
        .input-area {
            display: flex;
            gap: 10px;
            padding-top: 10px;
            border-top: 1px solid var(--vscode-sideBarSectionHeader-border);
        }
        
        #user-input {
            flex: 1;
            min-height: 60px;
            padding: 8px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            font-family: var(--vscode-font-family);
            resize: none;
        }
        
        #send-button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            cursor: pointer;
            border-radius: 4px;
            align-self: flex-end;
        }
        
        .config-section {
            margin-bottom: 15px;
            padding: 10px;
            background: var(--vscode-editorWidget-background);
            border-radius: 4px;
        }
        
        .config-row {
            display: flex;
            align-items: center;
            margin-bottom: 8px;
        }
        
        .config-label {
            min-width: 120px;
            margin-right: 10px;
        }
        
        .config-input {
            flex: 1;
            padding: 5px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
        }
        
        .config-select {
            flex: 1;
            padding: 5px;
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 4px;
        }
        
        .config-button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 5px 10px;
            cursor: pointer;
            border-radius: 4px;
            margin-top: 5px;
            margin-right: 10px;
        }
        
        .button-spacer {
            display: inline-block;
            width: 15px;
        }
    </style>
</head>
<body>
    <div class="chat-container">
        <div class="header">
            <h2>JUPYTER CHATBOT: CHAT</h2>
            <div class="session-controls">
                <select id="sessions-dropdown"></select>
                <button id="new-session-btn" class="session-button" title="New Chat">+</button>
                <button id="delete-session-btn" class="session-button" title="Delete Chat">×</button>
            </div>
        </div>
        
        <div class="toggle-container">
            <button id="toggle-llm-btn">Hide LLM Info</button>
        </div>
        
        <div id="llm-info-container">
            <div class="config-section">
                <div class="config-row">
                    <span class="config-label">LLM Provider:</span>
                    <select id="provider-select" class="config-select">
                        <option value="ollama">Ollama</option>
                        <option value="university-server">University Server</option>
                    </select>
                </div>
                
                <div class="config-row">
                    <span class="config-label">Model:</span>
                    <select id="model-select" class="config-select">
                        <!-- Models will be populated dynamically -->
                    </select>
                </div>
                
                <div id="university-config" style="display: none;">
                    <div class="config-row">
                        <span class="config-label">API URL:</span>
                        <input type="text" id="university-url" class="config-input" 
                            value="http://chat.ese.ic.ac.uk:8080" />
                    </div>
                    <div class="config-row">
                        <span class="config-label">API Key:</span>
                        <button id="set-api-key-btn" class="config-button">Set API Key</button>
                        <span class="button-spacer"></span>
                        <button id="refresh-models-btn" class="config-button">Refresh Models</button>
                    </div>
                </div>
                
                <button id="save-config" class="config-button">Save Configuration</button>
            </div>
        </div>
        
        <div id="context-view">
            <h3>Notebook Context</h3>
            <pre id="context-content"></pre>
        </div>
        
        <div id="chat-history"></div>
        
        <div class="input-area">
            <vscode-text-area id="user-input" placeholder="Ask about your notebook..."></vscode-text-area>
            <vscode-button id="send-button">Send</vscode-button>
        </div>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        const contextDisplay = document.getElementById('context-content');
        const historyContainer = document.getElementById('chat-history');
        const sessionsDropdown = document.getElementById('sessions-dropdown');
        const newSessionBtn = document.getElementById('new-session-btn');
        const deleteSessionBtn = document.getElementById('delete-session-btn');
        const providerSelect = document.getElementById('provider-select');
        const modelSelect = document.getElementById('model-select');
        const universityConfig = document.getElementById('university-config');
        const universityUrl = document.getElementById('university-url');
        const setApiKeyBtn = document.getElementById('set-api-key-btn');
        const refreshModelsBtn = document.getElementById('refresh-models-btn');
        const saveConfigBtn = document.getElementById('save-config');
        const userInput = document.getElementById('user-input');
        const sendButton = document.getElementById('send-button');
        
        // Toggle button elements
        const toggleLlmBtn = document.getElementById('toggle-llm-btn');
        const llmInfoContainer = document.getElementById('llm-info-container');
        let llmInfoVisible = true;
        
        // Handle new session button
        newSessionBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'createSession' });
        });
        
        // Handle delete session button
        deleteSessionBtn.addEventListener('click', () => {
            const currentSessionId = sessionsDropdown.value;
            if (currentSessionId) {
                vscode.postMessage({ 
                    command: 'deleteSession', 
                    sessionId: currentSessionId 
                });
            }
        });
        
        // Handle session selection change
        sessionsDropdown.addEventListener('change', (e) => {
            vscode.postMessage({ 
                command: 'switchSession', 
                sessionId: e.target.value 
            });
        });
        
        // Toggle LLM info visibility
        toggleLlmBtn.addEventListener('click', () => {
            llmInfoVisible = !llmInfoVisible;
            if (llmInfoVisible) {
                llmInfoContainer.style.display = 'block';
                toggleLlmBtn.textContent = 'Hide LLM Info';
            } else {
                llmInfoContainer.style.display = 'none';
                toggleLlmBtn.textContent = 'Show LLM Info';
            }
        });
        
        // Update session dropdown
        function updateSessions(sessions, currentSessionId) {
            sessionsDropdown.innerHTML = '';
            
            if (sessions.length === 0) {
                const option = document.createElement('option');
                option.text = 'No chats available';
                option.disabled = true;
                sessionsDropdown.appendChild(option);
                return;
            }
            
            sessions.forEach(session => {
                const option = document.createElement('option');
                option.value = session.id;
                option.text = session.title;
                option.selected = session.id === currentSessionId;
                sessionsDropdown.appendChild(option);
            });
        }
        
        // Restore chat history
        function restoreHistory(history) {
            historyContainer.innerHTML = '';
            history.forEach(msg => {
                addMessage(msg.text, msg.isUser);
            });
            historyContainer.scrollTop = historyContainer.scrollHeight;
        }
        
        // Add new message
        function addMessage(text, isUser) {
            const message = document.createElement('div');
            message.className = isUser ? 'user-message' : 
                text.startsWith('Error:') ? 'error-message' : 'bot-message';
            message.textContent = text;
            historyContainer.appendChild(message);
            historyContainer.scrollTop = historyContainer.scrollHeight;
        }
        
        // Update model dropdown
        function updateModels(models) {
            modelSelect.innerHTML = '';
            
            if (models.length === 0) {
                const option = document.createElement('option');
                option.text = 'No models available';
                option.disabled = true;
                modelSelect.appendChild(option);
                return;
            }
            
            models.forEach(model => {
                const option = document.createElement('option');
                option.value = model;
                option.text = model;
                modelSelect.appendChild(option);
            });
        }
        
        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'updateSessions':
                    updateSessions(message.sessions, message.currentSessionId);
                    break;
                case 'updateHistory':
                    restoreHistory(message.history);
                    break;
                case 'contextUpdate':
                    contextDisplay.textContent = message.context;
                    break;
                case 'configUpdate':
                    providerSelect.value = message.provider || 'ollama';
                    universityUrl.value = message.universityUrl || '';
                    universityConfig.style.display = message.provider === 'university-server' ? 'block' : 'none';
                    break;
                case 'updateModels':
                    updateModels(message.models);
                    if (message.models.length > 0) {
                        modelSelect.value = message.models[0];
                    }
                    break;
            }
        });
        
        // Submit handler
        sendButton.addEventListener('click', () => {
            const text = userInput.value.trim();
            if (text) {
                vscode.postMessage({ command: 'submit', text });
                userInput.value = '';
            }
        });
        
        // Allow Enter key to submit (with Shift+Enter for new line)
        userInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendButton.click();
            }
        });
        
        // Handle provider selection change
        providerSelect.addEventListener('change', () => {
            universityConfig.style.display = providerSelect.value === 'university-server' ? 'block' : 'none';
        });
        
        // Handle save config button
        saveConfigBtn.addEventListener('click', () => {
            vscode.postMessage({
                command: 'updateConfig',
                provider: providerSelect.value,
                model: modelSelect.value,
                universityUrl: universityUrl.value
            });
        });
        
        // Handle set API key button
        setApiKeyBtn.addEventListener('click', () => {
            vscode.postMessage({
                command: 'setUniversityApiKey'
            });
        });
        
        // Handle refresh models button
        refreshModelsBtn.addEventListener('click', () => {
            vscode.postMessage({
                command: 'refreshModels'
            });
        });
        
        // Request initial data on load
        window.addEventListener('load', () => {
            vscode.postMessage({ command: 'getSessions' });
            vscode.postMessage({ command: 'getContext' });
            vscode.postMessage({ command: 'getConfig' });
        });
    </script>
</body>
</html>`;
    }

    dispose() {
        while (this._disposables.length) {
            const disposable = this._disposables.pop()?.dispose();
        }
    }
}

export async function activate(context: vscode.ExtensionContext) {
    console.log('Jupyter Chatbot extension activating...');

    // Verify Jupyter extension is available
    const jupyterExtension = vscode.extensions.getExtension('ms-toolsai.jupyter');
    if (!jupyterExtension) {
        vscode.window.showErrorMessage('Jupyter extension is required for this chatbot to work');
        return;
    }
    await jupyterExtension.activate();

    // Create LLM service instance
    const llmService = new LLMService(context);

    // Register Chatbot View Provider
    const provider = new ChatbotViewProvider(context, llmService);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('jupyter-chatbot-view', provider),
        provider
    );

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('jupyter-chatbot.testModel', async () => {
            try {
                const testResponse = await llmService.getResponse(
                    "Respond with just 'TEST PASSED'", 
                    ""
                );
                vscode.window.showInformationMessage(`LLM response: ${testResponse.trim()}`);
            } catch (error) {
                vscode.window.showErrorMessage(`Connection failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }),
        
        vscode.commands.registerCommand('jupyter-chatbot.clearHistory', () => {
            provider.clearCurrentChat();
            vscode.window.showInformationMessage('Current chat cleared');
        }),
        
        vscode.commands.registerCommand('jupyter-chatbot.newChat', () => {
            provider.createNewChat();
            vscode.window.showInformationMessage('New chat created');
        }),
        
        vscode.commands.registerCommand('jupyter-chatbot.setUniversityApiKey', async () => {
            const apiKey = await vscode.window.showInputBox({
                prompt: 'Enter your University API Key',
                password: true
            });
            if (apiKey) {
                await context.secrets.store('universityApiKey', apiKey);
                vscode.window.showInformationMessage('University API key saved securely');
                vscode.commands.executeCommand('jupyter-chatbot.refreshModels');
            }
        }),
        
        vscode.commands.registerCommand('jupyter-chatbot.setUniversityApiUrl', async () => {
            const apiUrl = await vscode.window.showInputBox({
                prompt: 'Enter University API Endpoint URL',
                value: 'http://chat.ese.ic.ac.uk:8080'
            });
            if (apiUrl) {
                const config = vscode.workspace.getConfiguration('jupyter-chatbot');
                await config.update('universityApiUrl', apiUrl, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage('University API URL saved');
                vscode.commands.executeCommand('jupyter-chatbot.refreshModels');
            }
        }),

        vscode.commands.registerCommand('jupyter-chatbot.refreshModels', async () => {
            try {
                await provider['_refreshModels']();
                vscode.window.showInformationMessage('Models refreshed successfully');
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to refresh models: ${error instanceof Error ? error.message : String(error)}`);
            }
        })
    );

    console.log('Jupyter Chatbot extension activated successfully');
}

export function deactivate() {
    console.log('Deactivating extension...');
}