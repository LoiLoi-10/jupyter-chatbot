# Jupyter Chatbot Extension

A VS Code extension that adds AI-powered chat functionality to Jupyter notebooks, integrated with Ollama and Imperial College London's LLM servers.

## Features

- Chat interface accessible from the VS Code activity bar
- Seamless integration with Jupyter notebooks (*.ipynb files)
- Powered by local Ollama instance (altered port 11435)
- **Imperial College London Support**: Access university LLM servers with API key authentication
- Real-time model updates from university servers
- Secure API key storage in VS Code secret manager
- Dual-mode operation (local vs university servers)
- Automatic model synchronization for university users (Deepseek, Qwen, Gemma etc..)
## Installation

1. Install the extension from VS Code marketplace
2. Ensure port is configure to 11435 (`$env:OLLAMA_HOST = "127.0.0.1:11435"`)
3. Ensure Ollama is running locally (`ollama serve`)
- **Imperial College London Support**: 
1. Request permission/authentication from appropiate supervisor
2. Generate unique Api-Key 
3. Save Api-Key inside VS Code safe storage using `Set API Key` button

## Usage

1. Open a Jupyter notebook (.ipynb file)
2. Click the Jupyter Chatbot icon in the activity bar
3. Start chatting with the AI assistant

## Requirements

- VS Code v1.101.0 or newer
- Ollama installed and running
- Python extension (ms-python.python)
- Api-Key Authentication (ICL LLM)

## Configuration

The extension must manually connect to Ollama on port 11435 (Local Ollama). 
To access ICL server and models, authentication and unique API-Key generation is required. 
The Zscaler VPN is required to access college network and Wifi connection is needed.


## Development

```bash
npm install
npm run package
code --install-extension dist/jupyter-chatbot-0.0.1.vsix --force