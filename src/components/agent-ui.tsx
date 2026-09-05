"use client";

import type { RuntimeSnapshot, RuntimeTask, StepState, TaskStatus } from "@/lib/types";
import { cn, timeAgo, truncate } from "@/lib/utils";
import { Icon, type IconName } from "./icons";

/* ---------------- status chip ---------------- */

const STATUS_META: Record<TaskStatus, { label: string; cls: string }> = {
  pending: { label: "Pending", cls: "border-line bg-ink-750 text-fog-400" },
  planning: { label: "Planning", cls: "border-ember-400/30 bg-ember-400/10 text-ember-300" },
  running: { label: "Executing", cls: "border-ember-400/30 bg-ember-400/10 text-ember-300" },
  waiting_approval: { label: "Waiting for approval", cls: "border-warn-400/35 bg-warn-400/10 text-warn-400" },
  paused: { label: "Paused", cls: "border-line-strong bg-ink-750 text-fog-300" },
  validating: { label: "Validating", cls: "border-ember-400/30 bg-ember-400/10 text-ember-300" },
  completed: { label: "Completed", cls: "border-ok-400/30 bg-ok-400/10 text-ok-400" },
  failed: { label: "Failed", cls: "border-danger-400/30 bg-danger-400/10 text-danger-400" },
  cancelled: { label: "Cancelled", cls: "border-line bg-ink-750 text-fog-400" },
  interrupted: { label: "Interrupted", cls: "border-warn-400/35 bg-warn-400/10 text-warn-400" },
};

export function StatusChip({ status, className }: { status: TaskStatus; className?: string }) {
  const meta = STATUS_META[status];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-medium",
        meta.cls,
        className,
      )}
    >
      {(status === "running" || status === "planning" || status === "validating") && (
        <span className="anim-pulse size-1.5 rounded-full bg-current" />
      )}
      {meta.label}
    </span>
  );
}

/* ---------------- step rows ---------------- */

const STEP_ICON: Record<StepState, { icon: IconName; cls: string; spin?: boolean }> = {
  pending: { icon: "clock", cls: "text-fog-600" },
  running: { icon: "refresh", cls: "text-ember-400", spin: true },
  done: { icon: "check", cls: "text-ok-400" },
  failed: { icon: "alert", cls: "text-danger-400" },
  skipped: { icon: "x", cls: "text-fog-500" },
  declined: { icon: "x", cls: "text-warn-400" },
};

function StepRow({
  index,
  title,
  state,
  attempts,
  tool,
  detail,
}: {
  index: number;
  title: string;
  state: StepState;
  attempts: number;
  tool?: string;
  detail?: string;
}) {
  const meta = STEP_ICON[state];
  return (
    <div className="flex items-start gap-2.5 py-1">
      <span className={cn("mt-0.5 shrink-0", meta.cls)}>
        <Icon name={meta.icon} size={13} className={meta.spin ? "animate-spin" : undefined} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={cn("truncate text-[12.5px]", state === "pending" ? "text-fog-500" : "text-fog-200")}>
            <span className="mr-1.5 font-mono text-[10.5px] text-fog-600">{index + 1}.</span>
            {title}
          </span>
          {attempts > 1 ? (
            <span className="shrink-0 rounded border border-line-strong px-1 font-mono text-[9.5px] text-fog-500">
              ×{attempts}
            </span>
          ) : null}
        </div>
        {tool ? <div className="mt-0.5 font-mono text-[10.5px] text-fog-600">{tool}</div> : null}
        {detail ? <div className="mt-0.5 truncate text-[11px] text-fog-500">{detail}</div> : null}
      </div>
    </div>
  );
}

/* ---------------- approval card ---------------- */

export function ApprovalCard({
  tool,
  description,
  onResolve,
  compact,
}: {
  tool: string;
  description: string;
  onResolve: (approved: boolean) => void;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-warn-400/35 bg-warn-400/[0.07] px-3.5 py-3",
        compact ? "" : "anim-rise",
      )}
    >
      <div className="flex items-center gap-2 text-warn-400">
        <Icon name="alert" size={13} />
        <span className="text-[12px] font-semibold uppercase tracking-wide">Approval needed</span>
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-fog-200">{description}</p>
      <p className="mt-0.5 font-mono text-[10.5px] text-fog-500">{tool}</p>
      <div className="mt-2.5 flex gap-2">
        <button
          type="button"
          onClick={() => onResolve(true)}
          className="flex items-center gap-1.5 rounded-lg bg-ember-400 px-3 py-1.5 text-[12px] font-semibold text-ink-950 transition-colors hover:bg-ember-300"
        >
          <Icon name="check" size={12} strokeWidth={2.4} />
          Approve
        </button>
        <button
          type="button"
          onClick={() => onResolve(false)}
          className="rounded-lg border border-line-strong px-3 py-1.5 text-[12px] font-medium text-fog-300 transition-colors hover:bg-ink-700"
        >
          Decline
        </button>
      </div>
    </div>
  );
}

/* ---------------- runtime view inside a message ---------------- */

export function RuntimeEventView({
  snapshot,
  active,
  task,
  onApprove,
}: {
  snapshot: RuntimeSnapshot;
  active: boolean;
  task?: RuntimeTask | null;
  onApprove: (requestId: string, approved: boolean) => void;
}) {
  const steps = snapshot.steps;
  const approval = active ? snapshot.approval : undefined;

  if (steps.length === 0 && !approval) return null;

  const stepDetail = (stepId: string): string | undefined => {
    const source = task?.steps.find((s) => s.id === stepId);
    if (!source) return undefined;
    if (source.state === "failed") return source.error;
    if (source.state === "done" && source.result) return truncate(source.result, 140);
    return undefined;
  };

  return (
    <div className="mb-3 space-y-2">
      {steps.length > 0 ? (
        <div className="rounded-xl border border-line bg-ink-850 px-3.5 py-2.5">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10.5px] font-semibold uppercase tracking-wider text-fog-600">Agent plan</span>
            <span className="font-mono text-[10px] text-fog-600">
              {steps.filter((s) => s.state === "done").length}/{steps.length} done
            </span>
          </div>
          {steps.map((step, index) => (
            <StepRow
              key={step.id}
              index={index}
              title={step.title}
              state={step.state}
              attempts={step.attempts}
              tool={step.tool}
              detail={stepDetail(step.id)}
            />
          ))}
        </div>
      ) : null}

      {approval ? (
        <ApprovalCard
          tool={approval.tool}
          description={approval.description}
          onResolve={(ok) => onApprove(approval.id, ok)}
        />
      ) : null}

      {snapshot.notes && snapshot.notes.length > 0 && active ? (
        <div className="space-y-0.5 px-1">
          {snapshot.notes.slice(-2).map((note, index) => (
            <p key={index} className="flex items-center gap-1.5 text-[11px] text-fog-600">
              <Icon name="sparkle" size={10} className="shrink-0 text-ember-400/70" />
              <span className="truncate">{note}</span>
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ---------------- task panel ---------------- */

export function TaskPanel({
  open,
  onClose,
  tasks,
  liveTask,
  selectedTaskId,
  onSelectTask,
  onPause,
  onResume,
  onCancel,
  onRerun,
  onApprove,
  onOpenConversation,
}: {
  open: boolean;
  onClose: () => void;
  tasks: RuntimeTask[];
  liveTask: RuntimeTask | null;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string | null) => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onRerun: (taskId: string) => void;
  onApprove: (requestId: string, approved: boolean) => void;
  onOpenConversation: (conversationId: string) => void;
}) {
  if (!open) return null;

  /* The running task always wins; otherwise show the selected historic task
     so interrupted/failed runs can be inspected and resumed. */
  const active = liveTask ?? tasks.find((t) => t.id === selectedTaskId) ?? null;
  const isLive = active !== null && liveTask?.id === active.id;
  const pendingApproval = isLive ? active?.approvals.find((a) => a.status === "pending") : undefined;
  const recent = tasks.filter((t) => t.id !== active?.id).slice(0, 8);
  const doneCount = active ? active.steps.filter((s) => s.state === "done").length : 0;
  const progress = active && active.steps.length > 0 ? (doneCount / active.steps.length) * 100 : 0;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Agent tasks">
      <button type="button" aria-label="Close tasks" onClick={onClose} className="absolute inset-0 bg-ink-950/60 backdrop-blur-[2px]" />
      <div className="anim-rise relative flex h-full w-full max-w-[400px] flex-col border-l border-line bg-ink-900 shadow-2xl shadow-black/60">
        <div className="flex h-[54px] shrink-0 items-center justify-between border-b border-line px-4">
          <h2 className="font-display text-[15px] font-semibold text-fog-100">Agent tasks</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-fog-500 transition-colors hover:bg-ink-800 hover:text-fog-200"
            aria-label="Close"
          >
            <Icon name="x" size={15} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {active ? (
            <div className="rounded-xl border border-line-strong bg-ink-850 p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 flex-1 text-[13.5px] font-medium leading-snug text-fog-100">{active.goal}</p>
                <StatusChip status={active.status} />
              </div>

              {active.steps.length > 0 ? (
                <div className="mt-3">
                  <div className="h-1 overflow-hidden rounded-full bg-ink-700">
                    <div className="h-full rounded-full bg-ember-400 transition-all duration-500" style={{ width: `${progress}%` }} />
                  </div>
                  <div className="mt-1.5 font-mono text-[10.5px] text-fog-600">
                    {doneCount}/{active.steps.length} steps · {timeAgo(active.updatedAt)}
                  </div>
                </div>
              ) : null}

              {/* controls */}
              <div className="mt-3 flex flex-wrap gap-2">
                {isLive && (active.status === "running" || active.status === "planning" || active.status === "validating") ? (
                  <PanelButton icon="pause" label="Pause" onClick={onPause} />
                ) : null}
                {isLive && active.status === "paused" ? (
                  <PanelButton icon="play" label="Resume" onClick={onResume} primary />
                ) : null}
                {active.status === "failed" || active.status === "cancelled" || active.status === "interrupted" ? (
                  <PanelButton
                    icon="refresh"
                    label={active.status === "failed" ? "Retry failed step" : active.status === "interrupted" ? "Resume task" : "Run again"}
                    onClick={() => onRerun(active.id)}
                    primary
                  />
                ) : null}
                {active.status === "completed" && !isLive ? (
                  <PanelButton icon="play" label="Run again" onClick={() => onRerun(active.id)} />
                ) : null}
                {isLive && active.status !== "completed" && active.status !== "failed" && active.status !== "cancelled" ? (
                  <PanelButton icon="x" label="Cancel" onClick={onCancel} danger />
                ) : null}
              </div>

              {pendingApproval ? (
                <div className="mt-3">
                  <ApprovalCard
                    compact
                    tool={pendingApproval.tool}
                    description={pendingApproval.description}
                    onResolve={(ok) => onApprove(pendingApproval.id, ok)}
                  />
                </div>
              ) : null}

              {/* steps */}
              {active.steps.length > 0 ? (
                <div className="mt-3 border-t border-line pt-2">
                  {active.steps.map((step, index) => (
                    <StepRow
                      key={step.id}
                      index={index}
                      title={step.title}
                      state={step.state}
                      attempts={step.attempts}
                      tool={step.tool}
                      detail={step.state === "failed" ? step.error : step.result ? truncate(step.result, 120) : undefined}
                    />
                  ))}
                </div>
              ) : null}

              {/* event log */}
              {active.events.length > 0 ? (
                <div className="mt-3 border-t border-line pt-2.5">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-fog-600">Execution log</div>
                  <div className="space-y-1">
                    {active.events.slice(-6).map((event, index) => (
                      <p key={index} className="flex gap-2 font-mono text-[10.5px] leading-relaxed text-fog-500">
                        <span className="shrink-0 text-fog-600">
                          {new Date(event.at).toLocaleTimeString(undefined, { hour12: false })}
                        </span>
                        <span className="min-w-0 flex-1">{event.text}</span>
                      </p>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-line-strong px-4 py-8 text-center">
              <Icon name="terminal" size={18} className="mx-auto text-fog-600" />
              <p className="mt-2 text-[13px] text-fog-400">No task is running.</p>
              <p className="mt-1 text-[12px] leading-relaxed text-fog-600">
                Start one with <span className="font-mono text-ember-300">/task</span> followed by a goal — the agent
                will plan, execute tools and validate the result.
              </p>
            </div>
          )}

          {/* history */}
          <h3 className="mt-5 mb-2 text-[11px] font-semibold uppercase tracking-wider text-fog-600">History</h3>
          {recent.length === 0 ? (
            <p className="text-[12.5px] text-fog-600">No previous tasks yet.</p>
          ) : (
            <div className="overflow-hidden rounded-xl border border-line bg-ink-850">
              {recent.map((task, index) => (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => {
                    onSelectTask(task.id);
                    onOpenConversation(task.conversationId);
                  }}
                  className={cn(
                    "flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-ink-800",
                    index > 0 && "border-t border-line",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-fog-300">{task.goal}</span>
                  <StatusChip status={task.status} />
                  <span className="w-14 shrink-0 text-right text-[10.5px] text-fog-600">{timeAgo(task.updatedAt)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PanelButton({
  icon,
  label,
  onClick,
  primary,
  danger,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  primary?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors",
        primary && "bg-ember-400 text-ink-950 hover:bg-ember-300",
        danger && "border border-danger-400/30 text-danger-400 hover:bg-danger-400/10",
        !primary && !danger && "border border-line-strong text-fog-300 hover:bg-ink-700",
      )}
    >
      <Icon name={icon} size={12} />
      {label}
    </button>
  );
}
