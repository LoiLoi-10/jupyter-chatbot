import * as vscode from 'vscode';
import axios from 'axios';

export interface LLMConfig {
    provider: string;
    model: string;
    universityApiUrl: string;
}

export class LLMService {
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    private async getConfig(): Promise<LLMConfig> {
        const config = vscode.workspace.getConfiguration('jupyter-chatbot');
        const provider = config.get('llmProvider', 'ollama');
        
        // Set provider-appropriate default model
        const defaultModel = provider === 'ollama' 
            ? 'llama3' 
            : 'deepseek-r1:70b';
        
        return {
            provider: provider,
            model: config.get('model', defaultModel),
            universityApiUrl: config.get('universityApiUrl', 'http://chat.ese.ic.ac.uk:8080')
        };
    }

    async getResponse(prompt: string, context: string): Promise<string> {
        const config = await this.getConfig();
        const fullPrompt = `Notebook Context:\n${context}\n\nQuestion: ${prompt}\nAnswer:`;

        // Validate model for university server (without automatic reset, not working currently...)
        if (config.provider === 'university-server') {
            const apiKey = await this.context.secrets.get('universityApiKey');
            if (apiKey) {
                const models = await this.getAvailableModels();
                if (!models.includes(config.model) && models.length > 0) {
                    // Show warning but don't reset
                    vscode.window.showWarningMessage(
                        `Model "${config.model}" not available. Using anyway but may fail.`
                    );
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

    async getAvailableModels(providerOverride?: string): Promise<string[]> {
    // Get fresh configuration each time
    const config = await this.getConfig();

    const provider = providerOverride || config.provider;
    
    if (provider === 'university-server') {
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
            console.error('University model fetch error:', error);
            return [];
        }
    } else {
        // For Ollama, return llama3 as the only option
        return ['llama3'];
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
            }, { timeout: 30000 });
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

export interface LLMServiceInterface {
    getResponse(prompt: string, context: string): Promise<string>;
    getAvailableModels(): Promise<string[]>;
}