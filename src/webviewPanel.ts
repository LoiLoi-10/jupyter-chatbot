import * as vscode from 'vscode';
import axios from 'axios';

export class ChatbotPanel {
    public static currentPanel: ChatbotPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _context: vscode.ExtensionContext;

    private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this._panel = panel;
    this._context = context;
    this._initializeWebview();
    
    
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
                        const response = await this._getOllamaResponse(message.text);
                        this._panel.webview.postMessage({ 
                            command: 'response', 
                            text: response 
                        });
                        break;
                    case 'getNotebookContext':
                        this._updateContext(); 
                        break;
                }
            },
            undefined,
            this._disposables
        );
        
        
        this._updateContext();
    }

    private async _getOllamaResponse(prompt: string): Promise<string> {
        try {
            const notebookContext = this._getNotebookContext();
            const fullPrompt = `${notebookContext}\n\nUser Question: ${prompt}\nAssistant:`;
            
            const response = await axios.post('http://localhost:11435/api/generate', {
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
            vscode.Uri.joinPath(this._context.extensionUri, 'node_modules', '@vscode', 'webview-ui-toolkit', 'dist', 'toolkit.min.js')
        );

        
        const csp = `<meta http-equiv="Content-Security-Policy" 
            content="default-src 'none'; 
            script-src ${this._panel.webview.cspSource} 'unsafe-inline'; 
            style-src ${this._panel.webview.cspSource} 'unsafe-inline';">
        `;

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            ${csp}
            <script type="module" src="${toolkitUri}"></script>
            <style>
                body {
                    padding: 10px;
                    font-family: var(--vscode-font-family);
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                }
                #chat-container {
                    display: flex;
                    flex-direction: column;
                    height: 100vh;
                }
                
                /* ADDED: Context panel styles */
                #context-panel {
                    border: 1px solid var(--vscode-input-border);
                    padding: 10px;
                    margin-bottom: 15px;
                    max-height: 200px;
                    overflow-y: auto;
                }
                #context-display {
                    white-space: pre-wrap;
                    font-family: monospace;
                    background: var(--vscode-input-background);
                    padding: 8px;
                    border-radius: 4px;
                    font-size: 0.9em;
                }
                
                #messages {
                    flex: 1;
                    overflow-y: auto;
                    margin-bottom: 10px;
                    padding: 10px;
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 4px;
                }
                .message {
                    margin-bottom: 15px;
                    padding: 8px;
                    border-radius: 4px;
                }
                .user-message {
                    background-color: var(--vscode-input-background);
                    align-self: flex-end;
                    max-width: 80%;
                    margin-left: 20%;
                }
                .bot-message {
                    background-color: var(--vscode-editorWidget-background);
                    align-self: flex-start;
                    max-width: 80%;
                    margin-right: 20%;
                }
                .system-message {
                    font-style: italic;
                    color: var(--vscode-descriptionForeground);
                    text-align: center;
                    margin: 10px 0;
                }
                #input-area {
                    display: flex;
                    gap: 10px;
                }
                vscode-text-area {
                    flex: 1;
                }
                .typing-indicator {
                    display: none;
                    font-style: italic;
                    color: var(--vscode-descriptionForeground);
                }
            </style>
            <title>Jupyter Chatbot</title>
        </head>
        <body>
            <!-- ADDED: Notebook context display panel -->
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
                
                window.addEventListener('load', () => {
                    vscode.postMessage({ command: 'getNotebookContext' });
                });
                
                // ADDED: Context update handler
                window.addEventListener('message', event => {
                    const message = event.data;
                    if (message.command === 'notebookContext') {
                        contextDisplay.textContent = message.context;
                        addMessage('System: Notebook context updated', 'system');
                    }
                    
                    if (message.command === 'response') {
                        typingIndicator.style.display = 'none';
                        addMessage(message.text, 'bot');
                    }
                });
                
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
                
                window.addEventListener('message', event => {
                    if (event.data.command === 'response') {
                        typingIndicator.style.display = 'none';
                        addMessage(event.data.text, 'bot');
                    }
                });
                
                function addMessage(text, sender) {
                    const messageDiv = document.createElement('div');
                    messageDiv.className = \`message \${sender}-message\`;
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