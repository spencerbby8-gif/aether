"use client";

import { useEffect, useRef, useState } from "react";
import { useAether } from "@/hooks/useAether";
import { isModKey, useOnline } from "@/lib/hooks";

import { cn } from "@/lib/utils";
import { TaskPanel } from "@/components/agent-ui";
import { Composer, type ComposerHandle } from "@/components/composer";
import { MediaLightbox } from "@/components/media";
import { ChatHeader, MessageList } from "@/components/chat";
import { Icon } from "@/components/icons";
import { SearchModal, SettingsModal } from "@/components/modals";
import { Sidebar } from "@/components/sidebar";
import {
  EmptyState,
  ErrorState,
  MessagesSkeleton,
  OfflineBanner,
  Toaster,
  WorkspaceHome,
} from "@/components/views";

export default function AetherWorkspace() {
  const online = useOnline();
  const aether = useAether(online);

  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const dragDepth = useRef(0);
  const composerRef = useRef<ComposerHandle>(null);

  /* close the drawer automatically when moving to desktop */
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 1024px)");
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) setMenuOpen(false);
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  /* global hotkeys */
  useEffect(() => {
    aether.registerHotkeys((event) => {
      if (isModKey(event) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
    });
  }, [aether]);

  /* A dismissed error stays hidden; a *new* error message surfaces again. */
  const showErrorBanner = aether.lastError !== null && dismissedError !== aether.lastError;

  return (
    <div id="root-shell" className="flex h-dvh overflow-hidden bg-ink-900 text-fog-100">
      {/* sidebar — static on desktop, drawer on mobile */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 w-[282px] shrink-0 border-r border-line transition-transform duration-200 ease-out",
          menuOpen ? "translate-x-0" : "-translate-x-full",
          "lg:static lg:translate-x-0",
        )}
      >
        <Sidebar
          aether={aether}
          online={online}
          onClose={() => setMenuOpen(false)}
          onSearch={() => {
            setMenuOpen(false);
            setSearchOpen(true);
          }}
          onSettings={() => {
            setMenuOpen(false);
            setSettingsOpen(true);
          }}
        />
      </aside>
      {menuOpen ? (
        <button
          type="button"
          aria-label="Close navigation overlay"
          onClick={() => setMenuOpen(false)}
          className="fixed inset-0 z-30 bg-ink-950/60 backdrop-blur-[2px] lg:hidden"
        />
      ) : null}

      {/* main column */}
      <div
        className="flex min-w-0 flex-1 flex-col"
        onDragEnter={(event) => {
          if (!event.dataTransfer?.types.includes("Files")) return;
          event.preventDefault();
          dragDepth.current += 1;
          setDragOver(true);
        }}
        onDragOver={(event) => {
          if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
        }}
        onDragLeave={(event) => {
          if (!event.dataTransfer?.types.includes("Files")) return;
          event.preventDefault();
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragOver(false);
        }}
        onDrop={(event) => {
          if (!event.dataTransfer?.files?.length) return;
          event.preventDefault();
          dragDepth.current = 0;
          setDragOver(false);
          const files = Array.from(event.dataTransfer.files);
          aether.setView("chat");
          void composerRef.current?.addFiles(files).then(() => aether.touchFiles());
        }}
      >
        {!online ? <OfflineBanner /> : null}

        {aether.booted && aether.bootError ? (
          <ErrorState
            title="The workspace could not be opened"
            detail={aether.bootError}
            onRetry={aether.retryBoot}
          />
        ) : (
          <>
            <ChatHeader
              conversation={aether.activeConversation}
              view={aether.view}
              online={online}
              tasksActive={
                aether.liveTask !== null &&
                aether.liveTask.status !== "completed" &&
                aether.liveTask.status !== "failed" &&
                aether.liveTask.status !== "cancelled"
              }
              onRename={(id, title) => void aether.renameConversation(id, title)}
              onMenu={() => setMenuOpen(true)}
              onOpenTasks={() => setTasksOpen(true)}
            />

            {showErrorBanner ? (
              <div className="flex items-center gap-2.5 border-b border-danger-400/20 bg-danger-400/10 px-4 py-2 text-[12.5px] text-danger-400">
                <Icon name="alert" size={13} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{aether.lastError}</span>
                <button
                  type="button"
                  onClick={() => setDismissedError(aether.lastError)}
                  className="shrink-0 rounded p-1 transition-colors hover:bg-danger-400/15"
                  aria-label="Dismiss error"
                >
                  <Icon name="x" size={12} />
                </button>
              </div>
            ) : null}

            <main className="relative min-h-0 flex-1">
              {!aether.booted ? (
                <MessagesSkeleton />
              ) : aether.view === "workspace" ? (
                <div className="h-full overflow-y-auto">
                  <WorkspaceHome
                    statsVersion={aether.statsVersion}
                    recent={aether.conversations.slice(0, 6)}
                    tasks={aether.tasks}
                    onOpen={aether.openConversation}
                    onNewChat={aether.newChat}
                    onOpenTask={(task) => {
                      aether.openConversation(task.conversationId);
                      setTasksOpen(true);
                    }}
                  />
                </div>
              ) : aether.messagesLoading ? (
                <MessagesSkeleton />
              ) : aether.messages.length === 0 ? (
                <EmptyState onSuggest={(text) => void aether.send(text, [])} />
              ) : (
                <MessageList
                  messages={aether.messages}
                  streaming={aether.streaming}
                  onRetry={(id) => void aether.retry(id)}
                  conversationKey={aether.activeId ?? "new"}
                  onApprove={aether.resolveApproval}
                  liveTask={aether.liveTask}
                />
              )}

              {/* drag & drop overlay */}
              {dragOver ? (
                <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-ember-400/60 bg-ink-900/80 backdrop-blur-sm">
                  <div className="flex flex-col items-center gap-2 text-ember-300">
                    <Icon name="paperclip" size={26} />
                    <p className="text-sm font-medium">Drop files to attach them</p>
                    <p className="text-[12px] text-fog-500">Images and documents, up to 8 MB each</p>
                  </div>
                </div>
              ) : null}
            </main>

            {aether.view === "chat" ? (
              <Composer
                ref={composerRef}
                busy={aether.streaming}
                disabled={!aether.booted}
                onSend={(text, attachments) => void aether.send(text, attachments)}
                onStop={aether.stop}
                onCommand={aether.handleCommand}
              />
            ) : null}
          </>
        )}
      </div>

      {/* modals */}
      {searchOpen ? (
        <SearchModal
          onClose={() => setSearchOpen(false)}
          onOpen={(id) => aether.openConversation(id)}
        />
      ) : null}
      {settingsOpen ? (
        <SettingsModal
          settings={aether.settings}
          online={online}
          busy={aether.streaming}
          onClose={() => setSettingsOpen(false)}
          onUpdate={(patch) => void aether.updateSettings(patch)}
          onExport={() => void aether.exportData()}
          onWipe={() => void aether.wipeData()}
        />
      ) : null}

      <MediaLightbox />

      <TaskPanel
        open={tasksOpen}
        onClose={() => {
          setTasksOpen(false);
          setSelectedTaskId(null);
        }}
        tasks={aether.tasks}
        liveTask={aether.liveTask}
        selectedTaskId={selectedTaskId}
        onSelectTask={setSelectedTaskId}
        onPause={aether.pauseTask}
        onResume={aether.resumeTask}
        onCancel={aether.cancelTask}
        onRerun={(taskId) => {
          setTasksOpen(false);
          setSelectedTaskId(null);
          void aether.rerunTask(taskId);
        }}
        onApprove={aether.resolveApproval}
        onOpenConversation={(conversationId) => aether.openConversation(conversationId)}
      />

      <Toaster />
    </div>
  );
}
