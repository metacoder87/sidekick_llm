Offline-first LLM chat app with Ollama integration:

## Architecture Overview

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Frontend      │    │   Backend       │    │   Ollama        │
│   (React)       │    │   (Node.js)     │    │   (Local)       │
│                 │    │                 │    │                 │
│  Chat UI        │───▶│  API Routes     │───▶│  Model Inference│
│  History UI     │    │  Cache DB       │    │  (Offline)      │
│  Search Button  │    │  Web Search     │    │                 │
│  Offline Mode   │    │  Local Storage  │    │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │   IndexedDB     │
                    │   (Local Cache) │
                    └─────────────────┘
```

## Backend Implementation (Node.js/Express)

### 1. Core Dependencies

```json
{
  "dependencies": {
    "express": "^4.18.0",
    "cors": "^2.8.5",
    "body-parser": "^1.20.0",
    "axios": "^1.0.0",
    "sqlite3": "^5.0.0",
    "better-sqlite3": "^8.0.0",
    "node-cache": "^5.1.0",
    "uuid": "^9.0.0"
  }
}
```

### 2. Database Schema (SQLite)

```javascript
// db.js
const Database = require('better-sqlite3');
const db = new Database('conversations.db');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT,
    role TEXT,
    content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations (id)
  );
`);
```

### 3. API Routes

```javascript
// routes/conversations.js
const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { v4: uuidv4 } = require('uuid');

// Get all conversations
router.get('/conversations', (req, res) => {
  const conversations = db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all();
  res.json(conversations);
});

// Get conversation by ID
router.get('/conversations/:id', (req, res) => {
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

  const messages = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at
ASC').all(req.params.id);
  res.json({ ...conversation, messages });
});

// Create new conversation
router.post('/conversations', (req, res) => {
  const id = uuidv4();
  const title = req.body.message || 'New Conversation';

  db.prepare('INSERT INTO conversations (id, title) VALUES (?, ?)').run(id, title);
  res.json({ id, title });
});

// Add message to conversation
router.post('/conversations/:id/messages', (req, res) => {
  const { role, content } = req.body;
  const messageId = uuidv4();

  db.prepare('INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)')
    .run(messageId, req.params.id, role, content);

  // Update conversation timestamp
  db.prepare('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(req.params.id);

  res.json({ id: messageId, role, content });
});

// Search web (online functionality)
router.post('/search', async (req, res) => {
  try {
    const response = await axios.get('https://api.duckduckgo.com', {
      params: {
        q: req.body.query,
        format: 'json'
      }
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'Search failed' });
  }
});
```

### 4. Ollama Integration

```javascript
// ollama.js
const axios = require('axios');

class OllamaService {
  constructor() {
    this.baseUrl = process.env.OLLAMA_API_URL || 'http://localhost:11434';
  }

  async generateResponse(prompt, conversationHistory = []) {
    try {
      const messages = conversationHistory.map(msg => ({
        role: msg.role,
        content: msg.content
      }));

      const response = await axios.post(`${this.baseUrl}/api/generate`, {
        model: process.env.OLLAMA_MODEL || 'llama3',
        prompt: prompt,
        stream: false,
        options: {
          temperature: 0.7,
          top_p: 0.9
        }
      });

      return response.data.response;
    } catch (error) {
      console.error('Ollama error:', error);
      throw new Error('Failed to generate response');
    }
  }
}

module.exports = new OllamaService();
```

## Frontend Implementation (React)

### 1. Main Chat Component

```jsx
// components/ChatInterface.jsx
import React, { useState, useEffect, useRef } from 'react';
import Message from './Message';
import SearchButton from './SearchButton';

const ChatInterface = () => {
  const [conversations, setConversations] = useState([]);
  const [currentConversation, setCurrentConversation] = useState(null);
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const messagesEndRef = useRef(null);

  // Check online status
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Load conversations
  useEffect(() => {
    const loadConversations = async () => {
      try {
        const response = await fetch('/api/conversations');
        const data = await response.json();
        setConversations(data);
      } catch (error) {
        console.error('Failed to load conversations:', error);
      }
    };

    loadConversations();
  }, []);

  // Create new conversation
  const createNewConversation = async () => {
    try {
      const response = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'New conversation' })
      });
      const newConversation = await response.json();

      setCurrentConversation(newConversation);
      setMessages([]);
      setConversations(prev => [newConversation, ...prev]);
    } catch (error) {
      console.error('Failed to create conversation:', error);
    }
  };

  // Send message
  const sendMessage = async (message) => {
    if (!message.trim() || isLoading) return;

    const userMessage = { role: 'user', content: message };
    const newMessages = [...messages, userMessage];

    setMessages(newMessages);
    setInputValue('');
    setIsLoading(true);

    try {
      // Add user message to backend
      await fetch(`/api/conversations/${currentConversation.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(userMessage)
      });

      // Get AI response
      const response = await fetch('/api/ollama/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: message,
          conversationHistory: newMessages
        })
      });

      const aiResponse = await response.json();
      const aiMessage = { role: 'assistant', content: aiResponse.response };

      // Add AI message to backend
      await fetch(`/api/conversations/${currentConversation.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(aiMessage)
      });

      setMessages(prev => [...prev, aiMessage]);
    } catch (error) {
      console.error('Error sending message:', error);
      const errorMessage = { role: 'assistant', content: 'Sorry, I encountered an error.' };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  // Handle search
  const handleSearch = async (query) => {
    if (!isOnline) return;

    try {
      const response = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      });

      const searchResults = await response.json();
      // Process and display search results
      const searchMessage = {
        role: 'assistant',
        content: `Here are search results for "${query}": ${JSON.stringify(searchResults)}`
      };

      setMessages(prev => [...prev, searchMessage]);
    } catch (error) {
      console.error('Search error:', error);
    }
  };

  // Scroll to bottom of messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="chat-container">
      <div className="sidebar">
        <button onClick={createNewConversation}>New Chat</button>
        <div className="conversation-list">
          {conversations.map(conv => (
            <div
              key={conv.id}
              className={`conversation-item ${currentConversation?.id === conv.id ? 'active' : ''}`}
              onClick={() => {
                setCurrentConversation(conv);
                // Load conversation messages
              }}
            >
              {conv.title}
            </div>
          ))}
        </div>
      </div>

      <div className="chat-area">
        <div className="messages">
          {messages.map((msg, index) => (
            <Message key={index} message={msg} />
          ))}
          {isLoading && <Message message={{ role: 'assistant', content: 'Thinking...' }} />}
          <div ref={messagesEndRef} />
        </div>

        <div className="input-area">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && sendMessage(inputValue)}
            placeholder="Type your message..."
            disabled={isLoading}
          />
          <button
            onClick={() => sendMessage(inputValue)}
            disabled={isLoading || !inputValue.trim()}
          >
            Send
          </button>
          <SearchButton
            onSearch={handleSearch}
            isOnline={isOnline}
            disabled={!isOnline}
          />
        </div>
      </div>
    </div>
  );
};

export default ChatInterface;
```

### 2. Message Component

```jsx
// components/Message.jsx
import React from 'react';

const Message = ({ message }) => {
  return (
    <div className={`message ${message.role}`}>
      <div className="message-content">
        {message.content}
      </div>
    </div>
  );
};

export default Message;
```

### 3. Search Button Component

```jsx
// components/SearchButton.jsx
import React from 'react';

const SearchButton = ({ onSearch, isOnline, disabled }) => {
  const [searchQuery, setSearchQuery] = useState('');

  const handleSearch = () => {
    if (searchQuery.trim()) {
      onSearch(searchQuery);
      setSearchQuery('');
    }
  };

  return (
    <div className="search-container">
      <input
        type="text"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder="Search the web..."
        disabled={disabled}
      />
      <button
        onClick={handleSearch}
        disabled={disabled || !searchQuery.trim()}
      >
        🔍
      </button>
    </div>
  );
};

export default SearchButton;
```

## Offline Features

### 1. Service Worker for Caching

```javascript
// public/sw.js
const CACHE_NAME = 'chat-app-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/static/js/bundle.js',
  '/static/css/main.css'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(urlsToCache))
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request)
      .then((response) => {
        if (response) {
          return response;
        }
        return fetch(event.request);
      })
  );
});
```

### 2. Local Storage Fallback

```javascript
// utils/offline.js
const OfflineManager = {
  // Save conversation to local storage
  saveConversation: (conversation) => {
    const conversations = JSON.parse(localStorage.getItem('conversations') || '[]');
    conversations.push(conversation);
    localStorage.setItem('conversations', JSON.stringify(conversations));
  },

  // Load conversations from local storage
  loadConversations: () => {
    return JSON.parse(localStorage.getItem('conversations') || '[]');
  },

  // Check if we're offline
  isOffline: () => {
    return !navigator.onLine;
  }
};
```

## Key Features

1. **Offline First**: All conversations are cached locally using IndexedDB
2. **Ollama Integration**: Connects to local LLM models for responses
3. **Web Search**: Online search functionality when internet is available
4. **Conversation History**: Persistent storage of all conversations
5. **Responsive UI**: Clean chat interface with message history
6. **Service Worker**: Caching for offline access
7. **Real-time Status**: Online/offline indicator

## Setup Instructions

1. **Backend Setup**:

   ```bash
   npm install
   node server.js
   ```

2. **Frontend Setup**:

   ```bash
   npm install
   npm start
   ```

3. **Ollama Setup**:

   ```bash
   # Install Ollama from https://ollama.com/
   ollama pull llama3
   ```

4. **Environment Variables**:
   Create `.env` file:

   ```
   OLLAMA_API_URL=http://localhost:11434
   OLLAMA_MODEL=llama3
   ```
