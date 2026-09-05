"use client";

import { useMemo, useRef, useState } from "react";
import type { Conversation, Project } from "@/lib/types";
import { cn, dayBucket, timeAgo } from "@/lib/utils";
import { Icon, Logo } from "./icons";
import type { Aether } from "@/hooks/useAether";

interface SidebarProps {
  aether: Aether;
  online: boolean;
  onClose: () => void;
  onSearch: () => void;
  onSettings: () => void;
}

export function Sidebar({ aether, online, onClose, onSearch, onSettings }: SidebarProps) {
  const {
    booted,
    visibleConversations,
    activeId,
    view,
    projects,
    projectFilter,
    settings,
  } = aether;

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [instructionsDraft, setInstructionsDraft] = useState("");
  const newProjectInputRef = useRef<HTMLInputElement>(null);

  const groups = useMemo(() => {
    const map = new Map<string, Conversation[]>();
    for (const conversation of visibleConversations) {
      const bucket = dayBucket(conversation.updatedAt);
      const list = map.get(bucket) ?? [];
      list.push(conversation);
      map.set(bucket, list);
    }
    return Array.from(map.entries());
  }, [visibleConversations]);

  const commitRename = async () => {
    if (editingId) {
      await aether.renameConversation(editingId, editValue);
      setEditingId(null);
    }
  };

  const startProject = () => {
    setCreatingProject(true);
    setProjectName("");
    setTimeout(() => newProjectInputRef.current?.focus(), 30);
  };

  const commitProject = async () => {
    if (projectName.trim()) await aether.createProject(projectName);
    setCreatingProject(false);
    setProjectName("");
  };

  const statusLabel = !online
    ? "Offline · engines unreachable"
    : `Engine fleet · routing ${settings.provider === "auto" ? "AUTO" : settings.provider.toUpperCase()}`;

  return (
    <div className="flex h-full flex-col bg-ink-950">
      {/* brand */}
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg border border-ember-400/30 bg-ink-800 text-ember-400 shadow-[0_0_22px_-6px_rgba(226,177,97,0.45),inset_0_1px_0_rgba(255,255,255,0.05)]">
            <Logo size={18} />
          </span>
          <span className="font-display text-[17px] font-semibold tracking-[-0.015em]">Aether</span>
          <span className="rounded-full border border-line px-2 py-0.5 text-[9.5px] font-medium uppercase tracking-[0.12em] text-fog-600">
            Phase 5
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-1.5 text-fog-500 transition-colors hover:bg-ink-800 hover:text-fog-200 lg:hidden"
          aria-label="Close menu"
        >
          <Icon name="x" size={16} />
        </button>
      </div>

      {/* primary actions */}
      <div className="space-y-2 px-3 pb-3 pt-2">
        <button
          type="button"
          onClick={() => {
            aether.newChat();
            onClose();
          }}
          className="group flex w-full items-center justify-center gap-2 rounded-xl bg-ember-400 px-3 py-2.5 text-[13.5px] font-semibold text-ink-950 shadow-[0_8px_24px_-10px_rgba(226,177,97,0.65),inset_0_1px_0_rgba(255,255,255,0.25)] transition-all hover:bg-ember-300 hover:shadow-[0_10px_28px_-10px_rgba(226,177,97,0.8)] active:scale-[0.985]"
        >
          <Icon name="plus" size={15} strokeWidth={2.4} className="transition-transform group-hover:rotate-90" />
          New chat
        </button>
        <button
          type="button"
          onClick={onSearch}
          className="flex w-full items-center gap-2.5 rounded-xl border border-line bg-ink-850 px-3 py-2.5 text-[13px] text-fog-400 transition-colors hover:border-line-strong hover:text-fog-200"
        >
          <Icon name="search" size={14.5} />
          Search conversations
          <kbd className="ml-auto hidden rounded border border-line-strong bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] text-fog-500 sm:block">
            ⌘K
          </kbd>
        </button>
      </div>

      {/* scrollable middle */}
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {/* conversations */}
        <div className="px-4 pb-1.5 pt-2 text-[11px] font-semibold uppercase tracking-wider text-fog-600">
          Conversations
          {projectFilter ? (
            <span className="ml-1.5 normal-case tracking-normal text-fog-500">
              · in {projects.find((p) => p.id === projectFilter)?.name}
            </span>
          ) : null}
        </div>
        {!booted ? (
          <div className="space-y-2 px-4 pt-1">
            {[80, 62, 72, 50].map((w, i) => (
              <div key={i} className="skeleton h-8" style={{ width: `${w}%` }} />
            ))}
          </div>
        ) : visibleConversations.length === 0 ? (
          <p className="px-4 py-2 text-[12.5px] leading-relaxed text-fog-600">
            Nothing here yet. Start a chat and it will be saved to this device.
          </p>
        ) : (
          groups.map(([bucket, list]) => (
            <div key={bucket} className="mb-1.5">
              <div className="px-4 pb-1 pt-2 text-[10.5px] font-medium text-fog-600">{bucket}</div>
              {list.map((conversation) => (
                <ConversationRow
                  key={conversation.id}
                  conversation={conversation}
                  active={conversation.id === activeId && view === "chat"}
                  editing={editingId === conversation.id}
                  editValue={editValue}
                  onEditChange={setEditValue}
                  onOpen={() => {
                    aether.openConversation(conversation.id);
                    onClose();
                  }}
                  onStartEdit={() => {
                    setEditingId(conversation.id);
                    setEditValue(conversation.title);
                  }}
                  onCommitEdit={commitRename}
                  onCancelEdit={() => setEditingId(null)}
                  onDelete={() => void aether.deleteConversation(conversation.id)}
                />
              ))}
            </div>
          ))
        )}

        {/* projects */}
        <div className="mt-3 flex items-center justify-between px-4 pb-1.5 pt-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-fog-600">Projects</span>
          <button
            type="button"
            onClick={startProject}
            className="rounded-md p-1 text-fog-500 transition-colors hover:bg-ink-800 hover:text-fog-200"
            aria-label="New project"
          >
            <Icon name="plus" size={13} strokeWidth={2.2} />
          </button>
        </div>
        <ProjectRow
          label="All conversations"
          count={aether.conversations.length}
          active={projectFilter === null}
          onClick={() => aether.selectProject(null)}
        />
        {projects.map((project) =>
          editingProjectId === project.id ? (
            <div key={project.id} className="px-3 py-1.5">
              <div className="mb-1 text-[10.5px] font-medium text-fog-600">
                Instructions for “{project.name}” — injected into the agent context
              </div>
              <textarea
                autoFocus
                value={instructionsDraft}
                onChange={(e) => setInstructionsDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    void aether.updateInstructions(project.id, instructionsDraft);
                    setEditingProjectId(null);
                  }
                  if (e.key === "Escape") setEditingProjectId(null);
                }}
                onBlur={() => {
                  void aether.updateInstructions(project.id, instructionsDraft);
                  setEditingProjectId(null);
                }}
                rows={3}
                placeholder="e.g. Always answer in bullet points; this project targets the mobile app…"
                className="w-full resize-none rounded-lg border border-line-strong bg-ink-800 px-2.5 py-2 text-[12.5px] leading-relaxed text-fog-100 placeholder:text-fog-600 focus:outline-none"
              />
            </div>
          ) : (
            <ProjectRow
              key={project.id}
              label={project.name}
              count={aether.conversations.filter((c) => c.projectId === project.id).length}
              active={projectFilter === project.id}
              hasInstructions={Boolean(project.instructions)}
              onClick={() => aether.selectProject(project.id)}
              onDelete={() => void aether.removeProject(project.id)}
              onEdit={() => {
                setEditingProjectId(project.id);
                setInstructionsDraft(project.instructions ?? "");
              }}
            />
          ),
        )}
        {creatingProject ? (
          <div className="px-3 py-1">
            <input
              ref={newProjectInputRef}
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitProject();
                if (e.key === "Escape") setCreatingProject(false);
              }}
              onBlur={() => void commitProject()}
              placeholder="Project name…"
              className="w-full rounded-lg border border-line-strong bg-ink-800 px-2.5 py-1.5 text-[13px] text-fog-100 placeholder:text-fog-600 focus:outline-none"
            />
          </div>
        ) : projects.length === 0 ? (
          <p className="px-4 py-1 text-[12px] leading-relaxed text-fog-600">
            Group related chats — create your first project.
          </p>
        ) : null}
      </div>

      {/* footer */}
      <div className="border-t border-line px-3 py-3">
        <NavItem
          icon="grid"
          label="Workspace"
          active={view === "workspace"}
          onClick={() => {
            aether.setView("workspace");
            onClose();
          }}
        />
        <NavItem icon="settings" label="Settings" onClick={onSettings} />
        <button
          type="button"
          onClick={onSettings}
          className="mt-1.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-ink-800"
        >
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              !online ? "bg-warn-400" : "bg-ok-400",
              !online && "anim-pulse",
            )}
          />
          <span className="truncate text-[11.5px] text-fog-500">{statusLabel}</span>
        </button>
      </div>
    </div>
  );
}

function NavItem({
  icon,
  label,
  active,
  onClick,
}: {
  icon: "grid" | "settings";
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] transition-colors",
        active ? "bg-ink-800 text-fog-100" : "text-fog-300 hover:bg-ink-800 hover:text-fog-100",
      )}
    >
      <Icon name={icon} size={15.5} className={active ? "text-ember-400" : "text-fog-500"} />
      {label}
    </button>
  );
}

function ConversationRow({
  conversation,
  active,
  editing,
  editValue,
  onEditChange,
  onOpen,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  onDelete,
}: {
  conversation: Conversation;
  active: boolean;
  editing: boolean;
  editValue: string;
  onEditChange: (value: string) => void;
  onOpen: () => void;
  onStartEdit: () => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onDelete: () => void;
}) {
  if (editing) {
    return (
      <div className="px-3 py-0.5">
        <input
          autoFocus
          value={editValue}
          onChange={(e) => onEditChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCommitEdit();
            if (e.key === "Escape") onCancelEdit();
          }}
          onBlur={onCommitEdit}
          className="w-full rounded-lg border border-line-strong bg-ink-800 px-2.5 py-1.5 text-[13px] text-fog-100 focus:outline-none"
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group relative mx-2 flex items-center rounded-lg transition-colors",
        active ? "bg-ink-800" : "hover:bg-ink-850",
      )}
    >
      <span
        className={cn(
          "absolute inset-y-1.5 left-0 w-px rounded-full transition-colors",
          active ? "bg-ember-400/80" : "bg-transparent group-hover:bg-ember-400/40",
        )}
      />
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 px-2.5 py-2 text-left">
        <span className={cn("block truncate text-[13px]", active ? "text-fog-100" : "text-fog-300")}>
          {conversation.title}
        </span>
        <span className="mt-0.5 block text-[10.5px] text-fog-600">{timeAgo(conversation.updatedAt)}</span>
      </button>
      <div className="hidden shrink-0 items-center gap-0.5 pr-2 group-hover:flex">
        <button
          type="button"
          onClick={onStartEdit}
          className="rounded-md p-1.5 text-fog-500 transition-colors hover:bg-ink-700 hover:text-fog-200"
          aria-label="Rename conversation"
        >
          <Icon name="pencil" size={12.5} />
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="rounded-md p-1.5 text-fog-500 transition-colors hover:bg-danger-400/15 hover:text-danger-400"
          aria-label="Delete conversation"
        >
          <Icon name="trash" size={12.5} />
        </button>
      </div>
    </div>
  );
}

function ProjectRow({
  label,
  count,
  active,
  hasInstructions,
  onClick,
  onDelete,
  onEdit,
}: {
  label: string;
  count: number;
  active: boolean;
  hasInstructions?: boolean;
  onClick: () => void;
  onDelete?: () => void;
  onEdit?: () => void;
}) {
  return (
    <div
      className={cn(
        "group relative mx-2 flex items-center rounded-lg transition-colors",
        active ? "bg-ink-800" : "hover:bg-ink-850",
      )}
    >
      <button type="button" onClick={onClick} className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left">
        <Icon
          name="folder"
          size={14}
          className={cn("shrink-0", active ? "text-ember-400" : "text-fog-500")}
        />
        <span className={cn("truncate text-[13px]", active ? "text-fog-100" : "text-fog-300")}>{label}</span>
        {hasInstructions ? <span className="size-1 shrink-0 rounded-full bg-ember-400/70" title="Has instructions" /> : null}
        <span className="ml-auto text-[11px] tabular-nums text-fog-600">{count}</span>
      </button>
      {onEdit ? (
        <button
          type="button"
          onClick={onEdit}
          className="hidden rounded-md p-1 text-fog-500 transition-colors hover:bg-ink-700 hover:text-fog-200 group-hover:block"
          aria-label={`Edit instructions for ${label}`}
          title="Edit project instructions"
        >
          <Icon name="pencil" size={11.5} />
        </button>
      ) : null}
      {onDelete ? (
        <button
          type="button"
          onClick={onDelete}
          className="mr-2 hidden rounded-md p-1 text-fog-500 transition-colors hover:bg-danger-400/15 hover:text-danger-400 group-hover:block"
          aria-label={`Delete ${label}`}
        >
          <Icon name="x" size={12} />
        </button>
      ) : null}
    </div>
  );
}
