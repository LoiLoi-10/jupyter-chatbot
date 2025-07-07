import * as vscode from 'vscode';
import * as childProcess from 'child_process';
import { ChatbotPanel } from './webviewPanel'; // ADDED IMPORT

interface ManagedProcess {
    process: childProcess.ChildProcess;
    pid: number;
}

const activeProcesses: ManagedProcess[] = [];

class ChatbotNotebookSerializer implements vscode.NotebookSerializer {
    async deserializeNotebook(
        content: Uint8Array, 
        _token: vscode.CancellationToken
    ): Promise<vscode.NotebookData> {
        try {
            const contentString = Buffer.from(content).toString('utf-8');
            const rawContent = JSON.parse(contentString);
            
            const cells = rawContent.cells.map((cell: any) => {
                return new vscode.NotebookCellData(
                    cell.cell_type === 'code' ? 
                        vscode.NotebookCellKind.Code : 
                        vscode.NotebookCellKind.Markup,
                    Array.isArray(cell.source) ? cell.source.join('') : cell.source,
                    cell.cell_type === 'code' ? 'python' : 'markdown'
                );
            });
            
            return new vscode.NotebookData(cells);
        } catch (error) {
            console.error(`Failed to parse notebook: ${error}`);
            return new vscode.NotebookData([]);
        }
    }

    async serializeNotebook(
        data: vscode.NotebookData, 
        _token: vscode.CancellationToken
    ): Promise<Uint8Array> {
        const notebookContent = {
            cells: data.cells.map(cell => ({
                cell_type: cell.kind === vscode.NotebookCellKind.Code ? 'code' : 'markdown',
                source: cell.value.split('\n'),
                metadata: {}
            })),
            metadata: {
                kernelspec: {
                    display_name: "Python 3",
                    language: "python",
                    name: "python3"
                },
                language_info: {
                    name: "python"
                }
            }
        };
        
        return Buffer.from(JSON.stringify(notebookContent, null, 2), 'utf-8');
    }
}

function cleanUpProcesses() {
    const processesToKill = [...activeProcesses];
    activeProcesses.length = 0;

    processesToKill.forEach(procInfo => {
        try {
            if (procInfo.process && !procInfo.process.killed && procInfo.pid) {
                console.log(`Terminating process: ${procInfo.pid}`);
                
                if (process.platform === 'win32') {
                    try {
                        // Use taskkill for Windows
                        childProcess.execSync(`taskkill /pid ${procInfo.pid} /T /F`);
                    } catch (error) {
                        console.warn(`Failed to terminate ${procInfo.pid}: ${error}`);
                    }
                } else {
                    try {
                        // Use kill for Linux/Mac
                        process.kill(procInfo.pid, 'SIGTERM');
                        setTimeout(() => {
                            try {
                                process.kill(procInfo.pid, 'SIGKILL');
                            } catch {} // Ignore errors if already dead
                        }, 2000);
                    } catch (error) {
                        console.warn(`Error terminating process ${procInfo.pid}:`, error);
                    }
                }
            }
        } catch (error) {
            console.warn(`Error during cleanup: ${error}`);
        }
    });
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "jupyter-chatbot" is now active!');

    // Register notebook serializer
    context.subscriptions.push(
        vscode.workspace.registerNotebookSerializer(
            'jupyter-chatbot',
            new ChatbotNotebookSerializer(),
            { transientOutputs: true }
        )
    );

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('jupyter-chatbot.helloWorld', () => {
            vscode.window.showInformationMessage('Hello World from jupyter-chatbot!');
        })
    );

    // ADDED CHATBOT COMMAND REGISTRATION
    context.subscriptions.push(
        vscode.commands.registerCommand('jupyter-chatbot.openChat', () => {
            ChatbotPanel.createOrShow(context);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('jupyter-chatbot.startKernel', async () => {
            try {
                // Get the active Python interpreter
                const pythonPath = await getPythonPath();
                if (!pythonPath) {
                    vscode.window.showErrorMessage('Python interpreter not found. Install Python and reload window.');
                    return;
                }

                // Start the kernel
                const kernelProcess = childProcess.spawn(pythonPath, ['-m', 'ipykernel_launcher', '-f', '{connection_file}']);
                const pid = kernelProcess.pid;
                
                if (pid) {
                    activeProcesses.push({
                        process: kernelProcess,
                        pid: pid
                    });
                    
                    console.log(`Started kernel with PID: ${pid} using Python: ${pythonPath}`);
                    vscode.window.showInformationMessage(`Started kernel (PID: ${pid})`);
                    
                    kernelProcess.on('exit', (code) => {
                        console.log(`Kernel process ${pid} exited with code ${code}`);
                        const index = activeProcesses.findIndex(p => p.pid === pid);
                        if (index !== -1) {activeProcesses.splice(index, 1);}
                    });
                    
                    kernelProcess.on('error', (err) => {
                        console.error(`Kernel process error: ${err.message}`);
                        vscode.window.showErrorMessage(`Kernel error: ${err.message}`);
                    });
                } else {
                    vscode.window.showErrorMessage('Failed to start kernel: No PID assigned');
                }
            } catch (error: any) {
                vscode.window.showErrorMessage(`Failed to start kernel: ${error.message}`);
            }
        })
    );

    // Clean up on deactivation
    context.subscriptions.push({
        dispose: () => {
            console.log('Cleaning up processes...');
            cleanUpProcesses();
        }
    });
}

export function deactivate() {
    console.log('Deactivating extension...');
    cleanUpProcesses();
}

// Helper function to get the active Python path
async function getPythonPath(): Promise<string | undefined> {
    try {
        // First try to get from Python extension
        const extension = vscode.extensions.getExtension('ms-python.python');
        if (extension) {
            if (!extension.isActive) {await extension.activate();}
            const pythonPath = extension.exports.settings.getExecutionDetails().execCommand[0];
            if (pythonPath) {return pythonPath;}
        }
        
        // Fallback to system Python
        const pythonExecutables = ['python3', 'python'];
        for (const exe of pythonExecutables) {
            try {
                childProcess.execSync(`${exe} --version`);
                return exe;
            } catch {}
        }
        
        return undefined;
    } catch (error) {
        console.error('Error getting Python path:', error);
        return undefined;
    }
}