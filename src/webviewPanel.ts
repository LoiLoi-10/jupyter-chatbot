import * as vscode from 'vscode';
import axios from 'axios';
import { LLMService } from './llmService';

export class ChatbotPanel {
    public static currentPanel: ChatbotPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _context: vscode.ExtensionContext;
    private _llmService: LLMService;
    private _availableModels: string[] = [];
    private _currentProvider: string = 'ollama';

    private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
        this._panel = panel;
        this._context = context;
        this._llmService = new LLMService(context);
        
        this._loadInitialConfig();
        this._initializeWebview();
        this._refreshModels();
        
        vscode.window.onDidChangeActiveNotebookEditor(() => {
            this._updateContext();
        }, null, this._disposables);

        vscode.workspace.onDidSaveTextDocument(doc => {
            if (doc.uri.fsPath.endsWith('.ipynb')) {  
                this._updateContext();
            }
        }, null, this._disposables);

        vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.scheme === 'vscode-notebook-cell') {
                this._updateContext();
            }
        }, null, this._disposables);
    }
    
    private async _loadInitialConfig() {
        const config = vscode.workspace.getConfiguration('jupyter-chatbot');
        this._currentProvider = config.get('llmProvider', 'ollama');
    }
    
    private async _refreshModels() {
        try {
            const config = vscode.workspace.getConfiguration('jupyter-chatbot');
            
            if (this._currentProvider === 'ollama') {
                this._availableModels = await this._llmService.getAvailableModels('ollama');
            } else {
                try {
                    // Clear models before fetching to prevent stale data
                    this._availableModels = [];
                    
                    // Get fresh models from server
                    this._availableModels = await this._llmService.getAvailableModels('university-server');
                    
                    // Validate and update selected model
                    const currentModel = config.get('model', '');
                    if (this._availableModels.length > 0 && !this._availableModels.includes(currentModel)) {
                        const newModel = this._availableModels[0];
                        await config.update('model', newModel, vscode.ConfigurationTarget.Global);
                        vscode.window.showInformationMessage(`Model reset to ${newModel}`);
                        
                        // Immediately update UI with new selection
                        this._sendModelSelectionToWebview(newModel);
                    }
                } catch (fetchError) {
                    console.error('University model fetch failed:', fetchError);
                    vscode.window.showErrorMessage(
                        `Model fetch failed: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`
                    );
                }
            }
            
            // Send models to webview
            this._panel.webview.postMessage({
                command: 'modelsList',
                models: this._availableModels
            });
            
        } catch (error) {
            console.error('Error refreshing models:', error);
            vscode.window.showErrorMessage(
                `Error refreshing models: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    private _updateContext() {
        const context = this._getNotebookContext();
        this._panel.webview.postMessage({
            command: 'notebookContext',
            context: context
        });
    }

    private async _initializeWebview() {
        this._panel.webview.html = this._getWebviewContent();
        
        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'submit':
                        try {
                            const context = this._getNotebookContext();
                            const response = await this._llmService.getResponse(message.text, context);
                            this._panel.webview.postMessage({ 
                                command: 'response', 
                                text: response 
                            });
                        } catch (error) {
                            const errorMessage = `Error: ${error instanceof Error ? error.message : String(error)}`;
                            this._panel.webview.postMessage({ 
                                command: 'response', 
                                text: errorMessage
                            });
                        }
                        break;
                    case 'getNotebookContext':
                        this._updateContext(); 
                        break;
                    case 'getConfig':
                        this._sendConfigToWebview();
                        break;
                    case 'updateConfig':
                        await this._updateConfig(message.provider, message.model, message.universityUrl);
                        break;
                    case 'setUniversityApiKey':
                        await this._setUniversityApiKey();
                        break;
                    case 'getModels':
                        this._panel.webview.postMessage({
                            command: 'modelsList',
                            models: this._availableModels
                        });
                        break;
                    case 'providerChanged':
                        await this._handleProviderChange(message.provider);
                        break;
                }
            },
            undefined,
            this._disposables
        );
        
        this._updateContext();
        this._sendConfigToWebview();
    }

    private async _handleProviderChange(provider: string) {
        const config = vscode.workspace.getConfiguration('jupyter-chatbot');
        
        // Update provider
        await config.update('llmProvider', provider, vscode.ConfigurationTarget.Global);
        this._currentProvider = provider;
        
        // Clear model list before refreshing
        this._availableModels = [];
        
        // Refresh models and config
        await this._refreshModels();
        this._sendConfigToWebview();
    }

    private async _sendConfigToWebview() {
        const config = vscode.workspace.getConfiguration('jupyter-chatbot');
        const model = config.get('model', this._currentProvider === 'ollama' ? 'llama3' : '');
        
        this._panel.webview.postMessage({
            command: 'configUpdate',
            provider: this._currentProvider,
            model: model,
            universityUrl: config.get('universityApiUrl', 'http://chat.ese.ic.ac.uk:8080')
        });
    }

    private async _updateConfig(provider: string, model: string, universityUrl: string) {
        const config = vscode.workspace.getConfiguration('jupyter-chatbot');
        
        // Clear model list before updating
        this._availableModels = [];
        
        // Update configuration
        await Promise.all([
            config.update('llmProvider', provider, vscode.ConfigurationTarget.Global),
            config.update('model', model, vscode.ConfigurationTarget.Global),
            config.update('universityApiUrl', universityUrl, vscode.ConfigurationTarget.Global)
        ]);
        
        this._currentProvider = provider;
        
        // Refresh models BEFORE sending UI updates
        await this._refreshModels();
        
        // Send model selection AFTER refresh
        this._sendModelSelectionToWebview(model);
        
        vscode.window.showInformationMessage(`Configuration updated: ${provider}/${model}`);
    }
    
    // Send model selection to webview
    private _sendModelSelectionToWebview(model: string) {
    if (!this._panel) {
        return;
    }
    
    this._panel.webview.postMessage({
        command: 'modelSelected',
        model: model
    });
}

    private async _setUniversityApiKey() {
        const apiKey = await vscode.window.showInputBox({
            prompt: 'Enter your University API Key',
            password: true
        });
        if (apiKey) {
            await this._context.secrets.store('universityApiKey', apiKey);
            vscode.window.showInformationMessage('University API key saved securely');
            
            // Clear model list before refreshing
            this._availableModels = [];
            
            // Immediately refresh models after setting key
            await this._refreshModels();
        }
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
            
            let context = "Current Notebook Context:\n";
            for (const cell of cells) {
                if (!cell.document) {  
                    continue;
                }
                
                const content = cell.document.getText();
                if (cell.kind === vscode.NotebookCellKind.Code) {
                    context += `--- [CODE CELL] ---\n${content}\n`;
                } else if (cell.kind === vscode.NotebookCellKind.Markup) {
                    context += `--- [MARKDOWN CELL] ---\n${content}\n`;
                }
            }
            
            return context;
        } catch (error) {
            console.error("Notebook parsing error:", error);
            return `Error parsing notebook: ${error instanceof Error ? error.message : 'Check console for details'}`;
        }
    }
    
    private _getWebviewContent(): string {
        const toolkitUri = this._panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._context.extensionUri, 'media', 'toolkit.min.js')
        );

        const styleUri = this._panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._context.extensionUri, 'media', 'styles.css')
        );

        const csp = `<meta http-equiv="Content-Security-Policy" 
        content="default-src 'none'; 
        script-src ${this._panel.webview.cspSource} 'unsafe-inline' https:; 
        style-src ${this._panel.webview.cspSource} 'unsafe-inline';">`;

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            ${csp}
            <script type="module" src="${toolkitUri}"></script>
            <link href="${styleUri}" rel="stylesheet">
            <style>
                /* ADDED STYLES FOR TOGGLE BUTTON */
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
                
                /* EXISTING STYLES */
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
                
                .config-button-group {
                    display: flex;
                    gap: 15px;
                    margin-top: 10px;
                }
                
                .config-button {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 5px 10px;
                    cursor: pointer;
                    border-radius: 4px;
                }
                
                #chat-container {
                    display: flex;
                    flex-direction: column;
                    height: 100%;
                }
                
                #messages {
                    flex: 1;
                    overflow-y: auto;
                    padding: 10px;
                }
                
                .message {
                    margin-bottom: 10px;
                    padding: 8px 12px;
                    border-radius: 8px;
                    max-width: 80%;
                }
                
                .user-message {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    align-self: flex-end;
                }
                
                .bot-message {
                    background: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    align-self: flex-start;
                }
                
                .error-message {
                    background: var(--vscode-inputValidation-errorBackground);
                    color: var(--vscode-inputValidation-errorForeground);
                }
                
                .system-message {
                    background: var(--vscode-textBlockQuote-background);
                    color: var(--vscode-textBlockQuote-foreground);
                    font-style: italic;
                    align-self: center;
                }
                
                .typing-indicator {
                    display: none;
                    padding: 5px;
                    font-style: italic;
                    color: var(--vscode-descriptionForeground);
                }
                
                #input-area {
                    display: flex;
                    gap: 10px;
                    padding-top: 10px;
                    border-top: 1px solid var(--vscode-sideBarSectionHeader-border);
                }
            </style>
            <title>Jupyter Chatbot</title>
        </head>
        <body>
            <!-- ADDED TOGGLE BUTTON AND CONTAINER -->
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
                        <div class="config-button-group">
                            <button id="set-api-key-btn" class="config-button">Set API Key</button>
                            <button id="refresh-models-btn" class="config-button">Refresh Models</button>
                            <button id="save-config" class="config-button">Save Configuration</button>
                        </div>
                    </div>
                    
                    <div id="ollama-config" style="display: none;">
                        <button id="save-config-ollama" class="config-button">Save Configuration</button>
                    </div>
                </div>
            </div>
            
            <div id="context-panel">
                <h3 style="margin-top: 0;">Active Notebook Context</h3>
                <pre id="context-display">Loading notebook context...</pre>
            </div>
            
            <div id="chat-container">
                <div id="messages"></div>
                <div class="typing-indicator" id="typing">Assistant is typing...</div>
                <div id="input-area">
                    <vscode-text-area id="input" placeholder="Ask about your notebook..." resize="vertical" rows=2></vscode-text-area>
                    <vscode-button id="submit">Send</vscode-button>
                </div>
            </div>
            
            <script>
                const vscode = acquireVsCodeApi();
                const messagesContainer = document.getElementById('messages');
                const inputField = document.getElementById('input');
                const submitButton = document.getElementById('submit');
                const typingIndicator = document.getElementById('typing');
                const contextDisplay = document.getElementById('context-display');
                
                // Configuration elements
                const providerSelect = document.getElementById('provider-select');
                const modelSelect = document.getElementById('model-select');
                const universityConfig = document.getElementById('university-config');
                const ollamaConfig = document.getElementById('ollama-config');
                const universityUrl = document.getElementById('university-url');
                const setApiKeyBtn = document.getElementById('set-api-key-btn');
                const refreshModelsBtn = document.getElementById('refresh-models-btn');
                const saveConfigBtn = document.getElementById('save-config');
                const saveConfigOllama = document.getElementById('save-config-ollama');
                
                // ADDED TOGGLE BUTTON AND STATE
                const toggleLlmBtn = document.getElementById('toggle-llm-btn');
                const llmInfoContainer = document.getElementById('llm-info-container');
                let llmInfoVisible = true;
                
                // Current configuration state
                let currentProvider = 'ollama';
                let currentModel = 'llama3';
                let availableModels = [];
                
                window.addEventListener('load', () => {
                    vscode.postMessage({ command: 'getNotebookContext' });
                    vscode.postMessage({ command: 'getConfig' });
                    vscode.postMessage({ command: 'getModels' });
                    
                    // ADDED: Initialize toggle button
                    toggleLlmBtn.addEventListener('click', toggleLlmInfo);
                });
                
                // ADDED: Toggle LLM info visibility
                function toggleLlmInfo() {
                    llmInfoVisible = !llmInfoVisible;
                    if (llmInfoVisible) {
                        llmInfoContainer.style.display = 'block';
                        toggleLlmBtn.textContent = 'Hide LLM Info';
                    } else {
                        llmInfoContainer.style.display = 'none';
                        toggleLlmBtn.textContent = 'Show LLM Info';
                    }
                }
                
                // Centralized model selection update
                function updateModelSelection(model) {
                    currentModel = model;
                    if (!modelSelect) return;
                    
                    // Find matching option using safe string concatenation
                    const selector = 'option[value="' + model + '"]';
                    const matchingOption = modelSelect.querySelector(selector);
                    
                    if (matchingOption) {
                        modelSelect.value = model;
                    } else if (availableModels.length > 0) {
                        // Select first available model if preferred isn't available
                        modelSelect.value = availableModels[0];
                        currentModel = availableModels[0];
                    }
                }
                
                window.addEventListener('message', event => {
                    const message = event.data;
                    
                    if (message.command === 'notebookContext') {
                        contextDisplay.textContent = message.context;
                        addMessage('System: Notebook context updated', 'system');
                    }
                    
                    if (message.command === 'response') {
                        typingIndicator.style.display = 'none';
                        if (message.text.startsWith('Error:')) {
                            addMessage(message.text, 'error');
                        } else {
                            addMessage(message.text, 'bot');
                        }
                    }
                    
                    // Handle config updates
                    if (message.command === 'configUpdate') {
                        currentProvider = message.provider || 'ollama';
                        currentModel = message.model || 'llama3';
                        
                        providerSelect.value = currentProvider;
                        universityUrl.value = message.universityUrl || '';
                        
                        // Update UI based on provider
                        universityConfig.style.display = currentProvider === 'university-server' ? 'block' : 'none';
                        ollamaConfig.style.display = currentProvider === 'ollama' ? 'block' : 'none';
                        
                        // Update model selection
                        updateModelSelection(currentModel);
                    }
                    
                    // Handle models list response
                    if (message.command === 'modelsList') {
                        availableModels = message.models;
                        populateModels(message.models);
                        updateModelSelection(currentModel);
                    }
                    
                    // Handle explicit model selection
                    if (message.command === 'modelSelected') {
                        updateModelSelection(message.model);
                    }
                });
                
                // Populate models dropdown
                function populateModels(models) {
                    if (!modelSelect) return;
                    modelSelect.innerHTML = '';
                    
                    if (models.length === 0) {
                        const option = document.createElement('option');
                        option.textContent = 'No models available';
                        option.disabled = true;
                        modelSelect.appendChild(option);
                        return;
                    }
                    
                    models.forEach(model => {
                        const option = document.createElement('option');
                        option.value = model;
                        option.textContent = model;
                        modelSelect.appendChild(option);
                    });
                }
                
                submitButton.addEventListener('click', sendMessage);
                inputField.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sendMessage();
                    }
                });
                
                function sendMessage() {
                    const text = inputField.value.trim();
                    if (!text) return;
                    
                    addMessage(text, 'user');
                    inputField.value = '';
                    typingIndicator.style.display = 'block';
                    vscode.postMessage({ command: 'submit', text: text });
                }
                
                // Provider selection change
                providerSelect.addEventListener('change', () => {
                    const newProvider = providerSelect.value;
                    universityConfig.style.display = newProvider === 'university-server' ? 'block' : 'none';
                    ollamaConfig.style.display = newProvider === 'ollama' ? 'block' : 'none';
                    
                    // Notify backend about provider change
                    vscode.postMessage({
                        command: 'providerChanged',
                        provider: newProvider
                    });
                });
                
                // Save config button (university)
                saveConfigBtn.addEventListener('click', () => {
                    const model = modelSelect.value;
                    const universityUrlValue = universityUrl.value;
                    
                    vscode.postMessage({
                        command: 'updateConfig',
                        provider: currentProvider,
                        model: model,
                        universityUrl: universityUrlValue
                    });
                });
                
                // Save config button (ollama)
                saveConfigOllama.addEventListener('click', () => {
                    vscode.postMessage({
                        command: 'updateConfig',
                        provider: 'ollama',
                        model: 'llama3',
                        universityUrl: ''
                    });
                });
                
                // Set API key button
                setApiKeyBtn.addEventListener('click', () => {
                    vscode.postMessage({
                        command: 'setUniversityApiKey'
                    });
                });
                
                // Refresh models button
                refreshModelsBtn.addEventListener('click', () => {
                    vscode.postMessage({
                        command: 'getModels'
                    });
                });
                
                function addMessage(text, type) {
                    const messageDiv = document.createElement('div');
                    messageDiv.className = \`message \${type}-message\`;
                    messageDiv.textContent = text;
                    messagesContainer.appendChild(messageDiv);
                    messagesContainer.scrollTop = messagesContainer.scrollHeight;
                }
            </script>
        </body>
        </html>`;
    }

    public static createOrShow(context: vscode.ExtensionContext) {
        const column = vscode.window.activeTextEditor ?
            vscode.window.activeTextEditor.viewColumn : undefined;

        if (ChatbotPanel.currentPanel) {
            ChatbotPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'jupyterChatbot',
            'Jupyter Chatbot',
            column || vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(context.extensionUri, 'media'),
                    vscode.Uri.joinPath(context.extensionUri, 'node_modules')
                ]
            }
        );

        ChatbotPanel.currentPanel = new ChatbotPanel(panel, context);
    }

    public dispose() {
        ChatbotPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}