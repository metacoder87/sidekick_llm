import { useDeferredValue, useEffect, useRef, useState } from 'react';

import ChatView from './components/ChatView';
import Composer from './components/Composer';
import Sidebar from './components/Sidebar';

function moveConversationToFront(items, conversation) {
  const rest = items.filter((item) => item.id !== conversation.id);
  return [conversation, ...rest];
}

function replaceStreamingMessage(messages, requestId, nextMessage) {
  const tempId = `stream:${requestId}`;
  const hasTemp = messages.some((message) => message.id === tempId);

  if (!hasTemp) {
    return [...messages, nextMessage];
  }

  return messages.map((message) =>
    message.id === tempId
      ? nextMessage
      : message,
  );
}

export default function App() {
  const sidekick = window.sidekick || null;
  const [conversations, setConversations] = useState([]);
  const [activeConversation, setActiveConversation] = useState(null);
  const [models, setModels] = useState([]);
  const [activeModel, setActiveModel] = useState('');
  const [ollamaStatus, setOllamaStatus] = useState({
    available: false,
    baseUrl: 'http://localhost:11434',
    models: [],
    error: 'Checking connection...',
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [streamRequestId, setStreamRequestId] = useState('');
  const [notice, setNotice] = useState('');
  const deferredSearch = useDeferredValue(searchQuery);
  const messagesRef = useRef(null);

  const activeConversationId = activeConversation?.id || null;
  const disableComposer = !sidekick || !ollamaStatus.available || !activeModel || !!streamRequestId;

  async function refreshOllamaStatus() {
    if (!sidekick) {
      setNotice('Desktop bridge unavailable. Restart the app to reload the Electron preload script.');
      return;
    }

    const [status, listedModels, selectedModel] = await Promise.all([
      sidekick.ollama.getStatus(),
      sidekick.models.list().catch(() => []),
      sidekick.models.getActive().catch(() => ''),
    ]);

    setOllamaStatus(status);
    setModels(listedModels);
    setActiveModel(selectedModel);
  }

  async function refreshConversationList(query = '') {
    if (!sidekick) {
      return;
    }

    const nextConversations = query
      ? await sidekick.chat.searchConversations(query)
      : await sidekick.chat.listConversations();

    setConversations(nextConversations);

    if (!activeConversationId && nextConversations[0]) {
      await loadConversation(nextConversations[0].id);
      return;
    }

    if (
      activeConversationId &&
      !nextConversations.some((conversation) => conversation.id === activeConversationId)
    ) {
      if (nextConversations[0]) {
        await loadConversation(nextConversations[0].id);
      } else {
        setActiveConversation(null);
      }
    }
  }

  async function loadConversation(conversationId) {
    if (!conversationId) {
      setActiveConversation(null);
      return;
    }

    if (!sidekick) {
      return;
    }

    const conversation = await sidekick.chat.getConversation(conversationId);
    setActiveConversation(conversation);
  }

  async function bootstrap() {
    await Promise.all([refreshConversationList(), refreshOllamaStatus()]);
  }

  useEffect(() => {
    if (!sidekick) {
      setNotice('Desktop bridge unavailable. Restart the app to reload the Electron preload script.');
      return;
    }

    bootstrap().catch((error) => {
      setNotice(error.message);
    });
  }, [sidekick]);

  useEffect(() => {
    if (!sidekick) {
      return;
    }

    refreshConversationList(deferredSearch).catch((error) => {
      setNotice(error.message);
    });
  }, [deferredSearch, sidekick]);

  useEffect(() => {
    if (!sidekick) {
      return undefined;
    }

    const updateTimer = setInterval(() => {
      refreshOllamaStatus().catch(() => {
        // Ignore polling errors; status view handles unavailable Ollama.
      });
    }, 15000);

    return () => clearInterval(updateTimer);
  }, [sidekick]);

  useEffect(() => {
    messagesRef.current?.scrollTo({
      top: messagesRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [activeConversation, streamRequestId]);

  useEffect(() => {
    if (!sidekick) {
      return undefined;
    }

    const removeUpdate = sidekick.events.onStreamUpdate((payload) => {
      setActiveConversation((current) => {
        if (!current || current.id !== payload.conversationId) {
          return current;
        }

        return {
          ...current,
          messages: replaceStreamingMessage(current.messages, payload.requestId, {
            id: `stream:${payload.requestId}`,
            role: 'assistant',
            content: payload.content,
            createdAt: new Date().toISOString(),
            status: 'streaming',
          }),
        };
      });
    });

    const removeComplete = sidekick.events.onStreamComplete((payload) => {
      setStreamRequestId((currentId) => (currentId === payload.requestId ? '' : currentId));
      setConversations((items) => moveConversationToFront(items, payload.conversation));
      setActiveConversation((current) => {
        if (!current || current.id !== payload.conversationId) {
          return current;
        }

        return {
          ...payload.conversation,
          messages: replaceStreamingMessage(current.messages, payload.requestId, payload.message),
        };
      });
    });

    const removeError = sidekick.events.onStreamError((payload) => {
      setStreamRequestId((currentId) => (currentId === payload.requestId ? '' : currentId));
      setNotice(payload.error);
      setActiveConversation((current) => {
        if (!current || current.id !== payload.conversationId) {
          return current;
        }

        return {
          ...current,
          messages: replaceStreamingMessage(current.messages, payload.requestId, {
            id: `error:${payload.requestId}`,
            role: 'assistant',
            content: payload.error,
            createdAt: new Date().toISOString(),
            status: 'error',
          }),
        };
      });
    });

    return () => {
      removeUpdate();
      removeComplete();
      removeError();
    };
  }, [sidekick]);

  async function handleCreateConversation() {
    if (!sidekick) {
      return;
    }

    const conversation = await sidekick.chat.createConversation();
    setConversations((items) => moveConversationToFront(items, conversation));
    setActiveConversation({
      ...conversation,
      messages: [],
    });
  }

  async function handleRenameConversation(conversationId, title) {
    if (!sidekick) {
      return;
    }

    const updatedConversation = await sidekick.chat.renameConversation({
      conversationId,
      title,
    });

    setConversations((items) =>
      items.map((conversation) =>
        conversation.id === conversationId ? { ...conversation, ...updatedConversation } : conversation,
      ),
    );

    setActiveConversation((current) =>
      current?.id === conversationId ? { ...current, ...updatedConversation } : current,
    );
  }

  async function handleDeleteConversation(conversationId) {
    if (!sidekick) {
      return;
    }

    const accepted = window.confirm('Delete this conversation from local history?');
    if (!accepted) {
      return;
    }

    await sidekick.chat.deleteConversation(conversationId);
    setConversations((items) => items.filter((conversation) => conversation.id !== conversationId));

    if (activeConversationId === conversationId) {
      const fallback = conversations.find((conversation) => conversation.id !== conversationId);
      if (fallback) {
        await loadConversation(fallback.id);
      } else {
        setActiveConversation(null);
      }
    }
  }

  async function handleModelChange(modelName) {
    if (!sidekick) {
      return;
    }

    await sidekick.models.setActive(modelName);
    setActiveModel(modelName);
  }

  async function handleSendMessage(content) {
    if (!sidekick) {
      return;
    }

    const result = await sidekick.chat.sendMessageStream({
      conversationId: activeConversationId,
      content,
    });

    setStreamRequestId(result.requestId);
    setConversations((items) => moveConversationToFront(items, result.conversation));
    setActiveConversation((current) => {
      const baseMessages =
        current && current.id === result.conversation.id ? current.messages : [];

      return {
        ...result.conversation,
        messages: [
          ...baseMessages,
          result.userMessage,
          {
            id: `stream:${result.requestId}`,
            role: 'assistant',
            content: '',
            createdAt: new Date().toISOString(),
            status: 'streaming',
          },
        ],
      };
    });
  }

  async function handleCancelGeneration() {
    if (!sidekick || !streamRequestId) {
      return;
    }

    await sidekick.chat.cancelGeneration(streamRequestId);
  }

  async function handleExportConversation(conversationId) {
    if (!sidekick) {
      return;
    }

    const result = await sidekick.chat.exportConversation(conversationId);
    if (result.saved) {
      setNotice(`Saved conversation export to ${result.filePath}`);
    }
  }

  async function handleExportAll() {
    if (!sidekick) {
      return;
    }

    const result = await sidekick.chat.exportAll();
    if (result.saved) {
      setNotice(`Saved history export to ${result.filePath}`);
    }
  }

  let headerCopy = 'All history is stored locally in the app database.';
  if (notice) {
    headerCopy = notice;
  } else if (!ollamaStatus.available) {
    headerCopy = 'Start Ollama and load a model to begin streaming responses.';
  } else if (!activeModel) {
    headerCopy = 'Select an available Ollama model.';
  }

  return (
    <main className="app-shell">
      <Sidebar
        conversations={conversations}
        activeConversationId={activeConversationId}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        onNewConversation={handleCreateConversation}
        onSelectConversation={loadConversation}
        onRenameConversation={handleRenameConversation}
        onDeleteConversation={handleDeleteConversation}
        onExportAll={handleExportAll}
        models={models}
        activeModel={activeModel}
        onModelChange={handleModelChange}
        ollamaStatus={ollamaStatus}
        disableModelSelection={!!streamRequestId}
      />

      <section className="workspace">
        <header className="workspace__banner">
          <p>Session</p>
          <h2>{headerCopy}</h2>
        </header>

        <div className="workspace__chat" ref={messagesRef}>
          <ChatView
            conversation={activeConversation}
            streamRequestId={streamRequestId}
            onExportConversation={handleExportConversation}
          />
        </div>

        <Composer
          disabled={disableComposer}
          isStreaming={!!streamRequestId}
          onSend={handleSendMessage}
          onCancel={handleCancelGeneration}
        />
      </section>
    </main>
  );
}
