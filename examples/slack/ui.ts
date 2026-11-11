export const chatHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FEVEX Slack simulator</title>
  <style>
    :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; background: #f4f5f7; color: #17202a; }
    main { max-width: 860px; margin: 0 auto; padding: 24px 16px 40px; }
    header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
    h1 { font-size: 22px; margin: 0; }
    .muted { color: #667085; font-size: 13px; }
    .settings { display: grid; grid-template-columns: 160px 1fr 1fr auto; gap: 8px; align-items: end; background: #fff; border: 1px solid #dde1e7; border-radius: 12px; padding: 12px; }
    label { display: grid; gap: 4px; font-size: 12px; color: #475467; }
    input, select, textarea { font: inherit; padding: 8px 10px; border: 1px solid #cfd4dc; border-radius: 8px; background: #fff; }
    textarea { resize: vertical; min-height: 48px; }
    button { font: inherit; padding: 8px 14px; border: 0; border-radius: 8px; background: #1d4ed8; color: #fff; cursor: pointer; }
    button:disabled { opacity: .55; cursor: default; }
    .hint { margin: 8px 2px 16px; }
    #chat { display: flex; flex-direction: column; gap: 10px; min-height: 320px; max-height: 56vh; overflow-y: auto; padding: 16px; background: #fff; border: 1px solid #dde1e7; border-radius: 12px; }
    .bubble { max-width: 82%; padding: 10px 12px; border-radius: 12px; white-space: pre-wrap; line-height: 1.45; }
    .bubble.user { align-self: flex-end; background: #dbeafe; }
    .bubble.assistant { align-self: flex-start; background: #f2f4f7; }
    .meta { font-size: 11px; color: #667085; margin-bottom: 3px; }
    .tool-line { margin-top: 6px; padding-top: 6px; border-top: 1px solid #dde1e7; font-size: 11px; color: #475467; }
    .typing { color: #667085; font-size: 13px; padding: 4px 2px; }
    form { display: flex; gap: 8px; margin-top: 12px; align-items: end; }
    form textarea { flex: 1; }
    .error { min-height: 20px; color: #b42318; font-size: 13px; margin-top: 8px; }
    .tools { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }
    .tools button { background: #475467; }
    @media (max-width: 720px) { .settings { grid-template-columns: 1fr 1fr; } }
  </style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>FEVEX Slack simulator</h1>
      <div class="muted">Local Events API and chat.postMessage substitute. No Slack account required.</div>
    </div>
    <div class="muted" id="status">scripted</div>
  </header>

  <section class="settings">
    <label>Provider
      <select id="provider">
        <option value="scripted">Scripted</option>
        <option value="openai">OpenAI</option>
        <option value="deepseek">DeepSeek</option>
      </select>
    </label>
    <label>API key
      <input id="api-key" type="password" autocomplete="off" placeholder="Required for OpenAI/DeepSeek">
    </label>
    <label>Model
      <input id="model" autocomplete="off" placeholder="Model ID available in your account">
    </label>
    <button id="apply" type="button">Apply</button>
  </section>
  <p class="hint muted">The key is sent to this local process and kept in memory only. It is not written to disk or logs. Do not use this page through a public tunnel.</p>

  <section id="chat" aria-live="polite"></section>
  <form id="form">
    <textarea id="message" rows="2" placeholder="Write a message, e.g. what is the status of account 42?"></textarea>
    <button id="send" type="submit">Send</button>
  </form>
  <div class="tools">
    <button id="new" type="button">New conversation</button>
  </div>
  <div class="error" id="error"></div>
</main>
<script>
  const chat = document.getElementById('chat');
  const errorBox = document.getElementById('error');
  const form = document.getElementById('form');
  const messageInput = document.getElementById('message');
  const sendButton = document.getElementById('send');
  const applyButton = document.getElementById('apply');
  const newButton = document.getElementById('new');
  const status = document.getElementById('status');
  const provider = document.getElementById('provider');
  const apiKey = document.getElementById('api-key');
  const model = document.getElementById('model');

  const state = { conversationId: crypto.randomUUID(), threadId: undefined, busy: false };

  function setError(message) {
    errorBox.textContent = message || '';
  }

  function render(messages) {
    chat.replaceChildren();
    for (const item of messages) {
      const bubble = document.createElement('div');
      bubble.className = 'bubble ' + item.role;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = item.role === 'user' ? 'You' : 'Fevex';
      const text = document.createElement('div');
      text.textContent = item.text;
      bubble.append(meta, text);
      if (Array.isArray(item.tools) && item.tools.length) {
        const tools = document.createElement('div');
        tools.className = 'tool-line';
        tools.textContent = 'MCP: ' + item.tools
          .map((tool) => tool.name + (tool.status === 'failed' ? ' (failed)' : ''))
          .join(', ');
        bubble.append(tools);
      }
      chat.append(bubble);
    }
    chat.scrollTop = chat.scrollHeight;
  }

  async function applyConfig() {
    setError('');
    applyButton.disabled = true;
    try {
      const response = await fetch('/api/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: provider.value,
          apiKey: apiKey.value,
          model: model.value.trim(),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not apply the model');
      status.textContent = data.model ? data.provider + ': ' + data.model : data.provider;
      apiKey.value = '';
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      applyButton.disabled = false;
    }
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (state.busy) return;
    const text = messageInput.value.trim();
    if (!text) return;
    state.busy = true;
    sendButton.disabled = true;
    setError('');
    const typing = document.createElement('div');
    typing.className = 'typing';
    typing.textContent = 'Fevex is thinking...';
    chat.append(typing);
    chat.scrollTop = chat.scrollHeight;
    try {
      const response = await fetch('/api/simulate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text,
          conversationId: state.conversationId,
          threadId: state.threadId,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'The simulated run failed');
      state.threadId = data.threadId;
      render(data.messages || []);
      messageInput.value = '';
    } catch (error) {
      typing.remove();
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      state.busy = false;
      sendButton.disabled = false;
      messageInput.focus();
    }
  }

  function newConversation() {
    state.conversationId = crypto.randomUUID();
    state.threadId = undefined;
    messageInput.value = '';
    setError('');
    render([]);
    messageInput.focus();
  }

  async function loadConfig() {
    try {
      const response = await fetch('/api/config');
      if (!response.ok) return;
      const data = await response.json();
      if (data.provider) status.textContent = data.provider;
    } catch {
      // The simulator still works with its startup provider.
    }
  }

  applyButton.addEventListener('click', applyConfig);
  form.addEventListener('submit', sendMessage);
  newButton.addEventListener('click', newConversation);
  messageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  loadConfig();
  messageInput.focus();
</script>
</body>
</html>`;
