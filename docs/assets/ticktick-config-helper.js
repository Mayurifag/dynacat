'use strict';

(function () {
    const storageKey = 'dynacat.ticktick.config-helper';
    const storageVersion = 1;
    const ticktickAuthorizeURL = 'https://ticktick.com/oauth/authorize';
    const ticktickTokenURL = 'https://ticktick.com/oauth/token';
    const ticktickProjectsURL = 'https://api.ticktick.com/open/v1/project';
    const ticktickTaskFilterURL = 'https://api.ticktick.com/open/v1/task/filter';

    function setupTickTickConfigHelpers(container) {
        container.querySelectorAll('[data-ticktick-config-helper]').forEach(helper => {
            if (helper.dataset.initialized) return;
            helper.dataset.initialized = 'true';
            helper.innerHTML = `
        <div class="ticktick-config-helper-card">
          <div class="ticktick-rail" aria-label="TickTick setup progress">
            <div class="ticktick-rail-item" data-ticktick-rail-step="1">Authorize</div>
            <div class="ticktick-rail-line"></div>
            <div class="ticktick-rail-item" data-ticktick-rail-step="2">Config</div>
          </div>

          <div class="ticktick-step" data-ticktick-step="1">
            <div class="ticktick-step-head">
              <span class="ticktick-step-number">1</span>
              <div>
                <div class="ticktick-step-title">Authorize TickTick</div>
              </div>
            </div>
            <div class="ticktick-setup-note">
              <div>Open the <a href="https://developer.ticktick.com/manage">Developer Center</a> and click New App. Enter any name, skip the other fields, then click Add.</div>
              <div>Click Edit and paste this OAuth redirect URL: <span class="ticktick-redirect-inline"><code data-ticktick-redirect-uri></code><button class="code-copy ticktick-inline-copy" data-ticktick-copy-redirect type="button">Copy</button></span></div>
              <div>Copy Client ID and Client Secret into this helper.</div>
              <div>Do not forget to click Save. After that click Authorize with TickTick.</div>
              <div>It will open new tab/popup, make sure its allowed in your browser.</div>
            </div>
            <div class="ticktick-helper-grid">
              <label>Client ID
                <input data-ticktick-client-id autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" data-keepassxc-ignore="true" data-1p-ignore="true" data-lpignore="true" data-form-type="other">
              </label>
              <label>Client Secret
                <input data-ticktick-client-secret autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" data-keepassxc-ignore="true" data-1p-ignore="true" data-lpignore="true" data-form-type="other">
              </label>
            </div>
            <div class="ticktick-helper-note">The helper exchanges the code directly with TickTick from your browser. Client secrets are not sent to Dynacat or the documentation site.</div>
            <div class="ticktick-config-helper-actions">
              <a class="ticktick-config-helper-button" data-ticktick-authorize href="#">Authorize with TickTick</a>
            </div>
            <div class="ticktick-config-helper-status" data-ticktick-status></div>
          </div>

          <div class="ticktick-step ticktick-helper-options" data-ticktick-step="2" hidden>
            <div class="ticktick-step-head">
              <span class="ticktick-step-number">2</span>
              <div>
                <div class="ticktick-step-title">Choose widget options</div>
                <div class="ticktick-step-copy">Today is a date filter. New tasks are saved to TickTick Inbox.</div>
              </div>
            </div>
            <div class="ticktick-helper-grid">
              <label>Tasks shown
                <select data-ticktick-task-source>
                  <option value="today:">Today</option>
                  <option value="open:">Open tasks / Inbox</option>
                </select>
              </label>
            </div>
            <div class="ticktick-project-status" data-ticktick-project-status></div>
            <div class="ticktick-output-head">
              <div class="ticktick-helper-label">Widget config</div>
              <div class="ticktick-output-actions">
                <button class="code-copy ticktick-back" data-ticktick-back type="button">Back</button>
                <button class="code-copy ticktick-copy" type="button" data-ticktick-copy>Copy</button>
              </div>
            </div>
            <pre><code data-ticktick-config></code></pre>
          </div>
        </div>
      `;

            const fields = {
                clientId: helper.querySelector('[data-ticktick-client-id]'),
                clientSecret: helper.querySelector('[data-ticktick-client-secret]'),
                redirectUri: helper.querySelector('[data-ticktick-redirect-uri]'),
                status: helper.querySelector('[data-ticktick-status]'),
                authorize: helper.querySelector('[data-ticktick-authorize]'),
                steps: [...helper.querySelectorAll('[data-ticktick-step]')],
                rails: [...helper.querySelectorAll('[data-ticktick-rail-step]')],
                backs: [...helper.querySelectorAll('[data-ticktick-back]')],
                options: helper.querySelector('[data-ticktick-step="2"]'),
                taskSource: helper.querySelector('[data-ticktick-task-source]'),
                projectStatus: helper.querySelector('[data-ticktick-project-status]'),
                config: helper.querySelector('[data-ticktick-config]'),
                copy: helper.querySelector('[data-ticktick-copy]'),
                copyRedirect: helper.querySelector('[data-ticktick-copy-redirect]'),
            };
            const state = {
                accessToken: '',
                projects: [],
                inboxProjectID: '',
                taskSource: 'today:',
                currentStep: 1,
                callbackCode: '',
                exchangeTimer: 0,
                exchangeKey: '',
                authorizedKey: '',
                exchanging: false,
                projectLoadFailed: false,
            };

            function defaultCallbackURL() {
                if (location.protocol === 'http:' || location.protocol === 'https:') {
                    const url = new URL(location.href);
                    url.search = '';
                    url.hash = '';
                    return url.toString();
                }
                return 'http://localhost:8081/';
            }

            function currentScope() {
                return 'tasks:read tasks:write';
            }

            function setStatus(message, type) {
                fields.status.textContent = message || '';
                fields.status.className = 'ticktick-config-helper-status' + (type ? ` ${type}` : '');
            }

            function setStep(step) {
                state.currentStep = Math.max(1, Math.min(2, step));
                fields.steps.forEach(element => {
                    element.hidden = Number(element.dataset.ticktickStep) !== state.currentStep;
                });
                fields.rails.forEach(element => {
                    const railStep = Number(element.dataset.ticktickRailStep);
                    element.classList.toggle('active', railStep === state.currentStep);
                    element.classList.toggle('complete', railStep < state.currentStep);
                });
                updateForm();
            }

            function setCodeText(element, value) {
                element.textContent = value || '';
            }

            function yamlValue(value) {
                if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
                return JSON.stringify(value);
            }

            function taskSource() {
                const [kind, projectID = ''] = (fields.taskSource.value || 'today:').split(':');
                return {
                    kind: kind === 'open' ? 'open' : 'today',
                    projectID,
                };
            }

            function buildConfig() {
                const token = state.accessToken || 'ACCESS_TOKEN_FROM_RESPONSE';
                const lines = [
                    '- type: ticktick',
                    '  title: TickTick',
                    `  access-token: ${yamlValue(token)} # Dont forget to move this to env.`,
                ];
                const source = taskSource();
                if (state.inboxProjectID) {
                    lines.push(`  add-project-id: ${yamlValue(state.inboxProjectID)}`);
                }
                if (source.kind === 'open') {
                    lines.push('  show: inbox');
                }
                setCodeText(fields.config, lines.join('\n'));
            }

            function authorizeKey() {
                return [
                    fields.clientId.value.trim(),
                    fields.clientSecret.value.trim(),
                    fields.redirectUri.textContent.trim(),
                    currentScope(),
                ].join('\n');
            }

            function hasCurrentAuthorization() {
                return state.accessToken && state.authorizedKey === authorizeKey();
            }

            function buildAuthorizeURL() {
                const clientId = fields.clientId.value.trim();
                const clientSecret = fields.clientSecret.value.trim();
                const redirectUri = fields.redirectUri.textContent.trim();
                if (!clientId || !clientSecret || !redirectUri) return '';
                const authorizeURL = new URL(ticktickAuthorizeURL);
                authorizeURL.searchParams.set('scope', currentScope());
                authorizeURL.searchParams.set('client_id', clientId);
                authorizeURL.searchParams.set('state', 'dynacat-ticktick');
                authorizeURL.searchParams.set('redirect_uri', redirectUri);
                authorizeURL.searchParams.set('response_type', 'code');
                return authorizeURL.toString();
            }

            function updateForm() {
                const authorizeURL = buildAuthorizeURL();
                const alreadyAuthorized = hasCurrentAuthorization();
                fields.authorize.textContent = alreadyAuthorized ? 'Continue to config' : 'Authorize with TickTick';
                fields.authorize.href = alreadyAuthorized ? '#' : authorizeURL || '#';
                fields.authorize.classList.toggle('disabled', !alreadyAuthorized && !authorizeURL);
                if (!fields.options.hidden) {
                    state.taskSource = fields.taskSource.value || 'today:';
                }
                updateProjectStatus();
                buildConfig();
            }

            function saveFields() {
                try {
                    sessionStorage.setItem(storageKey, JSON.stringify({
                        version: storageVersion,
                        clientId: fields.clientId.value.trim(),
                        clientSecret: fields.clientSecret.value.trim(),
                        taskSource: fields.options.hidden ? state.taskSource : fields.taskSource.value || 'today:',
                    }));
                } catch (_) { }
            }

            function restoreFields() {
                try {
                    const saved = JSON.parse(sessionStorage.getItem(storageKey) || '{}');
                    if (saved.version !== storageVersion) return;
                    if (saved.clientId) fields.clientId.value = saved.clientId;
                    if (saved.clientSecret) fields.clientSecret.value = saved.clientSecret;
                    if (saved.taskSource) state.taskSource = saved.taskSource;
                } catch (_) { }
            }

            function fillCallbackCode() {
                const params = new URLSearchParams(location.search);
                const code = params.get('code');
                const error = params.get('error');
                if (code) {
                    state.callbackCode = code;
                    setStatus('Code received. Finishing setup...', 'success');
                }
                if (error) {
                    setStatus(error, 'error');
                }
            }

            function clearCallbackParams() {
                const url = new URL(location.href);
                if (url.searchParams.get('state') !== 'dynacat-ticktick') return;
                url.searchParams.delete('code');
                url.searchParams.delete('state');
                url.searchParams.delete('scope');
                history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
            }

            function addSelectOption(select, value, label) {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = label;
                select.appendChild(option);
            }

            function renderTaskSources() {
                fields.taskSource.innerHTML = '';
                addSelectOption(fields.taskSource, 'today:', 'Today');
                addSelectOption(fields.taskSource, 'open:', 'Open tasks / Inbox');
                fields.taskSource.value = [...fields.taskSource.options].some(option => option.value === state.taskSource)
                    ? state.taskSource
                    : 'today:';
            }

            function updateProjectStatus() {
                if (fields.options.hidden) {
                    fields.projectStatus.textContent = '';
                    return;
                }
                if (state.projectLoadFailed) return;
                if (state.inboxProjectID) {
                    fields.projectStatus.textContent = 'New tasks are dated today and saved to TickTick Inbox.';
                    return;
                }
                fields.projectStatus.textContent = 'Inbox could not be detected from this browser. The config still works for reading tasks.';
            }

            function renderProjects() {
                renderTaskSources();
                updateForm();
            }

            function detectInboxProjectID(projects, tasks) {
                const inboxProject = projects.find(project => !project.closed && (!project.kind || project.kind === 'TASK') && /^inbox$/i.test(project.name || ''));
                if (inboxProject) return inboxProject.id;
                const inboxTask = tasks.find(task => /^inbox/i.test(task.projectId || ''));
                return inboxTask ? inboxTask.projectId : '';
            }

            async function fetchProjects(token) {
                fields.projectStatus.textContent = 'Loading projects...';
                try {
                    const projectResponse = await fetch(ticktickProjectsURL, {
                        headers: { 'Authorization': `Bearer ${token}` },
                    });
                    const projectText = await projectResponse.text();
                    if (!projectResponse.ok) throw new Error(projectText.trim() || 'Could not load projects');
                    const projects = JSON.parse(projectText);
                    const taskResponse = await fetch(ticktickTaskFilterURL, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ status: [0] }),
                    });
                    const taskText = await taskResponse.text();
                    if (!taskResponse.ok) throw new Error(taskText.trim() || 'Could not load tasks');
                    const tasks = JSON.parse(taskText);
                    state.projects = projects.filter(project => !project.closed && (!project.kind || project.kind === 'TASK'));
                    state.inboxProjectID = detectInboxProjectID(projects, tasks);
                    state.projectLoadFailed = false;
                    fields.projectStatus.textContent = '';
                } catch (_) {
                    state.projects = [];
                    state.inboxProjectID = '';
                    state.projectLoadFailed = true;
                    fields.projectStatus.textContent = 'Inbox could not be detected from this browser. The config still works for reading tasks.';
                }
                renderProjects();
            }

            async function exchangeCode() {
                state.exchanging = true;
                setStatus('Finishing setup with TickTick...', '');
                const form = new URLSearchParams();
                form.set('grant_type', 'authorization_code');
                form.set('code', state.callbackCode);
                form.set('scope', currentScope());
                form.set('redirect_uri', fields.redirectUri.textContent.trim());

                let response;
                try {
                    response = await fetch(ticktickTokenURL, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Basic ${btoa(`${fields.clientId.value.trim()}:${fields.clientSecret.value.trim()}`)}`,
                            'Content-Type': 'application/x-www-form-urlencoded',
                        },
                        body: form,
                    });
                } catch (_) {
                    throw new Error('TickTick blocked browser token exchange. No token or client secret was sent to Dynacat.');
                } finally {
                    state.exchanging = false;
                    updateForm();
                }
                const text = await response.text();
                if (!response.ok) throw new Error(text.trim() || 'Token exchange failed');
                const token = JSON.parse(text);
                state.accessToken = token.access_token || '';
                state.authorizedKey = authorizeKey();
                clearCallbackParams();
                setStatus('Token ready. Adjust options below, then copy the config.', 'success');
                await fetchProjects(state.accessToken);
                setStep(2);
                buildConfig();
            }

            function scheduleExchangeCode() {
                if (!state.callbackCode || state.accessToken || state.exchanging) return;
                const clientId = fields.clientId.value.trim();
                const clientSecret = fields.clientSecret.value.trim();
                const redirectUri = fields.redirectUri.textContent.trim();
                if (!clientId || !clientSecret || !redirectUri) {
                    setStatus('Code received. Add the same TickTick credentials to finish setup.', 'success');
                    return;
                }
                const exchangeKey = [clientId, clientSecret, redirectUri, state.callbackCode, currentScope()].join('\n');
                if (state.exchangeKey === exchangeKey) return;
                state.exchangeKey = exchangeKey;
                clearTimeout(state.exchangeTimer);
                state.exchangeTimer = setTimeout(() => {
                    exchangeCode().catch(error => setStatus(error.message, 'error'));
                }, 400);
            }

            function selectText(element) {
                const range = document.createRange();
                range.selectNodeContents(element);
                const selection = window.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
            }

            function copyText(value, button, selectTarget) {
                const original = button.textContent;
                const done = () => {
                    button.textContent = 'Copied';
                    setTimeout(() => { button.textContent = original; }, 1400);
                };
                const fallback = () => {
                    selectText(selectTarget);
                    document.execCommand('copy');
                    window.getSelection().removeAllRanges();
                    done();
                };
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(value).then(done, fallback);
                } else {
                    fallback();
                }
            }

            function copyConfig() {
                copyText(fields.config.textContent, fields.copy, fields.config);
            }

            setCodeText(fields.redirectUri, defaultCallbackURL());
            restoreFields();
            fillCallbackCode();
            setStep(state.currentStep);
            scheduleExchangeCode();

            [fields.clientId, fields.clientSecret].forEach(field => {
                field.addEventListener('input', () => {
                    saveFields();
                    updateForm();
                    scheduleExchangeCode();
                });
            });
            [fields.taskSource].forEach(field => {
                field.addEventListener('change', () => {
                    updateForm();
                    saveFields();
                    scheduleExchangeCode();
                });
            });
            fields.authorize.addEventListener('click', event => {
                event.preventDefault();
                if (hasCurrentAuthorization()) {
                    setStep(2);
                    return;
                }
                if (fields.authorize.classList.contains('disabled')) {
                    setStatus('Enter Client ID and Client Secret first.', 'error');
                    return;
                }
                saveFields();
                location.href = fields.authorize.href;
            });
            fields.redirectUri.addEventListener('click', () => selectText(fields.redirectUri));
            fields.copyRedirect.addEventListener('click', () => copyText(fields.redirectUri.textContent, fields.copyRedirect, fields.redirectUri));
            fields.backs.forEach(button => {
                button.addEventListener('click', () => setStep(Math.max(1, state.currentStep - 1)));
            });
            fields.copy.addEventListener('click', copyConfig);
        });
    }

    document.addEventListener('dynacat:doc-rendered', event => {
        setupTickTickConfigHelpers(event.detail.wrapper);
    });
}());
