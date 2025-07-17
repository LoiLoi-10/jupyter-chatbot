import * as vscode from 'vscode';
import axios from 'axios';  

class ChatbotViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _context: vscode.ExtensionContext;
    private _ollamaEndpoint = 'http://localhost:11435/api/generate';  

    constructor(context: vscode.ExtensionContext) {
        this._context = context;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._context.extensionUri]
        };

        webviewView.webview.html = this._getWebviewContent(webviewView.webview);

        webviewView.show?.(true);

        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'submit':
                    const response = await this._getOllamaResponse(message.text);
                    this._view?.webview.postMessage({ 
                        command: 'response', 
                        text: response
                    });
                    break;
                
                case 'getContext':
                    this._view?.webview.postMessage({ 
                        command: 'contextUpdate',
                        context: this._getNotebookContext()
                    });
                    break;
            }
        });

        // Send initial context
        this._view?.webview.postMessage({ 
            command: 'contextUpdate',
            context: this._getNotebookContext()
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
        const editor = vscode.window.activeTextEditor;
        if (!editor?.document?.fileName.endsWith('.ipynb')) {
            return "No active Jupyter notebook found.";
        }

        try {
            const notebook = JSON.parse(editor.document.getText());
            return notebook.cells
                .map((cell: any) => {
                    if (cell.cell_type === 'markdown') {
                        return `## Markdown\n${cell.source.join('')}`;
                    } else if (cell.cell_type === 'code') {
                        return `## Code\n${cell.source.join('')}`;
                    }
                    return '';
                })
                .filter(Boolean)
                .join('\n\n');
        } catch (error) {
            return "Failed to parse notebook content.";
        }
    }

    private _getWebviewContent(webview: vscode.Webview): string {
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._context.extensionUri, 'media', 'styles.css')
        );
        
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Jupyter Chatbot</title>
            <link href="${styleUri}" rel="stylesheet">
            <script type="module" src="https://cdn.jsdelivr.net/npm/@vscode/webview-ui-toolkit/dist/toolkit.min.js"></script>
        </head>
        <body>
            <div class="chat-container">
                <div id="context-view">
                    <h3>Notebook Context</h3>
                    <div id="context-content"></div>
                </div>
                <div id="chat-history"></div>
                <div class="input-area">
                    <vscode-text-area id="user-input" placeholder="Ask about your notebook..."></vscode-text-area>
                    <vscode-button id="send-button">Send</vscode-button>
                </div>
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                
                // Handle messages from extension
                window.addEventListener('message', event => {
                    const message = event.data;
                    switch (message.command) {
                        case 'response':
                            addMessage(message.text, false);
                            break;
                        case 'contextUpdate':
                            updateContext(message.context);
                            break;
                    }
                });
                
                function updateContext(context) {
                    document.getElementById('context-content').textContent = context;
                }
                
                function addMessage(text, isUser) {
                    const history = document.getElementById('chat-history');
                    const message = document.createElement('div');
                    message.className = isUser ? 'user-message' : 'bot-message';
                    message.textContent = text;
                    history.appendChild(message);
                    // Auto-scroll to bottom
                    history.scrollTop = history.scrollHeight;
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
                
                // Initial context request
                vscode.postMessage({ command: 'getContext' });
            </script>
        </body>
        </html>`;
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
        vscode.window.registerWebviewViewProvider('jupyter-chatbot-view', provider)
    );

    // 3. Test command
    context.subscriptions.push(
        vscode.commands.registerCommand('jupyter-chatbot.testModel', async () => {
            try {
                const testResponse = await queryOllamaModel("Respond with just 'TEST PASSED'");
                vscode.window.showInformationMessage(`Ollama response: ${testResponse.trim()}`);
            } catch (error) {
                vscode.window.showErrorMessage(`Connection failed: ${error}`);
            }
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