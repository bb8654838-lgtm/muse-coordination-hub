/* Responsive presentation regression; isolated fixtures, never production data. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const Module = require('node:module');
const { spawn } = require('node:child_process');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const root = path.resolve(__dirname, '..');
const web = path.join(root, 'apps/web');
const artifacts = path.join(__dirname, 'stage-b-fixtures', 'responsive-regression');
fs.mkdirSync(artifacts, { recursive: true });
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request.startsWith('@/')) request = path.join(web, request.slice(2));
  return originalResolve.call(this, request, ...args);
};
const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === 'next/link') return { __esModule: true, default: ({ href, children, ...props }) => React.createElement('a', { href: typeof href === 'string' ? href : '#', ...props }, children) };
  return originalLoad.call(this, request, ...args);
};
for (const extension of ['.tsx', '.ts']) Module._extensions[extension] = (module, filename) => {
  // Next transforms styled JSX; plain tsc fixture rendering omits its non-DOM marker.
  const source = fs.readFileSync(filename, 'utf8').replace(/<style jsx(?=[\s>])/g, '<style');
  module._compile(ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText, filename);
};
const { CommandCenterShell } = require(path.join(web, 'components/dashboard/command-center-shell.tsx'));
const { OverviewView } = require(path.join(web, 'components/dashboard/overview-view.tsx'));
const { FleetView } = require(path.join(web, 'components/dashboard/fleet-view.tsx'));
const { CommsView } = require(path.join(web, 'components/dashboard/comms-view.tsx'));
const { PipelineView } = require(path.join(web, 'components/dashboard/pipeline-view.tsx'));
const { VaultView } = require(path.join(web, 'components/dashboard/vault-view.tsx'));
const { Modal } = require(path.join(web, 'components/dashboard/modal.tsx'));
const { AgentConfigurationPanel } = require(path.join(web, 'components/admin/agent-configuration-panel.tsx'));
const noop = () => {};
const h = React.createElement;
const stamp = '2026-01-01T12:00:00.000Z';
const workspaceId = '11111111-1111-4111-8111-111111111111';
function dataFor(mode) {
  const text = value => mode === 'stress' ? value.repeat(16) : value;
  const agents = mode === 'empty' ? [] : Array.from({ length: 6 }, (_, i) => ({
    id: `22222222-2222-4222-8222-22222222222${i}`, workspace_id: workspaceId,
    display_name: text(`WorkspaceAgent${i}`), role: text('SecurityEngineeringRole'),
    status: 'active', last_seen_at: stamp, created_at: stamp, revoked_at: null,
  }));
  const tasks = agents.map((agent, i) => ({ id: `task-${i}`, workspace_id: workspaceId,
    title: text('UnbrokenTaskIdentifier'), detail: text('DiagnosticDetail'),
    status: ['PENDING', 'IN_PROGRESS', 'BLOCKED', 'ESCALATED', 'DONE', 'PENDING'][i],
    assigned_to: agent.id, created_by: 'fixture', created_at: stamp, updated_at: stamp,
    blocked_reason: i === 2 ? text('UnbrokenBlockerDiagnostic') : null,
    result_summary: text('UnbrokenResultSummary'),
  }));
  const channels = [{ id: 'channel-fixture', workspace_id: workspaceId,
    name: text('general'), channel_type: 'group', member_agent_ids: [], created_at: stamp }];
  const messages = agents.length ? [{ id: 'message-fixture', workspace_id: workspaceId,
    channel_id: channels[0].id, sender_type: 'agent', sender_id: agents[0].id,
    message_type: 'NOTE', body: text('UnbrokenDiagnosticIdentifier'), created_at: stamp,
    mention_agent_ids: [], reply_to: null }] : [];
  const files = agents.map((agent, i) => ({ id: `file-${i}`, workspace_id: workspaceId,
    name: text('UnbrokenArtifactIdentifier') + '.log', mime_type: 'application/octet-stream',
    size_bytes: 32000, uploaded_by: agent.id, uploaded_by_type: 'agent', created_at: stamp,
    task_id: tasks[i].id, state: 'READY', storage_path: 'fixture/not-real',
  }));
  return { agents, tasks, channels, messages, files, workspaceName: text('WorkspaceIdentifier') };
}
function shell(view, data) {
  const common = { agents: data.agents, tasks: data.tasks, files: data.files };
  const views = {
    overview: h(OverviewView, { ...common, messages: data.messages, transfers: [], queuedCount: 0,
      realtimeState: 'live', selectedAgentId: null, onSelectAgent: noop, onPreview: noop }),
    fleet: h(FleetView, { agents: data.agents, agentLimit: 10, now: Date.parse(stamp), busy: '', onInvite: noop, onRevoke: noop, onOpenDm: noop }),
    comms: h(CommsView, { agents: data.agents, channels: data.channels, selectedChannelId: data.channels[0].id,
      selectedMessages: data.messages, messageBody: '', messageType: 'NOTE', mentionIds: data.agents.slice(0, 2).map(a => a.id),
      messageEndRef: { current: null }, busy: '', onSelectChannel: noop, onOpenDm: noop,
      onMessageBodyChange: noop, onMessageTypeChange: noop, onAddMention: noop, onRemoveMention: noop, onSendMessage: noop }),
    pipeline: h(PipelineView, { ...common, workspaceId, onNewTask: noop }),
    vault: h(VaultView, { files: data.files, agents: data.agents, workspaceId }),
  };
  return h(CommandCenterShell, { activeView: view, onViewChange: noop, workspaceName: data.workspaceName,
    userEmail: 'fixture@example.test', agentCount: data.agents.length, agentLimit: 10,
    onlineCount: data.agents.length, pendingCount: 3, activeTaskCount: 1,
    latestHeartbeat: '12:00:00 UTC', realtimeState: 'live', queuedTransfers: 0,
    notice: data.workspaceName, onDismissNotice: noop, onInvite: noop, onAccount: noop, views });
}
function admin(data, editor) {
  return h('main', { className: 'admin-shell' },
    h('header', { className: 'admin-header' }, h('div', null,
      h('span', { className: 'admin-eyebrow' }, 'Workspace configuration'), h('h1', null, 'Roles & Skills'),
      h('p', null, data.workspaceName + ' · Owner-managed desired state')),
      h('a', { className: 'admin-button', href: '#' }, 'Back to Fleet')),
    h(AgentConfigurationPanel, { workspaceId, agents: data.agents, agentLimit: 10,
      initialAgentId: editor ? data.agents[0]?.id : undefined, setupRequired: false }));
}
let css;
async function buildResponsiveCss() {
  if (process.env.UI_RESPONSIVE_CSS_FILE) {
    const external = path.resolve(process.env.UI_RESPONSIVE_CSS_FILE);
    assert.equal(external, path.join(artifacts, 'deployed-styles.css'), 'Only the verified deployment CSS artifact is accepted.');
    return fs.readFileSync(external, 'utf8');
  }
  // Use current application styles and the production PostCSS plugin, even on a clean checkout.
  const postcss = require('postcss');
  const tailwind = require('@tailwindcss/postcss');
  const globalFile = path.join(web, 'app/globals.css');
  const adminFile = path.join(web, 'app/admin/admin.css');
  const globalStyles = await postcss([tailwind({ base: web, optimize: false })]).process(fs.readFileSync(globalFile, 'utf8'), { from: globalFile });
  const adminStyles = await postcss([]).process(fs.readFileSync(adminFile, 'utf8'), { from: adminFile });
  const result = globalStyles.css + '\n' + adminStyles.css;
  fs.writeFileSync(path.join(artifacts, 'styles.css'), result);
  return result;
}
const pages = new Map();
const modes = ['normal', 'stress', 'empty'];
const views = ['overview', 'fleet', 'comms', 'pipeline', 'vault'];
for (const mode of modes) {
  const data = dataFor(mode);
  for (const view of views) pages.set(`/${view}-${mode}`, renderToStaticMarkup(shell(view, data)));
  for (const editor of [false, true]) pages.set(`/admin-${editor ? 'editor' : 'list'}-${mode}`, renderToStaticMarkup(admin(data, editor)));
  for (const owner of [false, true]) pages.set(`/modal-${owner ? 'owner' : 'shared'}-${mode}`,
    renderToStaticMarkup(h(Modal, { title: data.workspaceName,
      ...(owner ? { description: data.workspaceName } : { subtitle: data.workspaceName }), onClose: noop },
      h('form', { className: 'space-y-4' }, h('label', { className: 'field-label' }, data.workspaceName,
        h('input', { className: 'form-input', defaultValue: data.workspaceName })),
        h('div', { style: { height: '1100px' } }, 'Deliberately tall test content'),
        h('pre', null, 'boundedJSON'.repeat(100)), h('button', { className: 'primary-button', type: 'button' }, 'Primary action')))));
}
const geometryExpression = `(() => {
  const root = document.documentElement;
  const visible = selector => { const el = document.querySelector(selector); return !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0; };
  const rect = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  const dialog = document.querySelector('[role="dialog"]');
  const offenders = [...document.body.querySelectorAll('*')].filter(el => {
    if (!el.getClientRects().length || el.closest('pre,code,.sentinel-stage')) return false;
    const r = el.getBoundingClientRect(); return r.width && (r.left < -1 || r.right > root.clientWidth + 1);
  }).slice(0, 8).map(el => ({ tag: el.tagName, class: el.className, ...rect(el) }));
  const content = document.querySelector('.command-content');
  return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, innerWidth, innerHeight, rootOverflowX: getComputedStyle(root).overflowX, bodyOverflowX: getComputedStyle(document.body).overflowX,
    mobileNav: visible('.mobile-command-bar'), desktopRail: visible('.command-rail'),
    dialog: dialog ? rect(dialog) : null,
    modalBody: dialog ? (() => { const el = dialog.querySelector('.modal-body') || dialog.lastElementChild; return { ...rect(el), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, overflowY: getComputedStyle(el).overflowY }; })() : null,
    content: content ? { ...rect(content), paddingLeft: getComputedStyle(content).paddingLeft, paddingRight: getComputedStyle(content).paddingRight } : null, offenders };
})()`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
class CDP {
  constructor(ws) { this.ws = ws; this.sequence = 0; this.pending = new Map(); ws.addEventListener('message', event => {
    const message = JSON.parse(String(event.data)); const waiting = this.pending.get(message.id);
    if (waiting) { this.pending.delete(message.id); message.error ? waiting.reject(new Error(JSON.stringify(message.error))) : waiting.resolve(message.result); }
  }); }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true });
  }); return new CDP(ws); }
  call(method, params = {}) { const id = ++this.sequence; return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 20000);
    this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    this.ws.send(JSON.stringify({ id, method, params }));
  }); }
  async evaluate(expression) { const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ' ' + result.exceptionDetails.exception?.description);
    return result.result.value;
  }
}
async function buildModalFixture() {
  const sourceFile = path.join(artifacts, 'modal-source.cjs');
  const entryFile = path.join(artifacts, 'modal-entry.cjs');
  fs.writeFileSync(sourceFile, ts.transpileModule(fs.readFileSync(path.join(web, 'components/dashboard/modal.tsx'), 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText);
  fs.writeFileSync(entryFile, `
const React = require('react');
const { createRoot } = require('react-dom/client');
const { Modal } = require('./modal-source.cjs');
const h = React.createElement;
function Fixture() {
  const [open, setOpen] = React.useState(false);
  return h('div', null,
    h('button', { id: 'fixture-opener', onClick: () => setOpen(true) }, 'Open dialog'),
    h('input', { id: 'fixture-outside', 'aria-label': 'Outside dialog' }),
    open ? h(Modal, { title: 'DialogIdentifier'.repeat(24), description: 'DescriptionIdentifier'.repeat(24), onClose: () => setOpen(false) },
      h('input', { type: 'hidden', defaultValue: 'fixture' }),
      h('fieldset', { disabled: true }, h('input', { defaultValue: 'Disabled field' })),
      h('input', { id: 'fixture-first-input', className: 'form-input', 'aria-label': 'First editable field' }),
      h('button', { style: { display: 'none' } }, 'Hidden action'),
      ...Array.from({ length: 24 }, (_, i) => h('p', { key: i, className: 'py-3' }, 'UnbrokenBodyIdentifier'.repeat(24))),
      h('pre', null, h('code', null, JSON.stringify({ identifier: 'X'.repeat(2400) }, null, 2))),
      h('button', { id: 'fixture-last-action', className: 'primary-button', type: 'button' }, 'Primary action')) : null);
}
createRoot(document.getElementById('fixture-root')).render(h(Fixture));
`);
  const webpack = require('next/dist/compiled/webpack/webpack').webpack;
  await new Promise((resolve, reject) => {
    const compiler = webpack({ mode: 'production', target: 'web', entry: entryFile,
      output: { path: artifacts, filename: 'modal-client.js' },
      optimization: { minimize: false }, devtool: false, resolve: { modules: [path.join(root, 'node_modules'), 'node_modules'] },
    });
    compiler.run((error, stats) => compiler.close(closeError => {
      if (error || closeError) return reject(error || closeError);
      if (stats.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })));
      resolve();
    }));
  });
  return fs.readFileSync(path.join(artifacts, 'modal-client.js'), 'utf8');
}
async function checkModalInteraction(page, origin, width, height) {
  await page.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 1024 });
  await page.call('Page.navigate', { url: origin + '/modal-interaction' });
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await page.evaluate('Boolean(document.getElementById("fixture-opener"))')) break;
    await delay(50);
  }
  assert.ok(await page.evaluate('Boolean(document.getElementById("fixture-opener"))'), 'Modal fixture must hydrate.');
  const previous = await page.evaluate('({body: document.body.style.overflow, root: document.documentElement.style.overflow})');
  const settle = () => page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const press = async (key, shift = false) => {
    const virtualCode = key === 'Tab' ? 9 : 27;
    const params = { key, code: key, windowsVirtualKeyCode: virtualCode, nativeVirtualKeyCode: virtualCode, modifiers: shift ? 8 : 0 };
    await page.call('Input.dispatchKeyEvent', { ...params, type: 'rawKeyDown' });
    await page.call('Input.dispatchKeyEvent', { ...params, type: 'keyUp' });
    await settle();
  };
  const open = async () => {
    await page.evaluate('(() => { const el = document.getElementById("fixture-opener"); el.focus(); el.click(); })()');
    await settle();
    assert.equal(await page.evaluate('document.activeElement.id'), 'fixture-first-input', `Initial visible-field focus at ${width}x${height}`);
  };
  await open();
  const metric = await page.evaluate(geometryExpression);
  assert.ok(metric.scrollWidth <= metric.clientWidth + 1, 'Hydrated dialog must not overflow horizontally.');
  assert.ok(metric.dialog.left >= 15 && metric.dialog.right <= width - 15 && metric.dialog.top >= 15 && metric.dialog.bottom <= height - 15, 'Hydrated dialog must retain viewport gutters.');
  assert.ok(metric.modalBody.scrollWidth <= metric.modalBody.clientWidth + 1, 'Only code blocks may scroll horizontally.');
  assert.ok(await page.evaluate('(() => { const el = document.querySelector(".modal-body pre"); return el.scrollWidth > el.clientWidth && getComputedStyle(el).overflowX === "auto"; })()'), 'Structured data keeps its own horizontal scroller.');
  await page.evaluate('document.getElementById("fixture-last-action").focus()');
  await settle();
  assert.ok(await page.evaluate('(() => { const b = document.querySelector(".modal-body").getBoundingClientRect(); const a = document.getElementById("fixture-last-action").getBoundingClientRect(); return a.top >= b.top - 1 && a.bottom <= b.bottom + 1 && a.left >= b.left - 1 && a.right <= b.right + 1; })()'), 'The primary action is reachable within the dialog scroll region.');
  await press('Tab');
  assert.ok(await page.evaluate('document.activeElement.matches(".modal-header button")'), 'Tab wraps to the first visible control.');
  await press('Tab', true);
  assert.equal(await page.evaluate('document.activeElement.id'), 'fixture-last-action', 'Shift+Tab wraps to the last visible control.');
  await press('Escape');
  assert.equal(await page.evaluate('Boolean(document.querySelector("[role=dialog]"))'), false, 'Escape dismisses the dialog.');
  assert.equal(await page.evaluate('document.activeElement.id'), 'fixture-opener', 'Closing restores opener focus.');
  assert.deepEqual(await page.evaluate('({body: document.body.style.overflow, root: document.documentElement.style.overflow})'), previous, 'Closing restores page scrolling.');
  await open();
  await page.evaluate('document.querySelector(".modal-header button").click()');
  await settle();
  assert.equal(await page.evaluate('Boolean(document.querySelector("[role=dialog]"))'), false, 'Close button dismisses a reopened dialog.');
  assert.equal(await page.evaluate('document.activeElement.id'), 'fixture-opener', 'Repeated opens retain focus restoration.');
  assert.deepEqual(await page.evaluate('window.__fixtureErrors'), [], 'Hydrated fixture must have no browser errors.');
  return { width, height, initialFocus: true, tabLoop: true, escape: true, closeButton: true, focusRestored: true, scrollRestored: true };
}

async function main() {
  css = await buildResponsiveCss();
  const modalBundle = await buildModalFixture();
  const server = http.createServer((request, response) => {
    if (request.url === '/modal-client.js') { response.setHeader('Content-Type', 'application/javascript'); response.end(modalBundle); return; }
    if (request.url === '/modal-interaction') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><link rel="stylesheet" href="/styles.css"></head><body><script>window.__fixtureErrors=[];window.addEventListener("error",e=>window.__fixtureErrors.push(e.message));window.addEventListener("unhandledrejection",e=>window.__fixtureErrors.push(String(e.reason)));</script><div id="fixture-root"></div><script defer src="/modal-client.js"></script></body></html>'); return; }
    if (request.url === '/styles.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); return; }
    const body = pages.get(request.url);
    if (!body) { response.writeHead(404); response.end('Fixture not found'); return; }
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><link rel="stylesheet" href="/styles.css"></head><body>${body}</body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const chromeOptions = [process.env.CHROME_BIN];
  const cache = path.join(os.homedir(), '.cache/ms-playwright');
  if (fs.existsSync(cache)) for (const dir of fs.readdirSync(cache).filter(name => name.startsWith('chromium-'))) {
    chromeOptions.push(path.join(cache, dir, 'chrome-linux/chrome'), path.join(cache, dir, 'chrome-linux64/chrome'));
  }
  const chromePath = chromeOptions.find(value => value && fs.existsSync(value));
  assert.ok(chromePath, 'Set CHROME_BIN to a Chromium browser.');
  const profile = fs.mkdtempSync(path.join(artifacts, 'chromium-'));
  const chrome = spawn(chromePath, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking',
    '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', fs.openSync(path.join(artifacts, 'chromium.log'), 'a')] });
  let browser, page;
  const measurements = [], failures = [];
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let attempt = 0; !fs.existsSync(portFile) && attempt < 100; attempt++) await delay(100);
    assert.ok(fs.existsSync(portFile), 'Chromium did not start.');
    const [port, browserPath] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
    browser = await CDP.connect(`ws://127.0.0.1:${port}${browserPath}`);
    const { targetId } = await browser.call('Target.createTarget', { url: 'about:blank' });
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    page = await CDP.connect(targets.find(target => target.id === targetId).webSocketDebuggerUrl);
    await page.call('Page.enable');
    const frameId = (await page.call('Page.getFrameTree')).frameTree.frame.id;
    const sizes = [[390, 844], [430, 932], [1280, 800], [1440, 900], [1023, 800], [1024, 800], [1920, 1080], [390, 400]];
    for (const [width, height] of sizes) {
      await page.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 1024 });
      for (const fixture of pages.keys()) {
        const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${css}</style></head><body>${pages.get(fixture)}</body></html>`;
        await page.call('Page.setDocumentContent', { frameId, html }).catch(error => { throw new Error(`${fixture} @ ${width}x${height}: ${error.message}`); });
        await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        const metric = await page.evaluate(geometryExpression);
        measurements.push({ fixture, width, height, ...metric });
        const prefix = `${fixture} @ ${width}x${height}`;
        if (metric.innerWidth > width + 1) failures.push(`${prefix}: mobile layout viewport expanded ${metric.innerWidth}/${width}`);
        if (!fixture.modal && [metric.rootOverflowX, metric.bodyOverflowX].some(value => value === 'hidden' || value === 'clip')) failures.push(`${prefix}: document-level overflow masking`);
        if (metric.scrollWidth > metric.clientWidth + 1) failures.push(`${prefix}: page overflow ${metric.scrollWidth}/${metric.clientWidth}; ${JSON.stringify(metric.offenders)}`);
        if (views.some(view => fixture.startsWith('/' + view + '-'))) {
          if (metric.mobileNav !== (width < 1024)) failures.push(`${prefix}: mobile nav visibility ${metric.mobileNav}`);
          if (Math.abs(parseFloat(metric.content.paddingLeft) - parseFloat(metric.content.paddingRight)) > 0.5) failures.push(`${prefix}: asymmetric content gutters`);
          if (metric.desktopRail !== (width >= 1024)) failures.push(`${prefix}: desktop rail visibility ${metric.desktopRail}`);
        }
        if (metric.dialog) {
          const r = metric.dialog;
          if (r.left < 0 || r.right > width + 1 || r.top < 0 || r.bottom > height + 1) failures.push(`${prefix}: unbounded dialog ${JSON.stringify(r)}`);
          const b = metric.modalBody;
          if (b.scrollWidth > b.clientWidth + 1) failures.push(`${prefix}: modal body horizontal overflow ${b.scrollWidth}/${b.clientWidth}`);
          if (!['auto', 'scroll'].includes(b.overflowY) || b.bottom > height + 1) failures.push(`${prefix}: body is not bounded/scrolled ${JSON.stringify(b)}`);
          const reached = await page.evaluate(`(() => { const el = document.querySelector('.modal-body') || document.querySelector('[role="dialog"]').lastElementChild; el.scrollTop = el.scrollHeight; return el.scrollTop + el.clientHeight >= el.scrollHeight - 1; })()`);
          if (!reached) failures.push(`${prefix}: modal primary action is unreachable`);
        }
      }
    }
    const interactions = [];
    for (const [width, height] of sizes) {
      try { interactions.push(await checkModalInteraction(page, `http://127.0.0.1:${server.address().port}`, width, height)); }
      catch (error) { failures.push(`Modal interaction @ ${width}x${height}: ${error.message}`); }
    }
    fs.writeFileSync(path.join(artifacts, 'measurements.json'), JSON.stringify({ measurements, interactions, failures }, null, 2));
    console.log(`Hydrated modal interaction: ${interactions.length}/${sizes.length} viewport checks.`);
    console.log(`Responsive geometry: ${measurements.length} fixture/viewport checks, ${failures.length} failures.`);
    for (const failure of failures.slice(0, 16)) console.error(failure);
    assert.equal(failures.length, 0, 'Responsive layout assertions failed; complete measurements are in tests/stage-b-fixtures/responsive-regression/measurements.json');
  } finally {
    page?.ws.close(); browser?.ws.close(); chrome.kill('SIGTERM');
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
