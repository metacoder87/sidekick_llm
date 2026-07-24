import { useDeferredValue, useEffect, useRef, useState } from 'react';

import ChatView from './components/ChatView';
import Composer from './components/Composer';
import ResizableDivider from './components/ResizableDivider';
import SettingsModal from './components/SettingsModal';
import Sidebar from './components/Sidebar';
import SpecialistModal from './components/SpecialistModal';
import SpecialistPickerModal from './components/SpecialistPickerModal';
import ThemeToggle from './components/ThemeToggle';

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
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [theme, setTheme] = useState('cyberpunk');
  const [sidebarWidth, setSidebarWidth] = useState(320);

  // Modals state
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSpecialistPickerOpen, setIsSpecialistPickerOpen] = useState(false);
  const [isSpecialistModalOpen, setIsSpecialistModalOpen] = useState(false);
  const [specialistToEdit, setSpecialistToEdit] = useState(null);

  // Active Specialist Hub
  const [activeSpecialistId, setActiveSpecialistId] = useState(null);
  const [activeSpecialistHub, setActiveSpecialistHub] = useState(null);

  const deferredSearch = useDeferredValue(searchQuery);
  const messagesRef = useRef(null);

  const activeConversationId = activeConversation?.id || null;
  const disableComposer = !sidekick || !ollamaStatus.available || !activeModel || !!streamRequestId;

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  function handleResizeSidebar(newX) {
    // Clamp sidebar width between 200px and 520px
    const clamped = Math.max(200, Math.min(newX, 520));
    setSidebarWidth(clamped);
  }

  async function handleToggleTheme(newTheme) {
    setTheme(newTheme);
    if (sidekick) {
      await sidekick.settings.set('activeTheme', newTheme);
    }
  }

  async function refreshOllamaStatus() {
    if (!sidekick) {
      setNotice('Desktop bridge unavailable. Restart the app to reload the Electron preload script.');
      return;
    }

    const [status, listedModels, selectedModel, allSettings] = await Promise.all([
      sidekick.ollama.getStatus(),
      sidekick.models.list().catch(() => []),
      sidekick.models.getActive().catch(() => ''),
      sidekick.settings.get().catch(() => ({})),
    ]);

    setOllamaStatus(status);
    setModels(listedModels);
    setActiveModel(selectedModel);
    if (allSettings) {
      if (allSettings.webSearchEnabled !== undefined) {
        setWebSearchEnabled(allSettings.webSearchEnabled === 'true');
      }
      if (allSettings.activeTheme) {
        setTheme(allSettings.activeTheme);
      }
    }
  }

  async function handleToggleWebSearch(enabled) {
    setWebSearchEnabled(enabled);
    if (sidekick) {
      await sidekick.settings.set('webSearchEnabled', enabled ? 'true' : 'false');
    }
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

    // Surface database corruption instead of failing silently. The corpus is the
    // asset — if SQLite reports an integrity problem, the user needs to know before
    // trusting or writing to it (see ROADMAP §5 Phase −1).
    try {
      const integrity = await sidekick.system.getIntegrity();
      if (integrity && integrity.ok === false) {
        setNotice(
          `⚠️ Local database integrity check failed (${integrity.detail}). ` +
            `A backup of your data may be needed — avoid heavy use until resolved.`,
        );
      }
    } catch (_error) {
      // Integrity channel unavailable (older preload); non-fatal.
    }
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
      refreshOllamaStatus().catch(() => {});
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
            citations: payload.citations,
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

  async function handleSelectSpecialist(hubId) {
    setActiveSpecialistId(hubId);
    if (!hubId) {
      setActiveSpecialistHub(null);
    } else if (sidekick) {
      const hub = await sidekick.specialist.list().then((list) => list.find((h) => h.id === hubId));
      setActiveSpecialistHub(hub || null);
    }
  }

  async function handleSendMessage(content) {
    if (!sidekick) {
      return;
    }

    const result = await sidekick.chat.sendMessageStream({
      conversationId: activeConversationId,
      content,
      webSearchOverride: webSearchEnabled,
      activeSpecialistId,
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
      setNotice(`Saved corpus export to ${result.filePath}`);
    }
  }

  async function handleImportAll() {
    if (!sidekick) {
      return;
    }

    try {
      const result = await sidekick.chat.importAll();
      if (result.cancelled) {
        return;
      }
      if (result.imported) {
        const c = result.counts;
        setNotice(
          `Imported ${c.conversations} conversations, ${c.userMemories} memories, ` +
            `${c.specialistHubs} experts (${c.specialistChunks} knowledge chunks).`,
        );
        await refreshConversationList();
      }
    } catch (error) {
      setNotice(`Import failed: ${error.message}`);
    }
  }

  const activeTitle = activeConversation?.title || 'New Conversation';

  return (
    <main
      className="app-shell"
      style={{ gridTemplateColumns: `${sidebarWidth}px auto 1fr` }}
    >
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
        onImportAll={handleImportAll}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenSpecialistPicker={() => setIsSpecialistPickerOpen(true)}
        activeSpecialistHub={activeSpecialistHub}
      />

      <ResizableDivider onResize={handleResizeSidebar} />

      <section className="workspace">
        <header className="workspace__banner">
          <div className="workspace__banner-info">
            <h2 className="header-chat-title">{activeTitle}</h2>
            {notice ? <span className="notice-badge">{notice}</span> : null}
          </div>
          <div className="workspace__banner-right">
            {activeModel ? (
              <span
                className="model-pill-header"
                onClick={() => setIsSettingsOpen(true)}
                title="Click to change local model"
              >
                🤖 {activeModel}
              </span>
            ) : null}
            {activeSpecialistHub ? (
              <span className="specialist-pill-header">
                ⚡ {activeSpecialistHub.name}
              </span>
            ) : null}
            <ThemeToggle theme={theme} onToggle={handleToggleTheme} />
          </div>
        </header>

        <div className="workspace__chat" ref={messagesRef}>
          <ChatView
            conversation={activeConversation}
            streamRequestId={streamRequestId}
            activeSpecialist={activeSpecialistHub}
            onExportConversation={handleExportConversation}
          />
        </div>

        <Composer
          disabled={disableComposer}
          isStreaming={!!streamRequestId}
          webSearchEnabled={webSearchEnabled}
          onToggleWebSearch={handleToggleWebSearch}
          onSend={handleSendMessage}
          onCancel={handleCancelGeneration}
        />
      </section>

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        sidekick={sidekick}
        models={models}
        activeModel={activeModel}
        onModelChange={handleModelChange}
        ollamaStatus={ollamaStatus}
        webSearchEnabled={webSearchEnabled}
        onToggleWebSearch={handleToggleWebSearch}
      />

      <SpecialistPickerModal
        isOpen={isSpecialistPickerOpen}
        onClose={() => setIsSpecialistPickerOpen(false)}
        sidekick={sidekick}
        activeSpecialistId={activeSpecialistId}
        onSelectSpecialist={handleSelectSpecialist}
        onOpenCreateModal={() => {
          setSpecialistToEdit(null);
          setIsSpecialistModalOpen(true);
        }}
        onOpenEditModal={(hub) => {
          setSpecialistToEdit(hub);
          setIsSpecialistModalOpen(true);
        }}
      />

      <SpecialistModal
        key={specialistToEdit?.id || 'new'}
        isOpen={isSpecialistModalOpen}
        onClose={() => setIsSpecialistModalOpen(false)}
        sidekick={sidekick}
        hubToEdit={specialistToEdit}
        onHubSaved={(saved) => {
          if (activeSpecialistId === saved.id) {
            setActiveSpecialistHub(saved);
          }
        }}
      />
    </main>
  );
}
