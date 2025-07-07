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
                        const context = this._getNotebookContext();
                        this._panel.webview.postMessage({
                            command: 'notebookContext',
                            context: context
                        });
                        break;
                }
            },
            undefined,
            this._disposables
        );
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
            return response.data.response;
        } catch (error) {
            return `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    private _getNotebookContext(): string {
        const notebookEditor = vscode.window.activeNotebookEditor;
        if (!notebookEditor) {
            return "No active notebook found.";
        }
        
        let context = "Current Notebook Context:\n";
        for (const cell of notebookEditor.notebook.getCells()) {
            if (cell.kind === vscode.NotebookCellKind.Code || 
                cell.kind === vscode.NotebookCellKind.Markup) {
                context += `---\n${cell.document.getText()}\n`;
            }
        }
        
        return context;
    }

    private _getWebviewContent(): string {
        const toolkitUri = this._panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._context.extensionUri, 'node_modules', '@vscode', 'webview-ui-toolkit', 'dist', 'toolkit.min.js')
        );

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
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
                
                window.addEventListener('load', () => {
                    vscode.postMessage({ command: 'getNotebookContext' });
                });
                
                window.addEventListener('message', event => {
                    if (event.data.command === 'notebookContext') {
                        addMessage('System: Notebook context loaded', 'system');
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