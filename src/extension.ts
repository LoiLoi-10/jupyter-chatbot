import * as vscode from 'vscode';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

interface ChatSession {
    id: string;
    title: string;
    messages: { text: string, isUser: boolean }[];
}

class ChatbotViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _context: vscode.ExtensionContext;
    private _ollamaEndpoint = 'http://localhost:11435/api/generate';
    private _disposables: vscode.Disposable[] = [];
    private _sessions: ChatSession[] = [];
    private _currentSessionId: string | null = null;

    constructor(context: vscode.ExtensionContext) {
        this._context = context;
        
        // Load saved sessions
        const savedSessions = context.globalState.get<ChatSession[]>('chatSessions', []);
        this._sessions = savedSessions;
        
        // Set current session if exists
        if (this._sessions.length > 0) {
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
    }

    // Save sessions to persistent storage
    private _saveSessions() {
        this._context.globalState.update('chatSessions', this._sessions);
    }

    // Get current session
    private get _currentSession(): ChatSession | undefined {
        return this._sessions.find(session => session.id === this._currentSessionId);
    }

    // Create new chat session
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

    // Delete a chat session
    public deleteChat(sessionId: string) {
        const sessionIndex = this._sessions.findIndex(s => s.id === sessionId);
        if (sessionIndex === -1) {
            return;
        }
        
        this._sessions.splice(sessionIndex, 1);
        
        // Handle current session deletion
        if (this._currentSessionId === sessionId) {
            this._currentSessionId = this._sessions.length > 0 ? this._sessions[0].id : null;
        }
        
        this._saveSessions();
        this._updateWebview();
    }

    // Clear current chat history
    public clearCurrentChat() {
        const session = this._currentSession;
        if (session) {
            session.messages = [];
            this._saveSessions();
            this._updateWebview();
        }
    }

    private _updateWebview() {
        if (!this._view) {
            return;
        }
        
        // Update session list
        this._view.webview.postMessage({ 
            command: 'updateSessions',
            sessions: this._sessions,
            currentSessionId: this._currentSessionId
        });
        
        // Update current chat history
        if (this._currentSession) {
            this._view.webview.postMessage({ 
                command: 'updateHistory',
                history: this._currentSession.messages
            });
        }
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
                    
                    // Store user message
                    session.messages.push({ text: message.text, isUser: true });
                    
                    // Auto-generate title if first message
                    if (session.messages.length === 1) {
                        session.title = message.text.substring(0, 30) + (message.text.length > 30 ? "..." : "");
                    }
                    
                    this._saveSessions();
                    this._updateWebview();
                    
                    // Get response
                    const response = await this._getOllamaResponse(message.text);
                    
                    // Store bot response
                    session.messages.push({ text: response, isUser: false });
                    this._saveSessions();
                    this._updateWebview();
                    break;
                
                case 'getContext':
                    this._updateContext();
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
                
            }
        });

        // Initial update
        this._updateWebview();
        this._updateContext();
    }

    private _updateContext() {
        const context = this._getNotebookContext();
        this._view?.webview.postMessage({ 
            command: 'contextUpdate',
            context: context
        });
    }

    private async _getOllamaResponse(prompt: string): Promise<string> {
        try {
            const context = this._getNotebookContext();
            const fullPrompt = `Notebook Context:\n${context}\n\nQuestion: ${prompt}\nAnswer:`;
            
            const response = await axios.post(this._ollamaEndpoint, {
                model: 'llama3',
                prompt: fullPrompt,
                stream: false,
                options: {
                    temperature: 0.7,
                    num_ctx: 4096
                }
            });

            return response.data.response || "No response from model";
        } catch (error) {
            console.error('Ollama API error:', error);
            return `Error: ${error instanceof Error ? error.message : String(error)}`;
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
            
            return cells
                .map((cell, index) => {
                    if (!cell.document) {
                        return '';
                    }
                    
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
            vscode.Uri.joinPath(this._context.extensionUri, 'node_modules', '@vscode', 'webview-ui-toolkit', 'dist', 'toolkit.min.js')
        );
        
        const csp = `<meta http-equiv="Content-Security-Policy" 
            content="default-src 'none'; 
            script-src ${webview.cspSource} 'unsafe-inline'; 
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
        
        /* UPDATED BUTTON STYLES */
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
    </style>
</head>
<body>
    <div class="chat-container">
        <div class="header">
            <h2>JUPYTER CHATBOT: CHAT</h2>
            <div class="session-controls">
                <select id="sessions-dropdown"></select>
                <!-- UPDATED BUTTONS WITH VISIBLE TEXT -->
                <button id="new-session-btn" class="session-button" title="New Chat">+</button>
                <button id="delete-session-btn" class="session-button" title="Delete Chat">×</button>
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
            // Auto-scroll to bottom
            historyContainer.scrollTop = historyContainer.scrollHeight;
        }
        
        // Add new message
        function addMessage(text, isUser) {
            const message = document.createElement('div');
            message.className = isUser ? 'user-message' : 'bot-message';
            message.textContent = text;
            historyContainer.appendChild(message);
            // Auto-scroll to bottom
            historyContainer.scrollTop = historyContainer.scrollHeight;
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
            }
        });
        
        // Submit handler
        document.getElementById('send-button').addEventListener('click', () => {
            const input = document.getElementById('user-input');
            const text = input.value.trim();
            if (text) {
                vscode.postMessage({ command: 'submit', text });
                input.value = '';
            }
        });
        
        // Allow Enter key to submit (with Shift+Enter for new line)
        document.getElementById('user-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                document.getElementById('send-button').click();
            }
        });
        
        // Request initial data
        window.addEventListener('load', () => {
            vscode.postMessage({ command: 'getContext' });
            vscode.postMessage({ command: 'updateSessions' });
        });
    </script>
</body>
</html>`;
    }

    dispose() {
        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}

export async function activate(context: vscode.ExtensionContext) {
    console.log('Jupyter Chatbot extension activating...');

    // 1. Verify Jupyter extension is available
    const jupyterExtension = vscode.extensions.getExtension('ms-toolsai.jupyter');
    if (!jupyterExtension) {
        vscode.window.showErrorMessage('Jupyter extension is required for this chatbot to work');
        return;
    }
    await jupyterExtension.activate();

    // 2. Register Chatbot View Provider
    const provider = new ChatbotViewProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('jupyter-chatbot-view', provider),
        provider
    );

    // 3. Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('jupyter-chatbot.testModel', async () => {
            try {
                const testResponse = await queryOllamaModel("Respond with just 'TEST PASSED'");
                vscode.window.showInformationMessage(`Ollama response: ${testResponse.trim()}`);
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
        })
    );

    console.log('Jupyter Chatbot extension activated successfully');
}

export function deactivate() {
    console.log('Deactivating extension...');
}

async function queryOllamaModel(prompt: string): Promise<string> {
    try {
        const response = await axios.post('http://localhost:11435/api/generate', {
            model: 'llama3',
            prompt: prompt,
            stream: false,
            options: {
                temperature: 0.7,
                num_ctx: 4096
            }
        });
        return response.data.response || "No response from model";
    } catch (error) {
        throw new Error(`Ollama query failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}