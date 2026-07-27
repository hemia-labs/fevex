'use client';

import {
  ArrowUp,
  ChevronRight,
  Check,
  Circle,
  Sparkles,
  Trash2,
  User,
} from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type Message = {
  role: 'assistant' | 'user';
  content: string;
  tools?: ToolActivity[];
  startedAt?: number;
  completedAt?: number;
};

type ToolActivity = {
  name: string;
  status: 'running' | 'done' | 'failed';
  startedAt: number;
  completedAt?: number;
};

type AgentSummary = {
  name: string;
  label: string;
  description: string;
};

type AgentEvent =
  { type: string; payload?: unknown; timestamp?: string };

type StreamMessage =
  | { type: 'event'; event: AgentEvent }
  | { type: 'error'; error: string };

const initialMessages: Message[] = [
  {
    role: 'assistant',
    content: 'Loading agents from the Nest API.',
  },
];

const apiUrl = (process.env.NEXT_PUBLIC_NEST_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const toolLabels: Record<string, string> = {
  accounts_get: 'datos de cuenta',
  tickets_recent: 'tickets recientes',
  metrics_get: 'métricas del servicio',
  incidents_open: 'incidentes abiertos',
  escalations_create: 'escalación operativa',
};

export default function Home() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [messages, setMessages] = useState(initialMessages);
  const [input, setInput] = useState('');
  const [selectedAgentName, setSelectedAgentName] = useState('');
  const [isLoadingAgents, setIsLoadingAgents] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  const [now, setNow] = useState(Date.now());
  const conversationRef = useRef<HTMLElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const selectedAgent = agents.find((agent) => agent.name === selectedAgentName);
  const AgentIcon = selectedAgent?.name === 'assistant' ? Sparkles : Circle;
  const status = isLoadingAgents ? 'Connecting' : agents.length ? 'Connected' : 'Disconnected';

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

    async function loadAgents() {
      try {
        const response = await fetch(`${apiUrl}/agents`, { signal: controller.signal });
        if (!response.ok) throw new Error(`GET /agents returned ${response.status}`);

        const nextAgents = await response.json() as AgentSummary[];
        if (!Array.isArray(nextAgents)) throw new Error('GET /agents returned invalid JSON');

        setAgents(nextAgents);
        setSelectedAgentName(nextAgents[0]?.name ?? '');
        setMessages([{
          role: 'assistant',
          content: nextAgents.length ? 'Ready.' : 'No agents are available.',
        }]);
      } catch (error) {
        if (controller.signal.aborted) return;

        setAgents([]);
        setSelectedAgentName('');
        setMessages([{
          role: 'assistant',
          content: toErrorMessage(error),
        }]);
      } finally {
        if (!controller.signal.aborted) setIsLoadingAgents(false);
      }
    }

    void loadAgents();
    return () => controller.abort();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const content = input.trim();
    if (!content || !selectedAgent || isRunning) return;

    setMessages((current) => [
      ...current,
      { role: 'user', content },
      { role: 'assistant', content: '', tools: [], startedAt: Date.now() },
    ]);
    setInput('');
    setIsRunning(true);

    try {
      const response = await fetch(`${apiUrl}/agents/${encodeURIComponent(selectedAgent.name)}/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: content }),
      });
      if (!response.ok) throw new Error(`POST /agents/${selectedAgent.name}/stream returned ${response.status}`);
      if (!response.body) throw new Error('Agent stream returned no body');

      for await (const message of readEventStream(response.body)) {
        if (message.type === 'error') {
          appendAssistantDelta(message.error);
          continue;
        }
        if (message.event.type === 'model.output.delta') {
          appendAssistantDelta(readPayloadText(message.event.payload, 'delta'));
        }
        if (message.event.type === 'tool.started') {
          setAssistantTool(readPayloadText(message.event.payload, 'toolName'), 'running', eventTime(message.event));
        }
        if (message.event.type === 'tool.completed') {
          setAssistantTool(readPayloadText(message.event.payload, 'toolName'), 'done', eventTime(message.event));
        }
        if (message.event.type === 'tool.failed') {
          setAssistantTool(readPayloadText(message.event.payload, 'toolName'), 'failed', eventTime(message.event));
        }
        if (message.event.type === 'run.failed') {
          completeAssistant(eventTime(message.event));
          appendAssistantDelta(readPayloadText(message.event.payload, 'error'));
        }
        if (message.event.type === 'run.completed') {
          setAssistantAnswer(readCompletedAnswer(message.event.payload));
          completeAssistant(eventTime(message.event));
        }
      }
    } catch (error) {
      appendAssistantDelta(toErrorMessage(error));
      completeAssistant();
    } finally {
      setIsRunning(false);
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

  function setAssistantTool(name: string, status: ToolActivity['status'], time: number) {
    if (!name) return;
    setMessages((current) => {
      const next = [...current];
      const last = next[next.length - 1];
      if (last?.role !== 'assistant') return current;
      const tools = [...(last.tools ?? [])];
      const index = tools.findIndex((tool) => tool.name === name);
      const previous = tools[index];
      const tool = {
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

  function completeAssistant(time = Date.now()) {
    setMessages((current) => {
      const next = [...current];
      const last = next[next.length - 1];
      if (last?.role !== 'assistant' || last.completedAt) return current;
      const completedAt = time;
      next[next.length - 1] = {
        ...last,
        completedAt,
        tools: last.tools?.map((tool) =>
          tool.status === 'running' ? { ...tool, status: 'done', completedAt } : tool,
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
            aria-label="Clear conversation"
            className="icon-button"
            disabled={messages.length === 1}
            onClick={() => setMessages(initialMessages)}
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
          <p className="sidebar-title">Agents</p>
          <nav className="agent-list" aria-label="Agents">
            {!agents.length && (
              <p className="empty-state">{isLoadingAgents ? 'Loading...' : 'No agents'}</p>
            )}
            {agents.map((agent) => {
              const Icon = agent.name === 'assistant' ? Sparkles : Circle;

              return (
                <button
                  aria-pressed={agent.name === selectedAgentName}
                  className={`agent-option ${agent.name === selectedAgentName ? 'active' : ''}`}
                  key={agent.name}
                  onClick={() => {
                    setSelectedAgentName(agent.name);
                    setMessages([{ role: 'assistant', content: 'Ready.' }]);
                    setInput('');
                  }}
                  type="button"
                >
                  <span className="sidebar-icon">
                    <Icon size={16} />
                  </span>
                  <span>
                    <strong>{agent.label}</strong>
                    <small>{agent.description}</small>
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
            aria-label="Agent conversation"
            aria-live="polite"
            onScroll={updateStickToBottom}
            ref={conversationRef}
          >
            <div className="agent">
              <span className="avatar">
                <AgentIcon size={17} />
              </span>
              <div>
                <strong>{selectedAgent?.label ?? 'No agent selected'}</strong>
                <span>{selectedAgent?.description ?? 'Start the Nest API to load agents.'}</span>
              </div>
            </div>

            <div className="messages">
              {messages.map((message, index) => (
                <article className={`message ${message.role}`} key={index}>
                  <span className="avatar">
                    {message.role === 'user' ? <User size={16} /> : <AgentIcon size={16} />}
                  </span>
                  <div>
                    <strong>{message.role === 'user' ? 'You' : selectedAgent?.label ?? 'Agent'}</strong>
                    {message.role === 'assistant' && <RunActivityPanel message={message} now={now} />}
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
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="Ask the agent anything..."
              rows={2}
              value={input}
            />
            <div className="composer-footer">
              <span>
                <AgentIcon size={14} />
                {selectedAgent?.name ?? 'none'}
              </span>
              <button
                aria-label="Run agent"
                disabled={!input.trim() || !selectedAgent || isRunning}
                title="Run agent"
                type="submit"
              >
                <ArrowUp size={17} />
              </button>
            </div>
          </form>
        </main>
      </div>
    </div>
  );
}

function RunActivityPanel({ message, now }: { message: Message; now: number }) {
  if (!message.startedAt) return null;
  const running = !message.completedAt;
  const elapsedMs = (message.completedAt ?? now) - message.startedAt;
  const stage = running ? currentStage(message) : 'Procesado';

  return (
    <details className={`run-activity ${running ? 'running' : 'done'}`}>
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
                <li className={`tool-activity ${tool.status}`} key={tool.name}>
                  <code>{tool.name}</code>
                  <small>{toolStatusText(tool)} · {formatToolDuration((tool.completedAt ?? now) - tool.startedAt)}</small>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <span className={`tool-activity ${running ? 'running' : 'done'}`}>
            {running ? 'Respondiendo' : 'Sin tools'}
          </span>
        )}
      </div>
    </details>
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

async function* readEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) yield readStreamMessage(data);
        boundary = buffer.indexOf('\n\n');
      }

      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

function readStreamMessage(data: string): StreamMessage {
  try {
    return { type: 'event', event: JSON.parse(data) as AgentEvent };
  } catch {
    return { type: 'error', error: data };
  }
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

function toolLabel(name: string) {
  return toolLabels[name] ?? (name || 'tool');
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
