import * as vscode from 'vscode';
import axios from 'axios';  

class ChatbotViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _context: vscode.ExtensionContext;
    private _ollamaEndpoint = 'http://localhost:11435/api/generate';  
    private _disposables: vscode.Disposable[] = [];
    private _messages: { text: string, isUser: boolean }[] = []; // NEW: Message history storage

    constructor(context: vscode.ExtensionContext) {
        this._context = context;
        
        // Load saved messages from extension state
        this._messages = context.globalState.get('chatHistory', []); // NEW
        
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

    // NEW: Save messages to persistent storage
    private _saveMessages() {
        this._context.globalState.update('chatHistory', this._messages);
    }

    // NEW: Clear history method
    public clearHistory() {
        this._messages = [];
        this._saveMessages();
        if (this._view) {
            this._view.webview.postMessage({ 
                command: 'updateHistory',
                history: this._messages
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
                    // Store user message immediately
                    this._messages.push({ text: message.text, isUser: true });
                    this._saveMessages();
                    
                    const response = await this._getOllamaResponse(message.text);
                    
                    // Store bot response
                    this._messages.push({ text: response, isUser: false });
                    this._saveMessages();
                    
                    // Send all messages to webview
                    this._view?.webview.postMessage({ 
                        command: 'updateHistory',
                        history: this._messages
                    });
                    break;
                
                case 'getContext':
                    this._updateContext();
                    break;
                
                // NEW: Handle history request
                case 'getHistory':
                    this._view?.webview.postMessage({ 
                        command: 'updateHistory',
                        history: this._messages
                    });
                    break;
            }
        });

        // NEW: Send initial history instead of context
        this._view?.webview.postMessage({ 
            command: 'updateHistory',
            history: this._messages
        });
        
        // Also send context
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
                .map(cell => {
                    if (!cell.document) {
                        return '';
                    }
                    
                    const content = cell.document.getText();
                    if (cell.kind === vscode.NotebookCellKind.Code) {
                        return `## [CODE CELL]\n${content}`;
                    } else if (cell.kind === vscode.NotebookCellKind.Markup) {
                        return `## [MARKDOWN CELL]\n${content}`;
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
        </head>
        <body>
            <div class="chat-container">
                <div id="context-view">
                    <h3>Notebook Context</h3>
                    <pre id="context-content" style="
                        white-space: pre-wrap;
                        font-family: monospace;
                        background: var(--vscode-input-background);
                        padding: 8px;
                        border-radius: 4px;
                        max-height: 200px;
                        overflow-y: auto;
                    "></pre>
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
                
                // NEW: Restore full history
                function restoreHistory(history) {
                    historyContainer.innerHTML = '';
                    history.forEach(msg => {
                        addMessage(msg.text, msg.isUser);
                    });
                }
                
                // Handle messages from extension
                window.addEventListener('message', event => {
                    const message = event.data;
                    switch (message.command) {
                        case 'response':
                            addMessage(message.text, false);
                            break;
                        case 'contextUpdate':
                            contextDisplay.textContent = message.context;
                            break;
                        // NEW: Handle history updates
                        case 'updateHistory':
                            restoreHistory(message.history);
                            break;
                    }
                });
                
                function addMessage(text, isUser) {
                    const message = document.createElement('div');
                    message.className = isUser ? 'user-message' : 'bot-message';
                    message.textContent = text;
                    historyContainer.appendChild(message);
                    // Auto-scroll to bottom
                    historyContainer.scrollTop = historyContainer.scrollHeight;
                }
                
                document.getElementById('send-button').addEventListener('click', () => {
                    const input = document.getElementById('user-input');
                    const text = input.value.trim();
                    if (text) {
                        addMessage(text, true);
                        vscode.postMessage({ command: 'submit', text });
                        input.value = '';
                    }
                });
                
                // Request history and context on load
                window.addEventListener('load', () => {
                    vscode.postMessage({ command: 'getHistory' });
                    vscode.postMessage({ command: 'getContext' });
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

    // 3. Test command
    context.subscriptions.push(
        vscode.commands.registerCommand('jupyter-chatbot.testModel', async () => {
            try {
                const testResponse = await queryOllamaModel("Respond with just 'TEST PASSED'");
                vscode.window.showInformationMessage(`Ollama response: ${testResponse.trim()}`);
            } catch (error) {
                vscode.window.showErrorMessage(`Connection failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        })
    );
    
    // NEW: Clear history command
    context.subscriptions.push(
        vscode.commands.registerCommand('jupyter-chatbot.clearHistory', () => {
            provider.clearHistory();
            vscode.window.showInformationMessage('Chat history cleared');
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