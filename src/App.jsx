import { useDeferredValue, useEffect, useRef, useState } from 'react';

import ChatView from './components/ChatView';
import Composer from './components/Composer';
import ResizableDivider from './components/ResizableDivider';
import SettingsModal from './components/SettingsModal';
import Sidebar from './components/Sidebar';
import SpecialistModal from './components/SpecialistModal';
import SpecialistPickerModal from './components/SpecialistPickerModal';
import ExpertLibraryModal from './components/ExpertLibraryModal';
import LockScreen from './components/LockScreen';
import Onboarding from './components/Onboarding';
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

  return messages.map((message) => (message.id === tempId ? nextMessage : message));
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
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [specialistToEdit, setSpecialistToEdit] = useState(null);

  // Active Specialist Hubs — a panel of experts consulted for each message.
  const [activeSpecialistIds, setActiveSpecialistIds] = useState([]);
  const [activeSpecialistHubs, setActiveSpecialistHubs] = useState([]);

  // Roundtable: 'synthesized' (one blended answer) vs 'roundtable' (each Expert
  // speaks, then a moderator consolidates), plus how many rounds to go around.
  const [panelMode, setPanelMode] = useState('synthesized');
  const [rounds, setRounds] = useState(1);
  const [roundtableStatus, setRoundtableStatus] = useState(null);

  // Drag-and-drop document ingestion state.
  const [isDragging, setIsDragging] = useState(false);
  const [isIngestingDrop, setIsIngestingDrop] = useState(false);

  // Security: null until we have asked the main process. When the corpus is
  // encrypted and not yet opened, the whole app is replaced by the lock screen.
  const [security, setSecurity] = useState(null);

  // First-run guide: shown when Ollama is unreachable or no model is installed —
  // otherwise a new user faces an app that silently does nothing. Dismissible.
  const [showOnboarding, setShowOnboarding] = useState(false);
  // A ref, not state: refreshOllamaStatus is also called from a 15s interval whose
  // closure is captured once (deps [sidekick]). As state, this read as false forever,
  // so the onboarding wall reappeared seconds after "Skip for now" and the user could
  // not get past it. A ref is always current, whoever is reading it.
  const onboardingDismissedRef = useRef(false);

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
      setNotice(
        'Desktop bridge unavailable. Restart the app to reload the Electron preload script.',
      );
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

    // Nothing to talk to, or nothing to talk with — guide the user rather than
    // leaving them in a workspace that cannot answer.
    const needsSetup = !status.available || (listedModels || []).length === 0;
    setShowOnboarding(needsSetup && !onboardingDismissedRef.current);
    if (allSettings) {
      if (allSettings.webSearchEnabled !== undefined) {
        setWebSearchEnabled(allSettings.webSearchEnabled === 'true');
      }
      if (allSettings.activeTheme) {
        setTheme(allSettings.activeTheme);
      }
      if (allSettings.panelMode) {
        setPanelMode(allSettings.panelMode);
      }
      if (allSettings.roundtableRounds) {
        setRounds(Number(allSettings.roundtableRounds) || 1);
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

    // Restore the previously consulted panel of experts (filtered to those that
    // still exist).
    try {
      const settings = await sidekick.settings.get();
      const savedIds = settings?.activeSpecialistIds
        ? JSON.parse(settings.activeSpecialistIds)
        : [];
      if (Array.isArray(savedIds) && savedIds.length > 0) {
        const list = await sidekick.specialist.list().catch(() => []);
        const existing = new Set((list || []).map((h) => h.id));
        await applySpecialistSelection(savedIds.filter((id) => existing.has(id)));
      }
    } catch (_error) {
      // Non-fatal — start with no panel.
    }

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

  // Ask whether the corpus is locked BEFORE bootstrapping — every other IPC call is
  // refused while locked, so bootstrapping first would just produce errors.
  useEffect(() => {
    if (!sidekick) {
      setNotice(
        'Desktop bridge unavailable. Restart the app to reload the Electron preload script.',
      );
      return;
    }

    sidekick.security
      .status()
      .then((status) => {
        setSecurity(status);
        if (!status.locked) {
          bootstrap().catch((error) => setNotice(error.message));
        }
      })
      .catch(() => {
        // Older preload without the security surface: behave as before.
        setSecurity({ locked: false, encrypted: false });
        bootstrap().catch((error) => setNotice(error.message));
      });
  }, [sidekick]);

  // Called by the lock screen once the passphrase opens the corpus.
  async function handleUnlocked(status) {
    setSecurity(status);
    await bootstrap().catch((error) => setNotice(error.message));
  }

  // The main process can lock the corpus on its own (idle, suspend, workstation
  // lock). Clear the in-memory view as well — otherwise the corpus would be closed
  // on disk while its contents stayed on screen.
  useEffect(() => {
    if (!sidekick?.events?.onLocked) return undefined;
    return sidekick.events.onLocked((payload) => {
      setActiveConversation(null);
      setConversations([]);
      setActiveSpecialistHubs([]);
      setSecurity({ encrypted: true, locked: true, unlocked: false, remembered: false });
      setNotice(`Locked — ${payload?.reason || 'inactivity'}.`);
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

      // A roundtable finishes with no single message — its turns already arrived via
      // the turn events. Only refresh the conversation metadata and clear status.
      if (payload.roundtable) {
        setRoundtableStatus(null);
        if (payload.roundtable.stoppedEarly) {
          setNotice(`Discussion ended early: ${payload.roundtable.stoppedEarly}.`);
        }
        setActiveConversation((current) =>
          current && current.id === payload.conversationId
            ? { ...current, ...payload.conversation, messages: current.messages }
            : current,
        );
        return;
      }

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

    // ---- Roundtable turn events -------------------------------------------------
    // Each Expert's turn streams in as its own message, so the user watches the
    // discussion happen instead of waiting for a single answer.
    const removeTurnStart = sidekick.events.onTurnStart((payload) => {
      setRoundtableStatus(
        payload.kind === 'moderator'
          ? 'Moderator is summarizing the discussion…'
          : `Round ${payload.round} of ${payload.totalRounds} — ${payload.expertName} is speaking…`,
      );
      setActiveConversation((current) => {
        if (!current) return current;
        return {
          ...current,
          messages: [
            ...current.messages,
            {
              id: `turn:${payload.turnId}`,
              role: 'assistant',
              content: '',
              expertName: payload.expertName,
              round: payload.round,
              turnKind: payload.kind,
              status: 'streaming',
              createdAt: new Date().toISOString(),
            },
          ],
        };
      });
    });

    const removeTurnDelta = sidekick.events.onTurnDelta((payload) => {
      setActiveConversation((current) => {
        if (!current) return current;
        return {
          ...current,
          messages: current.messages.map((message) =>
            message.id === `turn:${payload.turnId}`
              ? { ...message, content: payload.content }
              : message,
          ),
        };
      });
    });

    const removeTurnComplete = sidekick.events.onTurnComplete((payload) => {
      setActiveConversation((current) => {
        if (!current) return current;
        const placeholderId = `turn:${payload.turnId}`;
        const finalMessage = {
          ...payload.message,
          expertName: payload.expertName,
          round: payload.round,
          turnKind: payload.kind === 'moderator' ? 'moderator' : payload.passed ? 'pass' : 'expert',
        };
        const hasPlaceholder = current.messages.some((m) => m.id === placeholderId);
        return {
          ...current,
          messages: hasPlaceholder
            ? current.messages.map((m) => (m.id === placeholderId ? finalMessage : m))
            : [...current.messages, finalMessage],
        };
      });
    });

    return () => {
      removeUpdate();
      removeComplete();
      removeError();
      removeTurnStart();
      removeTurnDelta();
      removeTurnComplete();
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
        conversation.id === conversationId
          ? { ...conversation, ...updatedConversation }
          : conversation,
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

  // Reflect a set of selected ids into hub objects (for header/badges) and persist
  // the selection so a consulting panel survives restarts.
  async function applySpecialistSelection(ids) {
    setActiveSpecialistIds(ids);
    if (sidekick) {
      const list = await sidekick.specialist.list().catch(() => []);
      const byId = new Map((list || []).map((h) => [h.id, h]));
      setActiveSpecialistHubs(ids.map((id) => byId.get(id)).filter(Boolean));
      await sidekick.settings.set('activeSpecialistIds', JSON.stringify(ids));
    }
  }

  // Toggle one expert in/out of the panel. `null` clears the whole panel
  // (the "General Assistant" choice).
  function handleSelectSpecialist(hubId) {
    if (!hubId) {
      applySpecialistSelection([]);
      return;
    }
    const next = activeSpecialistIds.includes(hubId)
      ? activeSpecialistIds.filter((id) => id !== hubId)
      : [...activeSpecialistIds, hubId];
    applySpecialistSelection(next);
  }

  async function handleSendMessage(content) {
    if (!sidekick) {
      return;
    }

    const result = await sidekick.chat.sendMessageStream({
      conversationId: activeConversationId,
      content,
      webSearchOverride: webSearchEnabled,
      activeSpecialistIds,
      panelModeOverride: panelMode,
      roundsOverride: rounds,
    });

    setStreamRequestId(result.requestId);
    setConversations((items) => moveConversationToFront(items, result.conversation));

    const isRoundtable = result.mode === 'roundtable';
    if (isRoundtable) {
      setRoundtableStatus('Convening the table…');
    }

    setActiveConversation((current) => {
      const baseMessages = current && current.id === result.conversation.id ? current.messages : [];

      return {
        ...result.conversation,
        messages: [
          ...baseMessages,
          result.userMessage,
          // In roundtable mode each Expert's turn arrives as its own message via the
          // turn events, so there is no single placeholder to fill.
          ...(isRoundtable
            ? []
            : [
                {
                  id: `stream:${result.requestId}`,
                  role: 'assistant',
                  content: '',
                  createdAt: new Date().toISOString(),
                  status: 'streaming',
                },
              ]),
        ],
      };
    });
  }

  // Drop a document anywhere on the workspace: it becomes an Expert immediately and
  // joins the consulting panel, so the user can ask about it in seconds.
  async function handleDropFiles(fileList) {
    if (!sidekick || !fileList || fileList.length === 0) return;

    const filePaths = Array.from(fileList)
      .map((file) => sidekick.files.getPath(file))
      .filter(Boolean);

    if (filePaths.length === 0) {
      setNotice('Could not read the dropped file. Try the upload button in an Expert instead.');
      return;
    }

    setIsIngestingDrop(true);
    setNotice(
      `Reading ${filePaths.length === 1 ? '1 document' : `${filePaths.length} documents`}…`,
    );
    try {
      const result = await sidekick.research.quickIngest({ filePaths });
      if (!result.success) {
        setNotice(`Could not use that document — ${result.reason}`);
        return;
      }

      // Consult the new Expert right away; that is the point of dropping it.
      await applySpecialistSelection([...new Set([...activeSpecialistIds, result.hub.id])]);
      setNotice(
        `📄 "${result.hub.name}" is ready (${result.chunksIndexed} chunks) and now being consulted — ask away.` +
          (result.filesFailed ? ` ${result.filesFailed} file(s) could not be read.` : ''),
      );
    } catch (error) {
      setNotice(`Could not use that document — ${error.message}`);
    } finally {
      setIsIngestingDrop(false);
    }
  }

  async function handlePanelModeChange(nextMode) {
    setPanelMode(nextMode);
    if (sidekick) {
      await sidekick.settings.set('panelMode', nextMode);
    }
  }

  async function handleRoundsChange(nextRounds) {
    setRounds(nextRounds);
    if (sidekick) {
      await sidekick.settings.set('roundtableRounds', String(nextRounds));
    }
  }

  // Stop going around the table; the moderator wraps up with what has been said.
  async function handleAnswerNow() {
    if (!sidekick || !streamRequestId) return;
    setRoundtableStatus('Wrapping up — moderator will answer shortly…');
    await sidekick.chat.answerNow(streamRequestId);
  }

  async function handleCancelGeneration() {
    if (!sidekick || !streamRequestId) {
      return;
    }

    await sidekick.chat.cancelGeneration(streamRequestId);
  }

  // Turn an assistant answer into a durable, retrievable note on an Expert. This is
  // how research findings become permanent knowledge instead of scrolling away.
  async function handleSaveNote({ hubId, content }) {
    if (!sidekick || !hubId || !content) return null;

    const firstLine =
      content
        .replace(/[#*`>]/g, '')
        .split('\n')
        .map((s) => s.trim())
        .find(Boolean) || 'Saved answer';
    const result = await sidekick.notes.create({
      hubId,
      title: firstLine.slice(0, 70),
      body: content,
      author: 'model',
      conversationId: activeConversationId,
    });

    setNotice(
      result.indexed
        ? `Saved as a note and indexed into the Expert's vault.`
        : `Note saved, but not indexed: ${result.reason || 'embedding unavailable'}`,
    );
    return result;
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

  // Locked corpus: nothing else may render. The main process independently refuses
  // every non-security IPC call, so this is a genuine gate, not just a cover.
  if (security && security.locked) {
    return <LockScreen sidekick={sidekick} status={security} onUnlocked={handleUnlocked} />;
  }

  // First run / no models: guide before showing an app that cannot answer.
  if (showOnboarding) {
    return (
      <Onboarding
        sidekick={sidekick}
        onDone={() => {
          onboardingDismissedRef.current = true;
          setShowOnboarding(false);
          refreshOllamaStatus().catch(() => {});
        }}
      />
    );
  }

  const activeTitle = activeConversation?.title || 'New Conversation';

  return (
    <main className="app-shell" style={{ gridTemplateColumns: `${sidebarWidth}px auto 1fr` }}>
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
        activeSpecialistHubs={activeSpecialistHubs}
      />

      <ResizableDivider onResize={handleResizeSidebar} />

      <section
        className={`workspace${isDragging ? ' workspace--dropping' : ''}`}
        onDragOver={(event) => {
          // Only react to actual files, not text selections being dragged around.
          if (Array.from(event.dataTransfer.types || []).includes('Files')) {
            event.preventDefault();
            setIsDragging(true);
          }
        }}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setIsDragging(false);
        }}
        onDrop={(event) => {
          if (Array.from(event.dataTransfer.types || []).includes('Files')) {
            event.preventDefault();
            setIsDragging(false);
            handleDropFiles(event.dataTransfer.files);
          }
        }}
      >
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
            {activeSpecialistHubs.length > 0 ? (
              <span
                className="consulting-label"
                onClick={() => setIsSpecialistPickerOpen(true)}
                title="Manage the consulting panel"
              >
                Consulting:
              </span>
            ) : null}
            {/* Show a few pills, then collapse — a large panel would otherwise push
                the header off the window. The full list stays available on hover. */}
            {activeSpecialistHubs.slice(0, 3).map((hub) => (
              <span
                key={hub.id}
                className="specialist-pill-header"
                onClick={() => setIsSpecialistPickerOpen(true)}
                title="Manage the consulting panel"
              >
                ⚡ {hub.name}
              </span>
            ))}
            {activeSpecialistHubs.length > 3 ? (
              <span
                className="specialist-pill-header"
                onClick={() => setIsSpecialistPickerOpen(true)}
                title={activeSpecialistHubs
                  .slice(3)
                  .map((hub) => hub.name)
                  .join(', ')}
              >
                +{activeSpecialistHubs.length - 3} more
              </span>
            ) : null}
            <ThemeToggle theme={theme} onToggle={handleToggleTheme} />
          </div>
        </header>

        {isDragging ? (
          <div className="drop-overlay">
            <div className="drop-overlay__panel">
              <strong>📄 Drop to ask about this document</strong>
              <span>It becomes an Expert you can consult — PDF, TXT, MD, JSON, CSV</span>
            </div>
          </div>
        ) : null}

        {isIngestingDrop ? (
          <div className="roundtable-status">📄 Indexing the document…</div>
        ) : null}

        {roundtableStatus ? <div className="roundtable-status">🗣️ {roundtableStatus}</div> : null}

        <div className="workspace__chat" ref={messagesRef}>
          <ChatView
            conversation={activeConversation}
            streamRequestId={streamRequestId}
            activeSpecialists={activeSpecialistHubs}
            onExportConversation={handleExportConversation}
            onSaveNote={handleSaveNote}
            onAddExpert={handleSelectSpecialist}
          />
        </div>

        <Composer
          disabled={disableComposer}
          isStreaming={!!streamRequestId}
          webSearchEnabled={webSearchEnabled}
          onToggleWebSearch={handleToggleWebSearch}
          onSend={handleSendMessage}
          onCancel={handleCancelGeneration}
          expertCount={activeSpecialistHubs.length}
          panelMode={panelMode}
          onPanelModeChange={handlePanelModeChange}
          rounds={rounds}
          onRoundsChange={handleRoundsChange}
          onAnswerNow={handleAnswerNow}
          isRoundtableRunning={!!streamRequestId && !!roundtableStatus}
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
        activeSpecialistIds={activeSpecialistIds}
        onSelectSpecialist={handleSelectSpecialist}
        onOpenCreateModal={() => {
          setSpecialistToEdit(null);
          setIsSpecialistModalOpen(true);
        }}
        onOpenEditModal={(hub) => {
          setSpecialistToEdit(hub);
          setIsSpecialistModalOpen(true);
        }}
        onOpenLibrary={() => setIsLibraryOpen(true)}
      />

      <ExpertLibraryModal
        isOpen={isLibraryOpen}
        onClose={() => setIsLibraryOpen(false)}
        sidekick={sidekick}
        // A freshly installed Expert joins the consulting panel immediately.
        onInstalled={(hub) =>
          applySpecialistSelection([...new Set([...activeSpecialistIds, hub.id])])
        }
      />

      <SpecialistModal
        key={specialistToEdit?.id || 'new'}
        isOpen={isSpecialistModalOpen}
        onClose={() => setIsSpecialistModalOpen(false)}
        sidekick={sidekick}
        hubToEdit={specialistToEdit}
        onHubSaved={(saved) => {
          if (activeSpecialistIds.includes(saved.id)) {
            setActiveSpecialistHubs((hubs) => hubs.map((h) => (h.id === saved.id ? saved : h)));
          }
        }}
      />
    </main>
  );
}
