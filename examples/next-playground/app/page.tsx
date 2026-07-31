'use client';

import {
  ArrowUp,
  Bug,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Check,
  Circle,
  CircleDashed,
  CircleSlash2,
  CircleX,
  Copy,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plug,
  Sparkles,
  Square,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import {
  type ComponentProps,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  isValidElement,
  useEffect,
  useRef,
  useState,
} from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { AgentEvent, JsonValue, ReasoningEffort, RunRecord } from '@fevex/core';
import type { ElicitationRequest } from '@fevex/core/runtime';
import { createFevexHttpClient, FevexHttpError } from '@fevex/core/http';
import { ApprovalDecisionCard } from '@/components/approval-decision-card';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker';
import { Spinner } from '@/components/ui/spinner';

type Message = {
  role: 'assistant' | 'user';
  content: JsonValue;
  tools?: ToolActivity[];
  drafts?: DraftActivity[];
  startedAt?: number;
  completedAt?: number;
  runId?: string;
  sessionId?: string;
  usage?: Record<string, number>;
  events?: AgentEvent[];
  elicitation?: ElicitationRequest;
  elicitationResolved?: boolean;
  approval?: ApprovalRequestSummary;
  approvalResolved?: boolean;
  workflowEvent?: WorkflowEventSummary;
  workflowEventResolved?: boolean;
  status?: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
};

type ApprovalRequestSummary = {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  toolLabel: string;
};

type WorkflowEventSummary = {
  stepId: string;
  eventName: string;
};

type ToolActivity = {
  id: string;
  name: string;
  source?: string;
  remoteName?: string;
  kind?: string;
  status: 'running' | 'paused' | 'done' | 'failed' | 'cancelled';
  startedAt: number;
  completedAt?: number;
};

type DraftActivity = {
  id: string;
  name: string;
  content: string;
};

type RunnableSummary = {
  kind: 'agent' | 'workflow';
  name: string;
  label: string;
  description: string;
  instructions?: string;
  examples?: string[];
};

type ModelSummary = {
  id: string;
  provider?: string;
  model?: string;
  efforts: ReasoningEffort[];
};

const initialMessages: Message[] = [
  {
    role: 'assistant',
    content: 'Connecting to the local Nest API...',
  },
];

const apiUrl = (process.env.NEXT_PUBLIC_NEST_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const client = createFevexHttpClient({ baseUrl: apiUrl });
const minRightPanelWidth = 260;
const collapseRightPanelWidth = 180;

export default function Home() {
  const [runnables, setRunnables] = useState<RunnableSummary[]>([]);
  const [messages, setMessages] = useState(initialMessages);
  const [input, setInput] = useState('');
  const [selectedRunnableId, setSelectedRunnableId] = useState('');
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [selectedEffort, setSelectedEffort] = useState<ReasoningEffort>('provider-default');
  const [isLoadingRunnables, setIsLoadingRunnables] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  const [debug, setDebug] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(true);
  const [rightPanelWidth, setRightPanelWidth] = useState(300);
  const [sessionId, setSessionId] = useState<string>();
  const [activeRunId, setActiveRunId] = useState<string>();
  const [now, setNow] = useState(Date.now());
  const runControllerRef = useRef<AbortController>(null);
  const scrollerRef = useRef<HTMLElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const rightPanelRef = useRef<HTMLElement>(null);
  const stickToBottomRef = useRef(true);
  const selectedRunnable = runnables.find((item) => runnableId(item) === selectedRunnableId);
  const selectedModel = models.find((item) => item.id === selectedModelId);
  const efforts = selectedModel?.efforts ?? ['provider-default'];
  const selectedModelLabel = selectedModel?.model ?? selectedModel?.id ?? 'Modelo';
  const selectedEffortLabel = effortLabel(selectedEffort);
  const pendingElicitationMessage = [...messages].reverse().find((message) =>
    message.role === 'assistant' &&
    message.status === 'paused' &&
    message.elicitation &&
    !message.elicitationResolved
  );
  const pendingApprovalMessage = [...messages].reverse().find((message) =>
    message.role === 'assistant' &&
    message.status === 'paused' &&
    message.approval &&
    !message.approvalResolved
  );
  const pendingWorkflowEventMessage = [...messages].reverse().find((message) =>
    message.role === 'assistant' &&
    message.status === 'paused' &&
    message.workflowEvent &&
    !message.workflowEventResolved
  );
  const AgentIcon = selectedRunnable?.kind === 'workflow' ? Sparkles : Circle;

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const frame = requestAnimationFrame(() => {
      // el composer es sticky dentro del scroller, así que llegar al fondo deja
      // el último mensaje justo encima de él
      const scroller = scrollerRef.current;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
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
        const [agentsResponse, workflowsResponse, modelsResponse] = await Promise.all([
          fetch(`${apiUrl}/agents`, { signal: controller.signal }),
          fetch(`${apiUrl}/workflows`, { signal: controller.signal }),
          fetch(`${apiUrl}/models`, { signal: controller.signal }),
        ]);
        if (!agentsResponse.ok) throw new Error(`GET /agents returned ${agentsResponse.status}`);
        if (!workflowsResponse.ok) {
          throw new Error(`GET /workflows returned ${workflowsResponse.status}`);
        }
        if (!modelsResponse.ok) throw new Error(`GET /models returned ${modelsResponse.status}`);

        const nextAgents = await agentsResponse.json() as Omit<RunnableSummary, 'kind'>[];
        const nextWorkflows = await workflowsResponse.json() as Omit<RunnableSummary, 'kind'>[];
        const nextModels = await modelsResponse.json() as ModelSummary[];
        if (!Array.isArray(nextAgents)) throw new Error('GET /agents returned invalid JSON');
        if (!Array.isArray(nextWorkflows)) throw new Error('GET /workflows returned invalid JSON');
        if (!Array.isArray(nextModels)) throw new Error('GET /models returned invalid JSON');

        const nextRunnables: RunnableSummary[] = [
          ...nextAgents.map((agent) => ({ ...agent, kind: 'agent' as const })),
          ...nextWorkflows.map((workflow) => ({ ...workflow, kind: 'workflow' as const })),
        ];
        setRunnables(nextRunnables);
        setModels(nextModels);
        setSelectedModelId(nextModels[0]?.id ?? '');
        setSelectedEffort(nextModels[0]?.efforts[0] ?? 'provider-default');
        setSelectedRunnableId(nextRunnables[0] ? runnableId(nextRunnables[0]) : '');
        setMessages(nextRunnables.length ? [] : [{
          role: 'assistant',
          content: 'No hay agentes ni workflows disponibles.',
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

  async function observeRunToTerminal(runId: string, controller: AbortController, after?: string) {
    let terminal = false;

    for await (const agentEvent of client.observeRun(runId, { signal: controller.signal, after })) {
        recordAssistantEvent(agentEvent);

        if (agentEvent.type === 'model.output.delta') {
          const delta = readPayloadText(agentEvent.payload, 'delta');
          const workflowStepId = readPayloadText(agentEvent.payload, 'workflowStepId');
          if (workflowStepId && isResearchStep(selectedRunnable?.name ?? '', workflowStepId)) {
            appendAssistantDraftDelta(
              workflowStepId,
              workflowDraftName(agentEvent.payload),
              delta,
            );
          } else {
            appendAssistantDelta(delta);
          }
        }
        if (agentEvent.type === 'tool.started') {
          setAssistantTool(
            readPayloadText(agentEvent.payload, 'toolCallId'),
            readPayloadText(agentEvent.payload, 'toolName'),
            'running',
            eventTime(agentEvent),
            toolSourceInfo(agentEvent.payload),
          );
        }
        if (agentEvent.type === 'tool.completed') {
          setAssistantTool(
            readPayloadText(agentEvent.payload, 'toolCallId'),
            readPayloadText(agentEvent.payload, 'toolName'),
            'done',
            eventTime(agentEvent),
            toolSourceInfo(agentEvent.payload),
          );
        }
        if (agentEvent.type === 'tool.failed') {
          setAssistantTool(
            readPayloadText(agentEvent.payload, 'toolCallId'),
            readPayloadText(agentEvent.payload, 'toolName'),
            'failed',
            eventTime(agentEvent),
            toolSourceInfo(agentEvent.payload),
          );
        }
        if (agentEvent.type === 'workflow.step.started') {
          setAssistantTool(
            readPayloadText(agentEvent.payload, 'stepId'),
            workflowStepName(agentEvent.payload),
            'running',
            eventTime(agentEvent),
            { label: 'Flujo', remoteName: workflowStepName(agentEvent.payload), kind: 'workflow' },
          );
        }
        if (agentEvent.type === 'workflow.step.completed') {
          setAssistantTool(
            readPayloadText(agentEvent.payload, 'stepId'),
            workflowStepName(agentEvent.payload),
            'done',
            eventTime(agentEvent),
            { label: 'Flujo', remoteName: workflowStepName(agentEvent.payload), kind: 'workflow' },
          );
        }
        if (agentEvent.type === 'workflow.step.failed') {
          setAssistantTool(
            readPayloadText(agentEvent.payload, 'stepId'),
            workflowStepName(agentEvent.payload),
            'failed',
            eventTime(agentEvent),
            { label: 'Flujo', remoteName: workflowStepName(agentEvent.payload), kind: 'workflow' },
          );
        }
        if (agentEvent.type === 'workflow.wait.started') {
          const request = readWorkflowEventRequest(agentEvent.payload);
          if (request) {
            setAssistantWorkflowEvent(request);
            appendAssistantDelta(`\n\nEl flujo está esperando el evento externo “${request.eventName}”.`);
          }
        }
        if (agentEvent.type === 'approval.requested') {
          const request = readApprovalRequest(agentEvent.payload);
          if (request) {
            setAssistantApproval(request);
            appendAssistantDelta(`\n\nEl agente necesita tu aprobación para ejecutar “${request.toolLabel}” y continuar.`);
          }
        }
        if (agentEvent.type === 'elicitation.requested') {
          const request = readElicitationRequest(agentEvent.payload);
          if (request) {
            setAssistantElicitation(request);
            appendAssistantDelta(`\n\n${request.prompt}`);
          }
        }
        if (agentEvent.type === 'run.paused' || agentEvent.type === 'workflow.run.paused') {
          terminal = true;
          completeAssistant('paused', eventTime(agentEvent));
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
          setAssistantAnswer(agentEvent.payload.output);
          completeAssistant(
            'completed',
            eventTime(agentEvent),
            readUsage(agentEvent.payload),
          );
        }
      }

    if (!terminal) throw new Error('Run stream ended before a terminal event.');
  }

  function selectModel(id: string) {
    if (id === selectedModelId) return;
    setSelectedModelId(id);
    const nextModel = models.find((item) => item.id === id);
    setSelectedEffort(nextModel?.efforts[0] ?? 'provider-default');
    resetConversation();
  }

  function selectEffort(effort: ReasoningEffort) {
    if (effort === selectedEffort) return;
    setSelectedEffort(effort);
    resetConversation();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const content = input.trim();
    if (!content || !selectedRunnable || isRunning || pendingElicitationMessage || pendingApprovalMessage || pendingWorkflowEventMessage) return;

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

    try {
      const request = {
        input: content,
        ...(selectedModelId ? { model: selectedModelId } : {}),
        ...(selectedEffort ? { reasoning: selectedEffort } : {}),
        ...(sessionId ? { sessionId } : {}),
      };
      const run =
        selectedRunnable.kind === 'workflow'
          ? await client.startWorkflow(selectedRunnable.name, request)
          : await client.startRun(selectedRunnable.name, request);
      setSessionId(run.sessionId);
      setActiveRunId(run.id);
      setAssistantRun(run);
      await observeRunToTerminal(run.id, controller);
    } catch (error) {
      appendAssistantError(toErrorMessage(error));
      completeAssistant('failed');
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

  function useExamplePrompt(prompt: string) {
    setInput(prompt);
    promptRef.current?.focus();
  }

  async function resumeElicitation(message: Message, value: JsonValue, displayContent: JsonValue = value) {
    if (!message.runId || !message.elicitation || isRunning) return;
    const after = message.events?.at(-1)?.id;
    const requestId = message.elicitation.id;
    const resolvedAt = Date.now();
    setMessages((current) => current.map((item) =>
      item.role === 'assistant' && item.runId === message.runId && item.elicitation?.id === requestId
        ? {
            ...item,
            elicitationResolved: true,
            status: 'completed',
            completedAt: item.completedAt ?? resolvedAt,
            tools: item.tools?.map((tool) =>
              tool.status === 'paused'
                ? { ...tool, status: 'done', completedAt: tool.completedAt ?? resolvedAt }
                : tool,
            ),
          }
        : item,
    ));
    setMessages((current) => [
      ...current,
      { role: 'user', content: displayContent },
      {
        role: 'assistant',
        content: '',
        tools: [],
        events: [],
        startedAt: Date.now(),
        runId: message.runId,
        sessionId: message.sessionId,
        status: 'running',
      },
    ]);
    setIsRunning(true);
    setActiveRunId(message.runId);
    const controller = new AbortController();
    runControllerRef.current = controller;

    try {
      await client.resumeRun(message.runId, {
        type: 'elicitation',
        requestId,
        value,
      });
      await observeRunToTerminal(message.runId, controller, after);
    } catch (error) {
      const staleRun = isRunDefinitionChanged(error);
      setMessages((current) => current.map((item) =>
        item.role === 'assistant' && item.runId === message.runId && item.elicitation?.id === requestId
          ? {
              ...item,
              elicitationResolved: staleRun,
              status: staleRun ? 'failed' : 'paused',
              completedAt: staleRun ? Date.now() : message.completedAt,
            }
          : item,
      ));
      if (staleRun) setSessionId(undefined);
      appendAssistantError(toErrorMessage(error));
      completeAssistant('failed');
    } finally {
      if (runControllerRef.current === controller) runControllerRef.current = null;
      setActiveRunId(undefined);
      setIsRunning(false);
    }
  }

  async function resumeApproval(message: Message, decision: 'approve' | 'reject') {
    if (!message.runId || !message.approval || isRunning) return;
    const after = message.events?.at(-1)?.id;
    const approvalId = message.approval.approvalId;
    const resolvedAt = Date.now();
    setMessages((current) => current.map((item) =>
      item.role === 'assistant' && item.runId === message.runId && item.approval?.approvalId === approvalId
        ? {
            ...item,
            approvalResolved: true,
            status: decision === 'approve' ? 'completed' : 'cancelled',
            completedAt: item.completedAt ?? resolvedAt,
            tools: item.tools?.map((tool) =>
              tool.status === 'paused'
                ? {
                    ...tool,
                    status: decision === 'approve' ? 'done' : 'cancelled',
                    completedAt: tool.completedAt ?? resolvedAt,
                  }
                : tool,
            ),
          }
        : item,
    ));
    setMessages((current) => [
      ...current,
      { role: 'user', content: decision === 'approve' ? 'Aprobado.' : 'Rechazado.' },
      {
        role: 'assistant',
        content: '',
        tools: [],
        events: [],
        startedAt: Date.now(),
        runId: message.runId,
        sessionId: message.sessionId,
        status: 'running',
      },
    ]);
    setIsRunning(true);
    setActiveRunId(message.runId);
    const controller = new AbortController();
    runControllerRef.current = controller;

    try {
      await client.resumeRun(message.runId, {
        type: 'approval',
        approvalId,
        decision,
      });
      await observeRunToTerminal(message.runId, controller, after);
    } catch (error) {
      const staleRun = isRunDefinitionChanged(error);
      setMessages((current) => current.map((item) =>
        item.role === 'assistant' && item.runId === message.runId && item.approval?.approvalId === approvalId
          ? {
              ...item,
              approvalResolved: staleRun,
              status: staleRun ? 'failed' : 'paused',
              completedAt: staleRun ? Date.now() : message.completedAt,
            }
          : item,
      ));
      if (staleRun) setSessionId(undefined);
      appendAssistantError(toErrorMessage(error));
      completeAssistant('failed');
    } finally {
      if (runControllerRef.current === controller) runControllerRef.current = null;
      setActiveRunId(undefined);
      setIsRunning(false);
    }
  }

  async function resumeWorkflowEvent(message: Message, comment: string) {
    if (!message.runId || !message.workflowEvent || isRunning) return;
    const after = message.events?.at(-1)?.id;
    const { eventName } = message.workflowEvent;
    const resolvedAt = Date.now();
    setMessages((current) => current.map((item) =>
      item.role === 'assistant' && item.runId === message.runId && item.workflowEvent?.eventName === eventName
        ? {
            ...item,
            workflowEventResolved: true,
            status: 'completed',
            completedAt: item.completedAt ?? resolvedAt,
            tools: item.tools?.map((tool) =>
              tool.status === 'paused'
                ? { ...tool, status: 'done', completedAt: tool.completedAt ?? resolvedAt }
                : tool,
            ),
          }
        : item,
    ));
    setMessages((current) => [
      ...current,
      { role: 'user', content: comment.trim() ? `Evento ${eventName}: ${comment.trim()}` : `Evento ${eventName} enviado.` },
      {
        role: 'assistant',
        content: '',
        tools: [],
        events: [],
        startedAt: Date.now(),
        runId: message.runId,
        sessionId: message.sessionId,
        status: 'running',
      },
    ]);
    setIsRunning(true);
    setActiveRunId(message.runId);
    const controller = new AbortController();
    runControllerRef.current = controller;

    try {
      await client.resumeRun(message.runId, {
        type: 'event',
        eventName,
        payload: workflowEventPayload(eventName, comment),
      });
      await observeRunToTerminal(message.runId, controller, after);
    } catch (error) {
      const staleRun = isRunDefinitionChanged(error);
      setMessages((current) => current.map((item) =>
        item.role === 'assistant' && item.runId === message.runId && item.workflowEvent?.eventName === eventName
          ? {
              ...item,
              workflowEventResolved: staleRun,
              status: staleRun ? 'failed' : 'paused',
              completedAt: staleRun ? Date.now() : message.completedAt,
            }
          : item,
      ));
      if (staleRun) setSessionId(undefined);
      appendAssistantError(toErrorMessage(error));
      completeAssistant('failed');
    } finally {
      if (runControllerRef.current === controller) runControllerRef.current = null;
      setActiveRunId(undefined);
      setIsRunning(false);
    }
  }

  function appendAssistantDelta(delta: string) {
    setMessages((current) => {
      const next = [...current];
      const last = next[next.length - 1];
      if (last?.role === 'assistant') {
        next[next.length - 1] = {
          ...last,
          content: typeof last.content === 'string' ? last.content + delta : delta,
        };
      } else {
        next.push({ role: 'assistant', content: delta });
      }
      return next;
    });
  }

  function appendAssistantDraftDelta(id: string, name: string, delta: string) {
    if (!id || !delta) return;
    setMessages((current) => {
      const next = [...current];
      const last = next[next.length - 1];
      if (last?.role !== 'assistant') return current;
      const drafts = [...(last.drafts ?? [])];
      const index = drafts.findIndex((draft) => draft.id === id);
      const previous = drafts[index];
      const draft = {
        id,
        name,
        content: `${previous?.content ?? ''}${delta}`,
      };
      if (index === -1) drafts.push(draft);
      else drafts[index] = draft;
      next[next.length - 1] = { ...last, drafts };
      return next;
    });
  }

  function appendAssistantError(error: string) {
    if (!error) return;
    setMessages((current) => {
      const next = [...current];
      const last = next[next.length - 1];
      if (last?.role !== 'assistant') return current;
      const content = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
      const separator = content.trim() ? '\n\n' : '';
      next[next.length - 1] = { ...last, content: `${content}${separator}${error}` };
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

  function setAssistantAnswer(content: JsonValue) {
    setMessages((current) => {
      const next = [...current];
      const last = next[next.length - 1];
      if (last?.role !== 'assistant') return current;
      next[next.length - 1] = { ...last, content };
      return next;
    });
  }

  function setAssistantElicitation(request: ElicitationRequest) {
    setMessages((current) => {
      const next = [...current];
      const last = next[next.length - 1];
      if (last?.role !== 'assistant') return current;
      next[next.length - 1] = { ...last, elicitation: request };
      return next;
    });
  }

  function setAssistantApproval(request: ApprovalRequestSummary) {
    setMessages((current) => {
      const next = [...current];
      const last = next[next.length - 1];
      if (last?.role !== 'assistant') return current;
      next[next.length - 1] = { ...last, approval: request };
      return next;
    });
  }

  function setAssistantWorkflowEvent(request: WorkflowEventSummary) {
    setMessages((current) => {
      const next = [...current];
      const last = next[next.length - 1];
      if (last?.role !== 'assistant') return current;
      next[next.length - 1] = { ...last, workflowEvent: request };
      return next;
    });
  }

  function setAssistantTool(
    id: string,
    name: string,
    status: ToolActivity['status'],
    time: number,
    source?: { label: string; remoteName: string; kind?: string },
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
        source: source?.label || previous?.source,
        remoteName: source?.remoteName || previous?.remoteName,
        kind: source?.kind || previous?.kind || 'tool',
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
        status === 'completed'
          ? 'done'
          : status === 'paused'
            ? 'paused'
            : status === 'cancelled'
              ? 'cancelled'
              : 'failed';
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
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    stickToBottomRef.current = distance < 64;
  }

  function resetConversation() {
    setMessages([]);
    setSessionId(undefined);
    setInput('');
  }

  function toggleRightPanel() {
    if (rightPanelCollapsed) {
      setRightPanelWidth(defaultRightPanelWidth());
      setRightPanelCollapsed(false);
    } else {
      setRightPanelCollapsed(true);
    }
  }

  function startRightPanelResize(event: PointerEvent<HTMLDivElement>) {
    const panel = rightPanelRef.current;
    if (!panel) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panel.getBoundingClientRect().width;
    let frame = 0;
    let nextWidth = startWidth;
    let rawWidth = startWidth;

    const applyWidth = () => {
      frame = 0;
      panel.style.width = `${nextWidth}px`;
    };
    const resize = (moveEvent: globalThis.PointerEvent) => {
      rawWidth = startWidth + startX - moveEvent.clientX;
      nextWidth = clamp(rawWidth, minRightPanelWidth, maxRightPanelWidth());
      if (!frame) frame = requestAnimationFrame(applyWidth);
    };
    const stop = () => {
      if (frame) cancelAnimationFrame(frame);
      document.body.classList.remove('resizing-right-panel');
      if (rawWidth < collapseRightPanelWidth) {
        panel.style.width = '';
        setRightPanelCollapsed(true);
      } else {
        setRightPanelWidth(nextWidth);
      }
      window.removeEventListener('pointermove', resize);
      window.removeEventListener('pointerup', stop);
    };

    document.body.classList.add('resizing-right-panel');
    window.addEventListener('pointermove', resize);
    window.addEventListener('pointerup', stop, { once: true });
  }

  function resizeRightPanelWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    setRightPanelWidth((width) =>
      clamp(width + (event.key === 'ArrowLeft' ? 24 : -24), minRightPanelWidth, maxRightPanelWidth()),
    );
  }

  return (
    <div
      className="shell"
      data-right-panel-collapsed={rightPanelCollapsed}
      data-sidebar-collapsed={sidebarCollapsed}
    >
        <aside className="sidebar" data-collapsed={sidebarCollapsed}>
          <div className="sidebar-header">
            <p className="sidebar-title">Ejemplos</p>
            <Button
              aria-label={sidebarCollapsed ? 'Expandir barra de ejemplos' : 'Contraer barra de ejemplos'}
              aria-pressed={sidebarCollapsed}
              className="sidebar-toggle"
              size="icon"
              variant="ghost"
              onClick={() => setSidebarCollapsed((value) => !value)}
              title={sidebarCollapsed ? 'Expandir barra de ejemplos' : 'Contraer barra de ejemplos'}
              type="button"
            >
              {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </Button>
          </div>
          <nav className="agent-list" aria-label="Agentes y workflows">
            {!runnables.length && (
              <p className="empty-state">{isLoadingRunnables ? 'Cargando...' : 'Sin demos'}</p>
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
                  title={`${item.label} - ${item.description}`}
                  type="button"
                >
                  <span className="sidebar-icon">
                    <Icon size={16} />
                  </span>
                  <span>
                    <strong>{item.label}</strong>
                    <small>{item.kind === 'workflow' ? 'Flujo' : 'Agente'} / {item.description}</small>
                  </span>
                  <Check className="agent-check" size={14} />
                </button>
              );
            })}
          </nav>
        </aside>

      <div className="app-frame">
        <header className="topbar">
          <div className="brand">
            <span className="brand-icon">
              <Sparkles size={15} />
            </span>
            <div>
              <strong>Fevex</strong>
              <span>Playground de ejemplos</span>
            </div>
          </div>
          <div className="toolbar">
            <Button
              aria-label={`${debug ? 'Desactivar' : 'Activar'} modo debug`}
              aria-pressed={debug}
              className={`icon-button ${debug ? 'active' : ''}`}
              size="icon"
              variant="ghost"
              onClick={() => setDebug((value) => !value)}
              title={`${debug ? 'Desactivar' : 'Activar'} modo debug`}
              type="button"
            >
              <Bug size={16} />
            </Button>
            <Button
              aria-label="Limpiar conversación"
              className="icon-button"
              disabled={isRunning || (messages.length === 1 && !sessionId)}
              size="icon"
              variant="ghost"
              onClick={resetConversation}
              title="Limpiar conversación"
              type="button"
            >
              <Trash2 size={16} />
            </Button>
            <Button
              aria-label={rightPanelCollapsed ? 'Abrir panel de entorno' : 'Cerrar panel de entorno'}
              aria-pressed={!rightPanelCollapsed}
              className={`icon-button ${rightPanelCollapsed ? '' : 'active'}`}
              size="icon"
              variant="ghost"
              onClick={toggleRightPanel}
              title={rightPanelCollapsed ? 'Abrir panel de entorno' : 'Cerrar panel de entorno'}
              type="button"
            >
              {rightPanelCollapsed ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}
            </Button>
          </div>
        </header>

        <main className="playground" onScroll={updateStickToBottom} ref={scrollerRef}>
          <section className="conversation" aria-label="Conversación del run" aria-live="polite">
            <div className="agent">
              <span className="avatar">
                <AgentIcon size={17} />
              </span>
              <div>
                <strong>{selectedRunnable?.label ?? 'Ningún demo seleccionado'}</strong>
                <span>{selectedRunnable?.description ?? 'Inicia la API Nest para cargar ejemplos.'}</span>
                {selectedRunnable?.instructions && (
                  <p className="agent-instructions">{selectedRunnable.instructions}</p>
                )}
              </div>
            </div>

            <div className="messages">
              {messages.map((message, index) => (
                <article className={`message ${message.role}`} key={index}>
                  {message.role === 'assistant' && (
                    <span className="avatar">
                      <AgentIcon size={16} />
                    </span>
                  )}
                  <div>
                    {message.role === 'assistant' && (
                      <RunActivityPanel debug={debug} message={message} now={now} />
                    )}
                    <MessageContent content={message.content} />
                    {message.role === 'assistant' && message.elicitation && !message.elicitationResolved && message.status === 'paused' && (
                      <ApprovalCard
                        disabled={isRunning}
                        request={message.elicitation}
                        onSubmit={(value) => void resumeElicitation(
                          message,
                          value,
                          formatElicitationDisplay(message.elicitation!, value),
                        )}
                      />
                    )}
                    {message.role === 'assistant' && message.approval && !message.approvalResolved && message.status === 'paused' && (
                      <ApprovalDecisionCard
                        disabled={isRunning}
                        toolLabel={message.approval.toolLabel}
                        onSubmit={(decision) => void resumeApproval(message, decision)}
                      />
                    )}
                    {message.role === 'assistant' && message.workflowEvent && !message.workflowEventResolved && message.status === 'paused' && (
                      <WorkflowEventCard
                        disabled={isRunning}
                        eventName={message.workflowEvent.eventName}
                        onSubmit={(comment) => void resumeWorkflowEvent(message, comment)}
                      />
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>

          <div className="composer-dock">
            {messages.length === 0 && selectedRunnable?.examples?.length ? (
              <div className="composer-examples" aria-label="Prompts de ejemplo">
                {selectedRunnable.examples.map((example) => (
                  <button
                    disabled={isRunning}
                    key={example}
                    onClick={() => useExamplePrompt(example)}
                    type="button"
                  >
                    <Sparkles size={13} />
                    <span>{example}</span>
                  </button>
                ))}
              </div>
            ) : null}
            <form className="composer" onSubmit={submit}>
              <label htmlFor="prompt">Prompt</label>
              <textarea
                id="prompt"
                ref={promptRef}
                maxLength={4000}
                disabled={isRunning || Boolean(pendingElicitationMessage) || Boolean(pendingApprovalMessage) || Boolean(pendingWorkflowEventMessage)}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder="Escribe al ejemplo seleccionado..."
                rows={1}
                value={input}
              />
              <div className="composer-footer">
                <div className="composer-pickers">
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          aria-label="Seleccionar modelo y esfuerzo"
                          className="composer-menu-trigger"
                          disabled={isRunning || models.length === 0}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          <span className="composer-menu-label">{selectedModelLabel}</span>
                          <span className="composer-menu-effort">{selectedEffortLabel}</span>
                          <ChevronDown size={14} />
                        </Button>
                      }
                    />
                    <DropdownMenuContent align="end" side="top" className="composer-menu-content">
                      <DropdownMenuGroup>
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger>Modelo</DropdownMenuSubTrigger>
                          <DropdownMenuSubContent className="composer-menu-subcontent">
                            {models.map((item) => (
                              <DropdownMenuItem
                                closeOnClick={false}
                                key={item.id}
                                onClick={() => selectModel(item.id)}
                              >
                                <span>{item.model ?? item.id}</span>
                                {item.id === selectedModelId ? <Check size={13} /> : null}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                        <DropdownMenuSeparator />
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger>Esfuerzo</DropdownMenuSubTrigger>
                          <DropdownMenuSubContent className="composer-menu-subcontent">
                            {efforts.map((effort) => (
                              <DropdownMenuItem
                                closeOnClick={false}
                                key={effort}
                                onClick={() => selectEffort(effort)}
                              >
                                <span>{effortLabel(effort)}</span>
                                {effort === selectedEffort ? <Check size={13} /> : null}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <Button
                  aria-label={isRunning ? 'Cancelar run' : 'Ejecutar demo seleccionado'}
                  className={`composer-submit${isRunning ? ' cancel' : ''}`}
                  disabled={isRunning ? !activeRunId : !input.trim() || !selectedRunnable || Boolean(pendingElicitationMessage) || Boolean(pendingApprovalMessage) || Boolean(pendingWorkflowEventMessage)}
                  size="icon"
                  onClick={isRunning ? () => void cancelActiveRun() : undefined}
                  title={isRunning ? 'Cancelar run' : 'Ejecutar demo seleccionado'}
                  type={isRunning ? 'button' : 'submit'}
                >
                  {isRunning ? <Square fill="currentColor" size={14} /> : <ArrowUp size={17} />}
                </Button>
              </div>
            </form>
          </div>
        </main>
      </div>

      <aside
        className="right-panel"
        data-collapsed={rightPanelCollapsed}
        ref={rightPanelRef}
        style={rightPanelCollapsed ? undefined : { width: rightPanelWidth }}
      >
        <div
          aria-label="Redimensionar panel de entorno"
          aria-orientation="vertical"
          className="right-panel-resize-handle"
          onKeyDown={resizeRightPanelWithKeyboard}
          onPointerDown={startRightPanelResize}
          role="separator"
          tabIndex={0}
        />
        <div className="right-panel-header">
          <p>Entorno</p>
        </div>
        <div className="right-panel-list">
          <EnvironmentRow icon={<Circle size={14} />} label="API" value={apiUrl} />
          <EnvironmentRow icon={<Sparkles size={14} />} label="Modelo" value={models.find((item) => item.id === selectedModelId)?.model ?? (selectedModelId || 'Ninguno')} />
          <EnvironmentRow icon={<Sparkles size={14} />} label="Esfuerzo" value={effortLabel(selectedEffort)} />
          <EnvironmentRow icon={<AgentIcon size={14} />} label="Seleccionado" value={selectedRunnable?.label ?? 'Ninguno'} />
          <EnvironmentRow
            icon={<Sparkles size={14} />}
            label="Tipo"
            value={selectedRunnable?.kind === 'workflow' ? 'Flujo' : selectedRunnable?.kind === 'agent' ? 'Agente' : '-'}
          />
          <EnvironmentRow icon={<Bug size={14} />} label="Depuración" value={debug ? 'Activo' : 'Inactivo'} />
          <EnvironmentRow icon={<Check size={14} />} label="Ejecución" value={activeRunId ?? 'Sin ejecución activa'} />
        </div>
      </aside>
    </div>
  );
}

function EnvironmentRow({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="right-panel-row">
      <span>{icon}</span>
      <strong>{label}</strong>
      <small>{value}</small>
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
  const tools = message.tools ?? [];
  const drafts = message.drafts?.filter((draft) => draft.content.trim()) ?? [];
  const hasDetails = tools.length > 0 || drafts.length > 0 || debug;

  const header = (
    <>
      <MarkerIcon>
        <RunStatusIcon running={running} status={message.status} />
      </MarkerIcon>
      <MarkerContent className={running ? 'shimmer' : undefined}>
        {activitySummary(message, running, elapsedMs)}
      </MarkerContent>
      {hasDetails && !running && (
        <ChevronRight
          className="shrink-0 transition-transform group-open/activity:rotate-90"
          size={13}
        />
      )}
    </>
  );

  if (!hasDetails) {
    return (
      <Marker className="mt-2" role="status" variant="border">
        {header}
      </Marker>
    );
  }

  const body = (
    <div className="mt-3 flex flex-col gap-2.5">
      {tools.length > 0 && (
        <ToolTimeline now={now} tools={tools} />
      )}
      {drafts.length > 0 && (
        <>
          <Marker variant="separator">
            <MarkerContent>Research</MarkerContent>
          </Marker>
          <div className="draft-list">
            {drafts.map((draft) => (
              <details className="draft" key={draft.id}>
                <summary>{draft.name}</summary>
                <MessageContent content={draft.content} />
              </details>
            ))}
          </div>
        </>
      )}
      {debug && <DebugPanel message={message} elapsedMs={elapsedMs} />}
    </div>
  );

  if (running) {
    return (
      <div className="mt-2" role="status">
        <Marker variant="border">
          {header}
        </Marker>
      </div>
    );
  }

  return (
    <details className="group/activity mt-2">
      <Marker
        className="cursor-pointer list-none [&::-webkit-details-marker]:hidden"
        render={<summary />}
        role="status"
        variant="border"
      >
        {header}
      </Marker>
      {body}
    </details>
  );
}

const thinkingDelays = Array.from({ length: 9 }, (_, index) => {
  const row = Math.floor(index / 3);
  const column = index % 3;
  return (column + Math.abs(row - 1)) * 90;
});

function PixelGridLoader() {
  return (
    <span aria-hidden className="pixel-loader">
      {thinkingDelays.map((delay, index) => (
        <span
          className="pixel-loader-cell"
          key={index}
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

function ToolTimeline({ now, tools }: { now: number; tools: ToolActivity[] }) {
  const finalStatus = tools.some((tool) => tool.status === 'failed')
    ? 'failed'
    : tools.some((tool) => tool.status === 'cancelled')
      ? 'cancelled'
      : tools.some((tool) => tool.status === 'paused')
        ? 'paused'
        : 'done';

  return (
    <div className="tool-timeline">
      {tools.map((tool) => (
        <Marker className="tool-timeline-row" key={tool.id} role="status">
          <MarkerIcon className={`tool-timeline-icon ${tool.status}`}>
            <ToolTypeIcon kind={tool.kind} />
          </MarkerIcon>
          <MarkerContent className={tool.status === 'running' ? 'shimmer' : undefined}>
            {tool.source && <span className="text-muted-foreground">{tool.source} · </span>}
            <span className="font-mono">{tool.remoteName ?? tool.name}</span>
            {toolStatusText(tool) ? ` · ${toolStatusText(tool)}` : ''}
            {' · '}
            {formatToolDuration((tool.completedAt ?? now) - tool.startedAt)}
          </MarkerContent>
        </Marker>
      ))}
      <Marker className="tool-timeline-row" role="status">
        <MarkerIcon className={`tool-timeline-icon ${finalStatus}`}>
          <ToolStatusIcon status={finalStatus} />
        </MarkerIcon>
        <MarkerContent>Listo</MarkerContent>
      </Marker>
    </div>
  );
}

// finishing a run is the expected outcome, so it stays muted; only the states
// that need attention get colour.
function RunStatusIcon({ running, status }: { running: boolean; status?: Message['status'] }) {
  if (running) return <PixelGridLoader />;
  if (status === 'failed') return <CircleX className="text-destructive" />;
  if (status === 'cancelled') return <CircleSlash2 />;
  if (status === 'paused') return <CircleDashed className="text-yellow-500" />;
  return <Check />;
}

function ToolStatusIcon({ status }: { status: ToolActivity['status'] }) {
  if (status === 'running') return <Spinner />;
  if (status === 'failed') return <CircleX className="text-destructive" />;
  if (status === 'cancelled') return <CircleSlash2 />;
  if (status === 'paused') return <CircleDashed className="text-yellow-500" />;
  return <Check />;
}

function ToolTypeIcon({ kind }: { kind?: string }) {
  if (kind === 'mcp' || kind === 'openapi') return <Plug />;
  if (kind === 'workflow') return <Sparkles />;
  return <Wrench />;
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

function MessageContent({ content }: { content: JsonValue }) {
  if (typeof content !== 'string') {
    return (
      <div className="message-content">
        <pre><code>{JSON.stringify(content, null, 2)}</code></pre>
      </div>
    );
  }

  return (
    <div className="message-content">
      <ReactMarkdown
        components={{ pre: CodeBlock }}
        rehypePlugins={[rehypeKatex, rehypeHighlight]}
        remarkPlugins={[remarkGfm, remarkMath]}
      >
        {normalizeMathMarkdown(content)}
      </ReactMarkdown>
    </div>
  );
}

function CodeBlock({ children, ...props }: ComponentProps<'pre'>) {
  const codeRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const language = codeBlockLanguage(children);

  async function copyCode() {
    const text = codeRef.current?.textContent;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {}
  }

  return (
    <div className="code-block">
      {language && <span className="code-language">{language}</span>}
      <button className="code-copy" onClick={() => void copyCode()} type="button">
        {copied ? <Check size={12} /> : <Copy size={12} />}
        {copied ? 'Copiado' : 'Copiar'}
      </button>
      <pre {...props} ref={codeRef}>{children}</pre>
    </div>
  );
}

function codeBlockLanguage(node: ReactNode): string | undefined {
  if (isValidElement<{ className?: string }>(node)) {
    return node.props.className?.match(/\blanguage-([^\s]+)/)?.[1];
  }
  if (Array.isArray(node)) return node.map(codeBlockLanguage).find(Boolean);
  return undefined;
}

function WorkflowEventCard({
  disabled,
  eventName,
  onSubmit,
}: {
  disabled?: boolean;
  eventName: string;
  onSubmit(comment: string): void;
}) {
  const [comment, setComment] = useState('');
  const [sent, setSent] = useState(false);

  const submitEvent = () => {
    if (disabled || sent) return;
    setSent(true);
    onSubmit(comment);
  };

  return (
    <div className="approval-decision-card">
      <div>
        <strong>{sent ? 'Evento enviado' : 'Enviar evento externo'}</strong>
        <p>
          {sent
            ? 'El run continuará con el evento recibido.'
            : `El flujo espera “${eventName}” para continuar.`}
        </p>
      </div>
      {!sent && (
        <>
          <label className="approval-custom">
            <input
              disabled={disabled}
              onChange={(event) => setComment(event.target.value)}
              placeholder="Comentario opcional"
              value={comment}
            />
          </label>
          <div className="approval-decision-actions">
            <button data-kind="approve" disabled={disabled} onClick={submitEvent} type="button">
              Enviar evento
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ApprovalCard({
  disabled,
  onSubmit,
  request,
}: {
  disabled?: boolean;
  onSubmit(value: JsonValue): void;
  request: ElicitationRequest;
}) {
  const questions = elicitationQuestions(request.responseSchema);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [sent, setSent] = useState(false);
  const [open, setOpen] = useState(true);
  const question = questions[index];
  const last = index === questions.length - 1;
  const selected = question ? (answers[question.name] ?? []) : [];
  const customValue = question ? (custom[question.name] ?? '') : '';
  const hasAnswer = selected.length > 0 || Boolean(customValue.trim());
  const canAdvance = !question?.required || hasAnswer;
  const canSubmit = questions.every((item) => !item.required || hasApprovalAnswer(item, answers, custom));

  const setSelected = (value: string) => {
    if (!question) return;
    setAnswers((current) => {
      const picked = current[question.name] ?? [];
      const next = question.kind === 'check'
        ? picked.includes(value)
          ? picked.filter((item) => item !== value)
          : [...picked, value]
        : [value];
      return { ...current, [question.name]: next };
    });
    setCustom((current) => ({ ...current, [question.name]: '' }));
    if ((question.kind === 'radio' || question.kind === 'boolean') && !last) {
      window.setTimeout(() => {
        setIndex((current) => Math.min(questions.length - 1, current + 1));
      }, 220);
    }
  };

  const submitAnswers = () => {
    if (!question || !canSubmit || sent) return;
    setSent(true);
    onSubmit(Object.fromEntries(
      questions
        .filter((item) => item.required || hasApprovalAnswer(item, answers, custom))
        .map((item) => [item.name, readApprovalAnswer(item, answers[item.name] ?? [], custom[item.name] ?? '')]),
    ));
  };

  if (!open) {
    return (
      <button className="approval-reopen" onClick={() => setOpen(true)} type="button">
        Abrir aprobación
      </button>
    );
  }

  if (!question) return null;

  const questionLabel = displayQuestionLabel(question, request.prompt);
  const questionHelp = displayQuestionDescription(question, request.prompt, questionLabel);

  return (
    <form
      aria-label="Solicitud de aprobación"
      className="approval-card"
      onSubmit={(event) => {
        event.preventDefault();
        submitAnswers();
      }}
    >
      {sent ? (
        <div className="approval-sent">
          <span><Check size={13} /></span>
          <strong>Respuesta enviada</strong>
        </div>
      ) : (
        <>
          <div className="approval-card-body">
            <div className="approval-card-header">
              <span>
                <strong>{questionLabel}</strong>
                {questionHelp && <em>{questionHelp}</em>}
              </span>
              <button
                aria-label="Cerrar tarjeta de aprobación"
                className="approval-icon-button"
                onClick={() => setOpen(false)}
                type="button"
              >
                <X size={14} />
              </button>
            </div>
            <div className="approval-options">
              {(question.kind === 'radio' || question.kind === 'check' || question.kind === 'boolean') ? (
                question.options.map((option) => {
                  const on = selected.includes(option.value);
                  return (
                    <button
                      aria-pressed={on}
                      className="approval-option"
                      disabled={disabled}
                      key={option.value}
                      onClick={() => setSelected(option.value)}
                      type="button"
                    >
                      <span
                        className="approval-option-mark"
                        data-kind={question.kind === 'check' ? 'check' : 'radio'}
                        data-selected={on}
                      >
                        {question.kind === 'check' && on ? <Check size={11} /> : <span />}
                      </span>
                      <span>{option.label}</span>
                    </button>
                  );
                })
              ) : (
                <label className="approval-custom">
                  <input
                    aria-label={questionLabel}
                    disabled={disabled}
                    inputMode={question.inputType === 'number' ? 'numeric' : undefined}
                    onChange={(event) => {
                      setCustom((current) => ({ ...current, [question.name]: event.target.value }));
                      setAnswers((current) => ({ ...current, [question.name]: [] }));
                    }}
                    required={question.required}
                    placeholder={question.inputType === 'number' ? 'Número' : 'Respuesta'}
                    type={question.inputType === 'number' ? 'number' : 'text'}
                    value={customValue}
                  />
                </label>
              )}
              {question.kind !== 'input' && question.kind !== 'boolean' && (
                <label className="approval-custom inline">
                  <span />
                  <input
                    disabled={disabled}
                    onChange={(event) => {
                      setCustom((current) => ({ ...current, [question.name]: event.target.value }));
                      setAnswers((current) => ({ ...current, [question.name]: [] }));
                    }}
                    placeholder="Escribe algo..."
                    value={customValue}
                  />
                </label>
              )}
            </div>
          </div>
          <div className="approval-card-footer">
            <span className="approval-pager">
              <button
                aria-label="Pregunta anterior"
                disabled={disabled || index === 0}
                onClick={() => setIndex((current) => Math.max(0, current - 1))}
                type="button"
              >
                <ChevronLeft size={14} />
              </button>
              {questions.map((item, itemIndex) => (
                <button
                  aria-current={itemIndex === index ? 'step' : undefined}
                  aria-label={`Ir a ${item.label}`}
                  className="approval-dot"
                  data-active={itemIndex === index}
                  data-done={itemIndex < index}
                  disabled={disabled}
                  key={item.name}
                  onClick={() => setIndex(itemIndex)}
                  type="button"
                />
              ))}
              <button
                aria-label="Siguiente pregunta"
                disabled={disabled || last}
                onClick={() => setIndex((current) => Math.min(questions.length - 1, current + 1))}
                type="button"
              >
                <ChevronRight size={14} />
              </button>
            </span>
            <button
              aria-label={last ? 'Enviar respuesta' : 'Siguiente pregunta'}
              className="approval-send"
              data-ready={last ? canSubmit : canAdvance}
              disabled={disabled || !(last ? canSubmit : canAdvance)}
              onClick={() => {
                if (!last) setIndex((current) => current + 1);
              }}
              type={last ? 'submit' : 'button'}
            >
              <ArrowUp size={15} />
            </button>
          </div>
        </>
      )}
    </form>
  );
}

function runnableId(item: RunnableSummary) {
  return `${item.kind}:${item.name}`;
}

function effortLabel(effort: ReasoningEffort): string {
  return effort === 'provider-default' ? 'Proveedor' : effort;
}

function normalizeMathMarkdown(content: string) {
  return content.replace(/^\[\s*([^\]\n]*(?:\\|=|≈|\\approx|\\times|\\frac|\\text)[^\]\n]*)\s*\]$/gm, '$$$$\n$1\n$$$$');
}

function readElicitationRequest(payload: unknown): ElicitationRequest | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const request = (payload as Record<string, unknown>).request;
  if (!request || typeof request !== 'object' || Array.isArray(request)) return undefined;
  const value = request as Record<string, unknown>;
  if (
    typeof value.id !== 'string' ||
    typeof value.toolCallId !== 'string' ||
    typeof value.prompt !== 'string' ||
    !value.responseSchema ||
    typeof value.responseSchema !== 'object' ||
    Array.isArray(value.responseSchema) ||
    typeof value.requestedAt !== 'string'
  ) return undefined;
  return value as unknown as ElicitationRequest;
}

function readApprovalRequest(payload: unknown): ApprovalRequestSummary | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const approvalId = readPayloadText(payload, 'approvalId');
  const toolCallId = readPayloadText(payload, 'toolCallId');
  const toolName = readPayloadText(payload, 'toolName');
  const toolLabel = readPayloadText(payload, 'toolLabel') || toolName;
  if (!approvalId || !toolCallId || !toolName) return undefined;
  return { approvalId, toolCallId, toolName, toolLabel };
}

function readWorkflowEventRequest(payload: unknown): WorkflowEventSummary | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  if (readPayloadText(payload, 'kind') !== 'event') return undefined;
  const stepId = readPayloadText(payload, 'stepId');
  const eventName = readPayloadText(payload, 'eventName');
  if (!stepId || !eventName) return undefined;
  return { stepId, eventName };
}

function workflowEventPayload(eventName: string, comment: string): JsonValue {
  if (eventName === 'review.approved') {
    return {
      approved: true,
      ...(comment.trim() ? { comment: comment.trim() } : {}),
    };
  }
  return comment.trim() ? { comment: comment.trim() } : {};
}

type ApprovalQuestion = {
  name: string;
  label: string;
  description?: string;
  kind: 'radio' | 'check' | 'boolean' | 'input';
  inputType: 'text' | 'number';
  required: boolean;
  options: Array<{ label: string; value: string }>;
  valueType: 'string' | 'number' | 'integer' | 'boolean' | 'array';
};

function elicitationQuestions(schema: JsonValue): ApprovalQuestion[] {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [];
  const record = schema as Record<string, unknown>;
  const properties = record.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return [];
  const required = new Set(Array.isArray(record.required) ? record.required.filter((item) => typeof item === 'string') : []);
  return Object.entries(properties)
    .filter((entry): entry is [string, Record<string, unknown>] =>
      typeof entry[1] === 'object' && entry[1] !== null && !Array.isArray(entry[1]),
    )
    .map(([name, property]) => {
      const type = readSchemaType(property);
      const enumOptions = readEnumOptions(property.enum);
      const arrayOptions = type === 'array' && property.items && typeof property.items === 'object' && !Array.isArray(property.items)
        ? readEnumOptions((property.items as Record<string, unknown>).enum)
        : [];
      const description = readSchemaText(property.description);
      const kind =
        arrayOptions.length > 0
          ? 'check'
          : type === 'boolean'
            ? 'boolean'
            : enumOptions.length > 0
              ? 'radio'
              : 'input';
      return {
        name,
        label: readSchemaText(property.title) ?? name,
        ...(description === undefined ? {} : { description }),
        kind,
        inputType: type === 'number' || type === 'integer' ? 'number' : 'text',
        required: required.has(name),
        options:
          kind === 'boolean'
            ? [
                { label: 'Sí', value: 'true' },
                { label: 'No', value: 'false' },
              ]
            : kind === 'check'
              ? arrayOptions
              : enumOptions,
        valueType: type,
      };
    });
}

function readSchemaText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function displayQuestionLabel(question: ApprovalQuestion, prompt: string) {
  return sameText(question.label, prompt) ? question.name : question.label;
}

function displayQuestionDescription(question: ApprovalQuestion, prompt: string, label: string) {
  if (!question.description) return undefined;
  return sameText(question.description, prompt) || sameText(question.description, label)
    ? undefined
    : question.description;
}

function sameText(left: string, right: string) {
  return normalizeText(left) === normalizeText(right);
}

function normalizeText(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function readSchemaType(property: Record<string, unknown>): ApprovalQuestion['valueType'] {
  const type = Array.isArray(property.type) ? property.type[0] : property.type;
  if (
    type === 'number' ||
    type === 'integer' ||
    type === 'boolean' ||
    type === 'array'
  ) return type;
  return 'string';
}

function readEnumOptions(value: unknown): Array<{ label: string; value: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string | number | boolean =>
      typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean',
    )
    .map((item) => ({ label: String(item), value: String(item) }));
}

function readApprovalAnswer(question: ApprovalQuestion, selected: string[], custom: string): JsonValue {
  const raw = custom.trim() ? custom : selected[0] ?? '';
  if (question.kind === 'check') {
    const values = custom.trim() ? [custom] : selected;
    return values.map((value) => coerceApprovalValue(question, value));
  }
  return coerceApprovalValue(question, raw);
}

function formatElicitationDisplay(request: ElicitationRequest, value: JsonValue) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return String(value ?? '');

  const questions = elicitationQuestions(request.responseSchema);
  const labels = new Map(questions.map((question) => [question.name, question.label]));
  const entries = Object.entries(value);
  if (entries.length === 1) {
    const [name, fieldValue] = entries[0]!;
    if (name === 'accountId') return `La cuenta es ${formatDisplayValue(fieldValue as JsonValue)}.`;
    return `${labels.get(name) ?? name}: ${formatDisplayValue(fieldValue as JsonValue)}`;
  }

  return entries
    .map(([name, fieldValue]) =>
      name === 'accountId'
        ? `**Cuenta:** ${formatDisplayValue(fieldValue as JsonValue)}`
        : `**${labels.get(name) ?? name}:** ${formatDisplayValue(fieldValue as JsonValue)}`,
    )
    .join('\n');
}

function formatDisplayValue(value: JsonValue): string {
  if (Array.isArray(value)) return value.map(formatDisplayValue).join(', ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  return String(value ?? '');
}

function hasApprovalAnswer(
  question: ApprovalQuestion,
  answers: Record<string, string[]>,
  custom: Record<string, string>,
) {
  return (answers[question.name]?.length ?? 0) > 0 || Boolean(custom[question.name]?.trim());
}

function coerceApprovalValue(question: ApprovalQuestion, value: string): JsonValue {
  if (question.valueType === 'boolean') return value === 'true';
  if (question.valueType === 'integer') return Number.parseInt(value || '0', 10);
  if (question.valueType === 'number') return Number(value || '0');
  return value;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function maxRightPanelWidth() {
  if (typeof window === 'undefined') return 560;
  return Math.max(minRightPanelWidth, Math.floor(window.innerWidth * 0.8));
}

function defaultRightPanelWidth() {
  if (typeof window === 'undefined') return 300;
  return clamp(Math.floor(window.innerWidth * 0.2), minRightPanelWidth, maxRightPanelWidth());
}

function workflowStepName(payload: unknown) {
  const stepId = readPayloadText(payload, 'stepId');
  const agentName = readPayloadText(payload, 'agentName');
  return agentName ? `${stepId}:${agentName}` : stepId;
}

function workflowDraftName(payload: unknown) {
  const stepId = readPayloadText(payload, 'workflowStepId');
  const agentName = readPayloadText(payload, 'workflowAgentName');
  return agentName ? `${stepId}:${agentName}` : stepId;
}

function isResearchStep(workflowName: string, stepId: string) {
  if (workflowName === 'incident-workflow') return stepId !== 'merge';
  if (workflowName === 'review-workflow') return stepId !== 'final';
  return false;
}

function readPayloadText(payload: unknown, key: string) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function toolSourceInfo(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const source = (payload as Record<string, unknown>).source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
  const record = source as Record<string, unknown>;
  const provider = typeof record.provider === 'string' ? record.provider : '';
  const connectionName = typeof record.connectionName === 'string' ? record.connectionName : '';
  const remoteToolName = typeof record.remoteToolName === 'string' ? record.remoteToolName : '';
  if (!provider || !connectionName || !remoteToolName) return undefined;
  const providerName = provider === 'mcp'
    ? 'MCP'
    : provider === 'openapi'
      ? 'OpenAPI'
      : provider;
  return {
    label: `Usando ${providerName} ${connectionName}`,
    remoteName: remoteToolName,
    kind: provider,
  };
}

function eventTime(event: AgentEvent) {
  const time = event.timestamp ? Date.parse(event.timestamp) : NaN;
  return Number.isFinite(time) ? time : Date.now();
}

function runStageLabel(message: Message, running: boolean, elapsedMs: number) {
  const elapsed = formatDuration(elapsedMs);
  // "durante" solo donde el tiempo se pasó haciendo algo; los estados de corte
  // marcan el momento en que se interrumpió.
  if (running) return `${currentStage(message)} durante ${elapsed}`;
  if (message.status === 'paused' && message.elicitationResolved) return `Aprobación enviada después de ${elapsed}`;
  if (message.status === 'paused') return `En espera de aprobación después de ${elapsed}`;
  if (message.status === 'failed') return `Falló después de ${elapsed}`;
  if (message.status === 'cancelled') return `Cancelado después de ${elapsed}`;
  return `Procesado durante ${elapsed}`;
}

function activitySummary(message: Message, running: boolean, elapsedMs: number) {
  return runStageLabel(message, running, elapsedMs);
}

function currentStage(message: Message) {
  const runningTool = message.tools?.find((tool) => tool.status === 'running');
  if (runningTool?.name.includes('tickets')) return 'Buscando';
  if (runningTool?.name.includes('metrics') || runningTool?.name.includes('incidents')) return 'Investigando';
  if (runningTool) return 'Ejecutando';
  return message.content === '' ? 'Pensando' : 'Respondiendo';
}

// a finished tool needs no adjective, its duration already says it ran
function toolStatusText(tool: ToolActivity) {
  if (tool.status === 'failed') return 'falló';
  if (tool.status === 'cancelled') return 'cancelada';
  if (tool.status === 'paused') return 'en espera';
  if (tool.status === 'running') return 'ejecutando';
  return '';
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

function toErrorMessage(error: unknown) {
  if (isRunDefinitionChanged(error)) {
    return 'Este formulario pertenece a una versión anterior del agente. Inicia una conversación nueva para continuar.';
  }
  if (error instanceof FevexHttpError) {
    return `${error.code} (${error.status}): ${error.message}`;
  }
  return error instanceof Error ? error.message : 'Falló la solicitud a la API del agente.';
}

function isRunDefinitionChanged(error: unknown) {
  return error instanceof FevexHttpError && error.code === 'RUN_DEFINITION_CHANGED';
}
