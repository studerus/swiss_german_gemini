# Swiss German Gemini Chat

A React-based chat application that uses Google Gemini for response generation and supports various Swiss German dialects.

[![Demo Video](https://img.youtube.com/vi/C0IQrF4O-6Y/0.jpg)](https://www.youtube.com/watch?v=C0IQrF4O-6Y)

## Features

- Swiss German speech input and output
- Support for various Swiss German dialects:
  - Aargau German
  - Bernese German
  - Basel German
  - Graubünden German
  - Lucerne German
  - St. Gallen German
  - Valais German
  - Zurich German
- Real-time chat functionality with Google Gemini API
- Modern and responsive user interface with Material-UI

## Technology Stack

- **Frontend**: React with TypeScript and Material-UI
- **Text Generation**: Google Gemini API
- **Speech-to-Text**: Microsoft Azure Speech Services
- **Text-to-Speech**: [STT4SG](https://stt4sg.fhnw.ch/) - Swiss German speech synthesis
- **Build Tool**: Vite

## Prerequisites

- Node.js (Version 18 or higher) - [Download here](https://nodejs.org/)

## Installation

1. Clone the repository:
```bash
git clone https://github.com/studerus/swiss_german_gemini
cd swiss_german_gemini
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the root directory based on `.env.example` and add your API keys:
```
VITE_GEMINI_API_KEY=your_gemini_api_key_here
VITE_AZURE_SPEECH_KEY=your_azure_speech_key_here
VITE_AZURE_SPEECH_REGION=your_azure_region_here
```

4. Start the development server:
```bash
npm run dev
```

## Usage

1. Open the application in your browser
2. Select your desired Swiss German dialect
3. You can either:
   - Enter text via the input field
   - Use the microphone for speech input
4. The response will be displayed as text and read aloud in Swiss German

## API Services

- **Google Gemini**: Used for chat response generation
- **STT4SG**: Specialized Swiss German speech synthesis by FHNW
- **Microsoft Azure Speech Services**: Used for Speech-to-Text functionality

## API Key Setup

To fully use the application, you need the following API keys:

1. **Google Gemini API Key**
   - Visit the [Google AI Studio Console](https://makersuite.google.com/app/apikey)
   - Create a new API key
   - Copy the key to your `.env` file as `VITE_GEMINI_API_KEY`

2. **Microsoft Azure Speech Services**
   - Create an [Azure Account](https://azure.microsoft.com/en-us/free/)
   - Create a Speech Services resource
   - Copy the key and region to your `.env` file as:
     - `VITE_AZURE_SPEECH_KEY`
     - `VITE_AZURE_SPEECH_REGION`

## Security Notes

- Never share your API keys
- The `.env` file is already listed in `.gitignore` and won't be synchronized with Git
- Check before each commit that no sensitive data is included in the code

## License

MIT
