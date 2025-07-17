# Jupyter Chatbot Extension

A VS Code extension that adds AI-powered chat functionality to Jupyter notebooks, integrated with Ollama.

## Features

- Chat interface accessible from the VS Code activity bar
- Seamless integration with Jupyter notebooks (*.ipynb files)
- Powered by local Ollama instance (altered port 11435)

## Installation

1. Install the extension from VS Code marketplace
2. Ensure port is configure to 11435 (`$env:OLLAMA_HOST = "127.0.0.1:11435"`)
2. Ensure Ollama is running locally (`ollama serve`)

## Usage

1. Open a Jupyter notebook (.ipynb file)
2. Click the Jupyter Chatbot icon in the activity bar
3. Start chatting with the AI assistant

## Requirements

- VS Code v1.101.0 or newer
- Ollama installed and running
- Python extension (ms-python.python)

## Configuration

No additional configuration required. The extension automatically connects to Ollama on port 11435.

## Development

```bash
npm install
npm run package
code --install-extension dist/jupyter-chatbot-0.0.1.vsix --force