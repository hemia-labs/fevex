'use client';

import {
  ArrowUp,
  Bug,
  ChevronRight,
  Check,
  Circle,
  Sparkles,
  Square,
  Trash2,
  User,
} from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AgentEvent, RunRecord } from '@fevex/core';
import { createFevexHttpClient } from '@fevex/core/http';

type Message = {
  role: 'assistant' | 'user';
  content: string;
  tools?: ToolActivity[];
  startedAt?: number;
  completedAt?: number;
  runId?: string;
  sessionId?: string;
  usage?: Record<string, number>;
  events?: AgentEvent[];
  status?: 'running' | 'completed' | 'failed' | 'cancelled';
};

type ToolActivity = {
  id: string;
  name: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  startedAt: number;
  completedAt?: number;
};

type RunnableSummary = {
  kind: 'agent' | 'workflow';
  name: string;
  label: string;
  description: string;
};

const initialMessages: Message[] = [
  {
    role: 'assistant',
    content: 'Loading agents and workflows from the Nest API.',
  },
];

const apiUrl = (process.env.NEXT_PUBLIC_NEST_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const client = createFevexHttpClient({ baseUrl: apiUrl });

export default function Home() {
  const [runnables, setRunnables] = useState<RunnableSummary[]>([]);
  const [messages, setMessages] = useState(initialMessages);
  const [input, setInput] = useState('');
  const [selectedRunnableId, setSelectedRunnableId] = useState('');
  const [isLoadingRunnables, setIsLoadingRunnables] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  const [debug, setDebug] = useState(false);
  const [sessionId, setSessionId] = useState<string>();
  const [activeRunId, setActiveRunId] = useState<string>();
  const [now, setNow] = useState(Date.now());
  const runControllerRef = useRef<AbortController>(null);
  const conversationRef = useRef<HTMLElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const selectedRunnable = runnables.find((item) => runnableId(item) === selectedRunnableId);
  const AgentIcon = selectedRunnable?.kind === 'workflow' ? Sparkles : Circle;
  const status = isLoadingRunnables ? 'Connecting' : runnables.length ? 'Connected' : 'Disconnected';

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const frame = requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ block: 'end' });
    });
    return () => cancelAnimationFrame(frame);
  }, [messages]);

  useEffect(() => {
    if (!isRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isRunning]);

  useEffect(() => {
    const controller = new AbortController();

    async function loadRunnables() {
      try {
        const [agentsResponse, workflowsResponse] = await Promise.all([
          fetch(`${apiUrl}/agents`, { signal: controller.signal }),
          fetch(`${apiUrl}/workflows`, { signal: controller.signal }),
        ]);
        if (!agentsResponse.ok) throw new Error(`GET /agents returned ${agentsResponse.status}`);
        if (!workflowsResponse.ok) {
          throw new Error(`GET /workflows returned ${workflowsResponse.status}`);
        }

        const nextAgents = await agentsResponse.json() as Omit<RunnableSummary, 'kind'>[];
        const nextWorkflows = await workflowsResponse.json() as Omit<RunnableSummary, 'kind'>[];
        if (!Array.isArray(nextAgents)) throw new Error('GET /agents returned invalid JSON');
        if (!Array.isArray(nextWorkflows)) throw new Error('GET /workflows returned invalid JSON');

        const nextRunnables: RunnableSummary[] = [
          ...nextAgents.map((agent) => ({ ...agent, kind: 'agent' as const })),
          ...nextWorkflows.map((workflow) => ({ ...workflow, kind: 'workflow' as const })),
        ];
        setRunnables(nextRunnables);
        setSelectedRunnableId(nextRunnables[0] ? runnableId(nextRunnables[0]) : '');
        setMessages([{
          role: 'assistant',
          content: nextRunnables.length ? 'Ready.' : 'No agents or workflows are available.',
        }]);
      } catch (error) {
        if (controller.signal.aborted) return;

        setRunnables([]);
        setSelectedRunnableId('');
        setMessages([{
          role: 'assistant',
          content: toErrorMessage(error),
        }]);
      } finally {
        if (!controller.signal.aborted) setIsLoadingRunnables(false);
      }
    }

    void loadRunnables();
    return () => controller.abort();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const content = input.trim();
    if (!content || !selectedRunnable || isRunning) return;

    setMessages((current) => [
      ...current,
      { role: 'user', content },
      {
        role: 'assistant',
        content: '',
        tools: [],
        events: [],
        startedAt: Date.now(),
        status: 'running',
      },
    ]);
    setInput('');
    setIsRunning(true);
    const controller = new AbortController();
    runControllerRef.current = controller;
    let terminal = false;

    try {
      const request = {
        input: content,
        ...(sessionId ? { sessionId } : {}),
      };
      const run =
        selectedRunnable.kind === 'workflow'
          ? await client.startWorkflow(selectedRunnable.name, request)
          : await client.startRun(selectedRunnable.name, request);
      setSessionId(run.sessionId);
      setActiveRunId(run.id);
      setAssistantRun(run);

      for await (const agentEvent of client.observeRun(run.id, { signal: controller.signal })) {
        recordAssistantEvent(agentEvent);

        if (agentEvent.type === 'model.output.delta') {
          appendAssistantDelta(readPayloadText(agentEvent.payload, 'delta'));
        }
        if (agentEvent.type === 'tool.started') {
          setAssistantTool(
            readPayloadText(agentEvent.payload, 'toolCallId'),
            readPayloadText(agentEvent.payload, 'toolName'),
            'running',
            eventTime(agentEvent),
          );
        }
        if (agentEvent.type === 'tool.completed') {
          setAssistantTool(
            readPayloadText(agentEvent.payload, 'toolCallId'),
            readPayloadText(agentEvent.payload, 'toolName'),
            'done',
            eventTime(agentEvent),
          );
        }
        if (agentEvent.type === 'tool.failed') {
          setAssistantTool(
            readPayloadText(agentEvent.payload, 'toolCallId'),
            readPayloadText(agentEvent.payload, 'toolName'),
            'failed',
            eventTime(agentEvent),
          );
        }
        if (agentEvent.type === 'workflow.step.started') {
          setAssistantTool(
            readPayloadText(agentEvent.payload, 'stepId'),
            workflowStepName(agentEvent.payload),
            'running',
            eventTime(agentEvent),
          );
        }
        if (agentEvent.type === 'workflow.step.completed') {
          setAssistantTool(
            readPayloadText(agentEvent.payload, 'stepId'),
            workflowStepName(agentEvent.payload),
            'done',
            eventTime(agentEvent),
          );
        }
        if (agentEvent.type === 'workflow.step.failed') {
          setAssistantTool(
            readPayloadText(agentEvent.payload, 'stepId'),
            workflowStepName(agentEvent.payload),
            'failed',
            eventTime(agentEvent),
          );
        }
        if (agentEvent.type === 'run.failed' || agentEvent.type === 'workflow.run.failed') {
          terminal = true;
          appendAssistantError(readPayloadText(agentEvent.payload, 'error'));
          completeAssistant('failed', eventTime(agentEvent));
        }
        if (agentEvent.type === 'run.cancelled' || agentEvent.type === 'workflow.run.cancelled') {
          terminal = true;
          completeAssistant('cancelled', eventTime(agentEvent));
        }
        if (agentEvent.type === 'run.completed' || agentEvent.type === 'workflow.run.completed') {
          terminal = true;
          setAssistantAnswer(readCompletedAnswer(agentEvent.payload));
          completeAssistant(
            'completed',
            eventTime(agentEvent),
            readUsage(agentEvent.payload),
          );
        }
      }
      if (!terminal) throw new Error('Run stream ended before a terminal event.');
    } catch (error) {
      if (!terminal) {
        appendAssistantError(toErrorMessage(error));
        completeAssistant('failed');
      }
    } finally {
      if (runControllerRef.current === controller) runControllerRef.current = null;
      setActiveRunId(undefined);
      setIsRunning(false);
    }
  }

  async function cancelActiveRun() {
    if (!activeRunId) return;
    try {
      await client.cancelRun(activeRunId);
    } catch (error) {
      appendAssistantError(toErrorMessage(error));
    }
  }

  function appendAssistantDelta(delta: string) {
    setMessages((current) => {
      const next = [...current];
      const last = next[next.length - 1];
      if (last?.role === 'assistant') {
        next[next.length - 1] = { ...last, content: last.content + delta };
      } else {
        next.push({ role: 'assistant', content: delta });
      }
      return next;
    });
  }

  function appendAssistantError(error: string) {
    if (!error) return;
    setMessages((current) => {
      const next = [...current];
      const last = next[next.length - 1];
      if (last?.role !== 'assistant') return current;
      const separator = last.content.trim() ? '\n\n' : '';
      next[next.length - 1] = { ...last, content: `${last.content}${separator}${error}` };
      return next;
    });
  }

  function setAssistantRun(run: RunRecord) {
    setMessages((current) => {
      const next = [...current];
      const last = next[next.length - 1];
      if (last?.role !== 'assistant') return current;
      next[next.length - 1] = {
        ...last,
        runId: run.id,
        sessionId: run.sessionId,
      };
      return next;
    });
  }

  function recordAssistantEvent(event: AgentEvent) {
    setMessages((current) => {
      const next = [...current];
      const last = next[next.length - 1];
      if (last?.role !== 'assistant') return current;
      next[next.length - 1] = {
        ...last,
        runId: event.runId,
        events: [...(last.events ?? []), event],
        ...(event.type === 'run.started' || event.type === 'workflow.run.started'
          ? { startedAt: eventTime(event) }
          : {}),
      };
      return next;
    });
  }

  function setAssistantAnswer(content: string) {
    if (!content) return;
    setMessages((current) => {
      const next = [...current];
      const last = next[next.length - 1];
      if (last?.role !== 'assistant') return current;
      if (last.content.trim() && readJsonAnswer(last.content) !== content) return current;
      next[next.length - 1] = { ...last, content };
      return next;
    });
  }

  function setAssistantTool(
    id: string,
    name: string,
    status: ToolActivity['status'],
    time: number,
  ) {
    if (!id || !name) return;
    setMessages((current) => {
      const next = [...current];
      const last = next[next.length - 1];
      if (last?.role !== 'assistant') return current;
      const tools = [...(last.tools ?? [])];
      const index = tools.findIndex((tool) => tool.id === id);
      const previous = tools[index];
      const tool = {
        id,
        name,
        status,
        startedAt: previous?.startedAt ?? time,
        ...(status === 'running' ? {} : { completedAt: time }),
      };
      if (index === -1) tools.push(tool);
      else tools[index] = tool;
      next[next.length - 1] = { ...last, tools };
      return next;
    });
  }

  function completeAssistant(
    status: NonNullable<Message['status']>,
    time = Date.now(),
    usage?: Record<string, number>,
  ) {
    setMessages((current) => {
      const next = [...current];
      const last = next[next.length - 1];
      if (last?.role !== 'assistant' || last.completedAt) return current;
      const completedAt = time;
      const unfinishedToolStatus =
        status === 'completed' ? 'done' : status === 'cancelled' ? 'cancelled' : 'failed';
      next[next.length - 1] = {
        ...last,
        status,
        completedAt,
        ...(usage ? { usage } : {}),
        tools: last.tools?.map((tool) =>
          tool.status === 'running'
            ? { ...tool, status: unfinishedToolStatus, completedAt }
            : tool,
        ),
      };
      return next;
    });
  }

  function updateStickToBottom() {
    const conversation = conversationRef.current;
    if (!conversation) return;
    const distance = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight;
    stickToBottomRef.current = distance < 64;
  }

  function resetConversation() {
    setMessages([{ role: 'assistant', content: 'Ready.' }]);
    setSessionId(undefined);
    setInput('');
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon">
            <Sparkles size={15} />
          </span>
          <div>
            <strong>Fevex Playground</strong>
            <span>Local environment</span>
          </div>
        </div>
        <div className="toolbar">
          <button
            aria-label={`${debug ? 'Disable' : 'Enable'} debug mode`}
            aria-pressed={debug}
            className={`icon-button ${debug ? 'active' : ''}`}
            onClick={() => setDebug((value) => !value)}
            title={`${debug ? 'Disable' : 'Enable'} debug mode`}
            type="button"
          >
            <Bug size={16} />
          </button>
          <button
            aria-label="Clear conversation"
            className="icon-button"
            disabled={isRunning || (messages.length === 1 && !sessionId)}
            onClick={resetConversation}
            title="Clear conversation"
            type="button"
          >
            <Trash2 size={16} />
          </button>
          <div className={`status ${status.toLowerCase()}`}>
            <Circle fill="currentColor" size={8} strokeWidth={0} />
            {status}
          </div>
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <p className="sidebar-title">Agents & workflows</p>
          <nav className="agent-list" aria-label="Agents and workflows">
            {!runnables.length && (
              <p className="empty-state">{isLoadingRunnables ? 'Loading...' : 'No demos'}</p>
            )}
            {runnables.map((item) => {
              const Icon = item.kind === 'workflow' ? Sparkles : Circle;
              const id = runnableId(item);

              return (
                <button
                  aria-pressed={id === selectedRunnableId}
                  className={`agent-option ${id === selectedRunnableId ? 'active' : ''}`}
                  disabled={isRunning}
                  key={id}
                  onClick={() => {
                    setSelectedRunnableId(id);
                    resetConversation();
                  }}
                  type="button"
                >
                  <span className="sidebar-icon">
                    <Icon size={16} />
                  </span>
                  <span>
                    <strong>{item.label}</strong>
                    <small>{item.kind === 'workflow' ? 'Workflow' : 'Agent'} · {item.description}</small>
                  </span>
                  <Check className="agent-check" size={14} />
                </button>
              );
            })}
          </nav>
        </aside>

        <main className="playground">
          <section
            className="conversation"
            aria-label="Run conversation"
            aria-live="polite"
            onScroll={updateStickToBottom}
            ref={conversationRef}
          >
            <div className="agent">
              <span className="avatar">
                <AgentIcon size={17} />
              </span>
              <div>
                <strong>{selectedRunnable?.label ?? 'No demo selected'}</strong>
                <span>{selectedRunnable?.description ?? 'Start the Nest API to load demos.'}</span>
              </div>
            </div>

            <div className="messages">
              {messages.map((message, index) => (
                <article className={`message ${message.role}`} key={index}>
                  <span className="avatar">
                    {message.role === 'user' ? <User size={16} /> : <AgentIcon size={16} />}
                  </span>
                  <div>
                    <strong>{message.role === 'user' ? 'You' : selectedRunnable?.label ?? 'Agent'}</strong>
                    {message.role === 'assistant' && (
                      <RunActivityPanel debug={debug} message={message} now={now} />
                    )}
                    <MessageContent content={message.content} />
                  </div>
                </article>
              ))}
              <div ref={messagesEndRef} />
            </div>
          </section>

          <form className="composer" onSubmit={submit}>
            <label htmlFor="prompt">Prompt</label>
            <textarea
              id="prompt"
              maxLength={4000}
              disabled={isRunning}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="Ask the selected demo anything..."
              rows={2}
              value={input}
            />
            <div className="composer-footer">
              <span>
                <AgentIcon size={14} />
                {selectedRunnable?.name ?? 'none'}
              </span>
              <button
                aria-label={isRunning ? 'Cancel run' : 'Run selected demo'}
                className={isRunning ? 'cancel' : ''}
                disabled={isRunning ? !activeRunId : !input.trim() || !selectedRunnable}
                onClick={isRunning ? () => void cancelActiveRun() : undefined}
                title={isRunning ? 'Cancel run' : 'Run selected demo'}
                type={isRunning ? 'button' : 'submit'}
              >
                {isRunning ? <Square fill="currentColor" size={14} /> : <ArrowUp size={17} />}
              </button>
            </div>
          </form>
        </main>
      </div>
    </div>
  );
}

function RunActivityPanel({
  debug,
  message,
  now,
}: {
  debug: boolean;
  message: Message;
  now: number;
}) {
  if (!message.startedAt) return null;
  const running = !message.completedAt;
  const elapsedMs = (message.completedAt ?? now) - message.startedAt;
  const stage = running
    ? currentStage(message)
    : message.status === 'cancelled'
      ? 'Cancelado'
      : message.status === 'failed'
        ? 'Falló'
        : 'Procesado';

  return (
    <details className={`run-activity ${running ? 'running' : message.status ?? 'completed'}`}>
      <summary>
        <span className={`activity-dot ${activityKind(stage)}`} />
        <span>{stage} durante {formatDuration(elapsedMs)}</span>
        <ChevronRight size={13} />
      </summary>
      <div className="tool-activity-list">
        {message.tools?.length ? (
          <>
            <p>Se usaron las tools</p>
            <ul>
              {message.tools.map((tool) => (
                <li className={`tool-activity ${tool.status}`} key={tool.id}>
                  <code>{tool.name}</code>
                  <small>{toolStatusText(tool)} · {formatToolDuration((tool.completedAt ?? now) - tool.startedAt)}</small>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <span className={`tool-activity ${running ? 'running' : message.status ?? 'done'}`}>
            {running ? 'Respondiendo' : 'Sin tools'}
          </span>
        )}
        {debug && <DebugPanel message={message} elapsedMs={elapsedMs} />}
      </div>
    </details>
  );
}

function DebugPanel({ message, elapsedMs }: { message: Message; elapsedMs: number }) {
  return (
    <div className="debug-panel">
      <dl>
        <div><dt>runId</dt><dd>{message.runId ?? 'pending'}</dd></div>
        <div><dt>sessionId</dt><dd>{message.sessionId ?? 'pending'}</dd></div>
        <div><dt>duration</dt><dd>{formatToolDuration(elapsedMs)}</dd></div>
        <div><dt>usage</dt><dd>{formatUsage(message.usage)}</dd></div>
      </dl>
      <details>
        <summary>Raw events ({message.events?.length ?? 0})</summary>
        <pre>{JSON.stringify(message.events ?? [], null, 2)}</pre>
      </details>
    </div>
  );
}

function MessageContent({ content }: { content: string }) {
  return (
    <div className="message-content">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {formatMarkdown(content)}
      </ReactMarkdown>
    </div>
  );
}

function runnableId(item: RunnableSummary) {
  return `${item.kind}:${item.name}`;
}

function workflowStepName(payload: unknown) {
  const stepId = readPayloadText(payload, 'stepId');
  const agentName = readPayloadText(payload, 'agentName');
  return agentName ? `${stepId}:${agentName}` : stepId;
}

function readPayloadText(payload: unknown, key: string) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function eventTime(event: AgentEvent) {
  const time = event.timestamp ? Date.parse(event.timestamp) : NaN;
  return Number.isFinite(time) ? time : Date.now();
}

function currentStage(message: Message) {
  const runningTool = message.tools?.find((tool) => tool.status === 'running');
  if (runningTool?.name.includes('tickets')) return 'Buscando';
  if (runningTool?.name.includes('metrics') || runningTool?.name.includes('incidents')) return 'Investigando';
  if (runningTool) return 'Ejecutando';
  return message.content ? 'Respondiendo' : 'Pensando';
}

function activityKind(stage: string) {
  if (stage === 'Buscando') return 'searching';
  if (stage === 'Investigando') return 'investigating';
  if (stage === 'Respondiendo') return 'responding';
  return 'running';
}

function toolStatusText(tool: ToolActivity) {
  if (tool.status === 'failed') return 'Falló';
  if (tool.status === 'cancelled') return 'Cancelada';
  if (tool.status === 'running') return tool.name === 'tickets_recent' ? 'Buscando' : 'Usando';
  return 'Usó';
}

function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function formatToolDuration(ms: number) {
  const safeMs = Math.max(0, Math.round(ms));
  if (safeMs < 1000) return `${safeMs}ms`;
  return `${(safeMs / 1000).toFixed(1)}s`;
}

function readCompletedAnswer(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const output = (payload as Record<string, unknown>).output;
  if (typeof output === 'string') return output;
  if (!output || typeof output !== 'object' || Array.isArray(output)) return '';
  const answer = (output as Record<string, unknown>).answer;
  return typeof answer === 'string' ? answer : '';
}

function readUsage(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const usage = (payload as Record<string, unknown>).usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
  const entries = Object.entries(usage).filter(
    (entry): entry is [string, number] => typeof entry[1] === 'number',
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function formatUsage(usage: Record<string, number> | undefined) {
  if (!usage) return 'unavailable';
  return Object.entries(usage)
    .map(([key, value]) => `${key}: ${value}`)
    .join(', ');
}

function readJsonAnswer(content: string) {
  try {
    const value = JSON.parse(content) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
    const answer = (value as Record<string, unknown>).answer;
    return typeof answer === 'string' ? answer : '';
  } catch {
    return '';
  }
}

function formatMarkdown(content: string) {
  return content
    .replace(/([^\n])(\#{1,6}\s+)/g, '$1\n\n$2')
    .replace(/\s+([-*]\s+)/g, '\n$1')
    .replace(/(\|[^\n]*\|)\n\s*\n(?=\|)/g, '$1\n');
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Agent API request failed.';
}
