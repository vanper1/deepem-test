(function () {
  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));

  let tasks = [];
  let templates = [];

  const safe = (v) => String(v ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const STATUS_LABELS = {
    planning: '规划中', awaiting_approval: '待批准', running: '执行中', paused: '已暂停',
    completed: '已完成', failed: '失败', cancelled: '已取消', created: '已创建', waiting_feedback: '等待反馈',
  };
  const statusLabel = (status) => STATUS_LABELS[String(status || '').toLowerCase()] || String(status || '未知');
  const statusClass = (status) => {
    const value = String(status || '').toLowerCase();
    if (['completed'].includes(value) || value.includes('无异常')) return 'ok';
    if (['failed', 'cancelled'].includes(value) || value.includes('中止')) return 'stop';
    return 'warn';
  };
  const formatTime = (value) => {
    if (!value) return '-';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
  };
  const templateTitle = (tpl) => tpl?.name || tpl?.file_name || tpl?.id || '未命名模板';
  const taskTitle = (task) => task?.title || task?.display_title || task?.instruction || task?.id || '未命名任务';

  function setupLogin() {
    const btn = $('#loginButton');
    if (!btn) return;
    btn.addEventListener('click', () => { window.location.href = '/home'; });
    $$('#loginForm input').forEach(input => {
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          window.location.href = '/home';
        }
      });
    });
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    let body = options.body;
    if (body && !(body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(body);
    }
    const resp = await fetch(path, { ...options, headers, body });
    const contentType = resp.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await resp.json().catch(() => ({})) : await resp.text();
    if (!resp.ok) throw new Error((payload && (payload.detail || payload.message)) || payload || `请求失败：${resp.status}`);
    return payload;
  }

  function ensureTemplatePreviewModal() {
    let modal = $('#sharedTemplatePreviewModal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'sharedTemplatePreviewModal';
    modal.className = 'shared-template-modal-backdrop hidden';
    modal.innerHTML = `
      <section class="shared-template-modal" role="dialog" aria-modal="true" aria-labelledby="sharedTemplatePreviewTitle">
        <div class="shared-template-modal-head">
          <div><h2 id="sharedTemplatePreviewTitle">模板文档内容</h2><p id="sharedTemplatePreviewMeta"></p></div>
          <button id="sharedTemplatePreviewClose" class="deem-btn ghost" type="button">关闭</button>
        </div>
        <pre id="sharedTemplatePreviewContent" class="shared-template-preview-content">正在读取模板文档……</pre>
      </section>`;
    document.body.appendChild(modal);
    const close = () => modal.classList.add('hidden');
    $('#sharedTemplatePreviewClose', modal).addEventListener('click', close);
    modal.addEventListener('click', event => { if (event.target === modal) close(); });
    return modal;
  }

  async function openTemplateDocument(templateId) {
    const modal = ensureTemplatePreviewModal();
    const title = $('#sharedTemplatePreviewTitle', modal);
    const meta = $('#sharedTemplatePreviewMeta', modal);
    const content = $('#sharedTemplatePreviewContent', modal);
    modal.classList.remove('hidden');
    title.textContent = '模板文档内容';
    meta.textContent = '';
    content.textContent = '正在读取模板文档……';
    try {
      const payload = await api(`/api/capture-agent/templates/${encodeURIComponent(templateId)}`);
      const item = payload.item || {};
      title.textContent = templateTitle(item);
      meta.textContent = `${item.file_name || '-'} · ${item.scene || '通用检测场景'} · ${item.operator || 'operator'} · ${formatTime(item.updated_at || item.created_at)}`;
      content.textContent = item.markdown || item.text || item.text_preview || '该模板暂无可预览的文本内容。';
    } catch (error) {
      content.textContent = `模板读取失败：${error.message || '网络错误'}`;
    }
  }

  function setupTaskList() {
    const table = $('#taskTableBody');
    const detail = $('#taskDetail');
    if (!table || !detail) return;
    let activeId = '';
    let batch = false;
    let rows = [];
    let detailToken = 0;

    function renderList() {
      const head = $('#taskTableHead');
      if (head) head.innerHTML = `${batch ? '<th>选择</th>' : ''}<th>任务时间</th><th>任务名称</th><th>任务地点</th><th>任务状态</th><th>操作员</th>`;
      if (!rows.length) {
        table.innerHTML = `<tr><td colspan="${batch ? 6 : 5}" class="deem-empty-cell">暂无真实任务数据，请点击“新建任务”创建。</td></tr>`;
        return;
      }
      table.innerHTML = rows.map(task => `
        <tr data-id="${safe(task.id)}" class="${task.id === activeId ? 'active' : ''}">
          ${batch ? `<td><input type="checkbox" class="task-check" data-id="${safe(task.id)}"></td>` : ''}
          <td>${safe(formatTime(task.created_at || task.updated_at))}</td>
          <td>${safe(taskTitle(task))}</td>
          <td>${safe(task.place || '-')}</td>
          <td><span class="status-pill ${statusClass(task.status)}">${safe(statusLabel(task.status))} · ${safe(task.progress ?? 0)}%</span></td>
          <td>${safe(task.operator || 'operator')}</td>
        </tr>`).join('');
    }

    async function renderDetail() {
      const summary = tasks.find(item => item.id === activeId) || rows[0];
      if (!summary) {
        detail.innerHTML = '<div class="deem-report-box">暂无任务详情。</div>';
        return;
      }
      activeId = summary.id;
      const token = ++detailToken;
      detail.innerHTML = '<div class="deem-report-box">正在读取真实任务详情……</div>';
      try {
        const payload = await api(`/api/capture-agent/tasks/${encodeURIComponent(summary.id)}`);
        if (token !== detailToken) return;
        const task = payload.item || summary;
        const node = (task.nodes || []).find(item => item.id === task.current_node_id) || (task.nodes || [])[0];
        const templateNames = (task.templates || []).map(templateTitle).filter(Boolean);
        detail.innerHTML = `
          <div class="deem-kv">
            <div><span>任务名称</span><strong>${safe(taskTitle(task))}</strong></div>
            <div><span>任务ID</span><strong>${safe(task.id)}</strong></div>
            <div><span>创建时间</span><strong>${safe(formatTime(task.created_at))}</strong></div>
            <div><span>任务地点</span><strong>${safe(task.place || '-')}</strong></div>
            <div><span>任务状态</span><strong>${safe(statusLabel(task.status))} · ${safe(task.progress ?? 0)}%</strong></div>
            <div><span>操作员</span><strong>${safe(task.operator || 'operator')}</strong></div>
          </div>
          <div class="deem-report-box">
            <strong>真实任务执行信息</strong><br>
            任务指令：${safe(task.instruction || '-')}<br>
            使用模板：${safe(templateNames.join('、') || '未使用模板')}<br>
            当前节点：${safe(node?.title || task.current_node_id || '-')}<br>
            当前摘要：${safe(node?.summary || task.error || '等待任务状态更新')}<br>
            最近更新：${safe(formatTime(task.updated_at))}
          </div>
          <div class="deem-form-actions"><a class="deem-btn primary" href="/capture-agent?task=${encodeURIComponent(task.id)}">进入采集智能体</a></div>`;
      } catch (error) {
        if (token === detailToken) detail.innerHTML = `<div class="deem-report-box">任务详情读取失败：${safe(error.message || '网络错误')}</div>`;
      }
    }

    function applyRows(nextRows) {
      rows = nextRows;
      if (!rows.some(item => item.id === activeId)) activeId = rows[0]?.id || '';
      renderList();
      renderDetail();
    }

    table.addEventListener('click', event => {
      if (event.target.matches('input')) return;
      const tr = event.target.closest('tr[data-id]');
      if (!tr) return;
      activeId = tr.dataset.id;
      renderList();
      renderDetail();
    });
    $('#taskSearchBtn')?.addEventListener('click', () => {
      const q = ($('#taskSearchInput')?.value || '').trim();
      applyRows(tasks.filter(t => !q || [t.id, taskTitle(t), t.place, statusLabel(t.status), t.operator].join(' ').includes(q)));
    });
    $('#taskSearchInput')?.addEventListener('keydown', event => { if (event.key === 'Enter') $('#taskSearchBtn')?.click(); });
    $('#taskFilterBtn')?.addEventListener('click', () => {
      const keyword = prompt('输入任务状态关键词，例如：规划、待批准、执行、完成、失败', '完成') || '';
      const q = keyword.trim();
      applyRows(tasks.filter(t => !q || statusLabel(t.status).includes(q) || taskTitle(t).includes(q) || String(t.place || '').includes(q)));
    });
    $('#taskBatchBtn')?.addEventListener('click', () => { batch = !batch; renderList(); });
    $('#taskDeleteBtn')?.addEventListener('click', async () => {
      const selected = $$('.task-check:checked').map(cb => cb.dataset.id);
      if (!batch || !selected.length) { alert('请先点击“批量操作”并勾选要删除的任务。'); return; }
      if (!confirm(`确认删除选中的 ${selected.length} 个真实任务吗？任务文件与产物将一并删除。`)) return;
      try {
        await Promise.all(selected.map(id => api(`/api/capture-agent/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' })));
        await loadTasks();
      } catch (error) {
        alert(`删除失败：${error.message || '网络错误'}`);
      }
    });

    async function loadTasks() {
      table.innerHTML = '<tr><td colspan="5" class="deem-empty-cell">正在读取真实任务数据……</td></tr>';
      detail.innerHTML = '<div class="deem-report-box">正在连接任务系统……</div>';
      try {
        const payload = await api('/api/capture-agent/tasks?limit=200');
        tasks = payload.items || [];
        activeId = tasks[0]?.id || '';
        applyRows(tasks.slice());
      } catch (error) {
        tasks = [];
        rows = [];
        renderList();
        detail.innerHTML = `<div class="deem-report-box">真实任务读取失败：${safe(error.message || '网络错误')}</div>`;
      }
    }
    loadTasks();
  }

  const DETECT_TASK_CONTEXT_KEY = 'deepem.detect.taskContext';
  const CAPTURE_PENDING_KEY = 'deepem.captureAgent.pendingFromDetect';

  function formatMhz(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return '-';
    const mhz = Math.abs(num) > 100000 ? num / 1000000 : num;
    return `${mhz.toLocaleString('zh-CN', { maximumFractionDigits: 6 })} MHz`;
  }

  function rangeText(range, unit = 'MHz') {
    if (!range || range.min === undefined || range.max === undefined) return '-';
    const min = unit === 'MHz' ? formatMhz(range.min) : `${safe(range.min)} ${unit}`;
    const max = unit === 'MHz' ? formatMhz(range.max) : `${safe(range.max)} ${unit}`;
    return `${min} ~ ${max}`;
  }

  function setupNewTask() {
    const templatePane = $('#templatePane');
    const commandPane = $('#commandPane');
    if (!templatePane && !commandPane) return;

    const pageState = { templates: [], tasks: [], selectedTemplateIds: new Set(), selectedTaskId: '' };
    const taskPicker = $('#existingTaskPicker');

    function renderTaskPicker() {
      if (!taskPicker) return;
      taskPicker.innerHTML = '<option value="">新建智能检测任务</option>' + pageState.tasks.map(task => `<option value="${safe(task.id)}">${safe(formatTime(task.created_at))} · ${safe(taskTitle(task))}</option>`).join('');
    }

    taskPicker?.addEventListener('change', () => {
      pageState.selectedTaskId = taskPicker.value;
      const task = pageState.tasks.find(item => item.id === pageState.selectedTaskId);
      if (task) {
        $('#taskName') && ($('#taskName').value = taskTitle(task));
        $('#taskPlace') && ($('#taskPlace').value = task.place || '');
        $('#taskOperator') && ($('#taskOperator').value = task.operator || 'operator');
        $('#selectedTaskInfo') && ($('#selectedTaskInfo').innerHTML = `<strong>已选择真实历史任务：</strong>${safe(taskTitle(task))}<br>状态：${safe(statusLabel(task.status))}；地点：${safe(task.place || '-')}。新执行会创建关联任务，不会覆盖历史记录。`);
      } else {
        $('#taskName') && ($('#taskName').value = '园区电磁环境智能检测');
        $('#taskPlace') && ($('#taskPlace').value = '中国科学院信息工程研究所园区');
        $('#taskOperator') && ($('#taskOperator').value = 'operator');
        $('#selectedTaskInfo') && ($('#selectedTaskInfo').textContent = '当前为新建任务。可直接选择模板或输入任务指令。');
      }
    });

    function renderTemplates() {
      if (!templatePane) return;
      if (!pageState.templates.length) {
        templatePane.innerHTML = '<div class="deem-list-item">暂无已上传模板，请上传 DOCX 或切换到任务指令模式。</div>';
        return;
      }
      templatePane.innerHTML = pageState.templates.map((tpl) => {
        const checked = pageState.selectedTemplateIds.has(tpl.id);
        return `<div class="deem-list-item detect-template-item ${checked ? 'active' : ''}" data-template-id="${safe(tpl.id)}">
          <label class="detect-template-select"><input type="checkbox" value="${safe(tpl.id)}" ${checked ? 'checked' : ''}><span><strong>${safe(templateTitle(tpl))}</strong><small>${safe(formatTime(tpl.updated_at || tpl.created_at))}</small><small>${safe((tpl.text_preview || '').slice(0, 110))}</small></span></label>
          <button class="deem-btn ghost detect-template-detail-btn" type="button" data-template-detail="${safe(tpl.id)}">查看详细</button>
        </div>`;
      }).join('');
      templatePane.querySelectorAll('input[type="checkbox"]').forEach(input => {
        input.addEventListener('change', () => {
          if (input.checked) pageState.selectedTemplateIds.add(input.value); else pageState.selectedTemplateIds.delete(input.value);
          renderTemplates();
        });
      });
      templatePane.querySelectorAll('[data-template-detail]').forEach(button => {
        button.addEventListener('click', () => openTemplateDocument(button.dataset.templateDetail));
      });
    }

    async function loadTemplates(defaultSelect = false) {
      if (templatePane) templatePane.innerHTML = '<div class="deem-list-item">正在读取共享真实模板库……</div>';
      try {
        const payload = await api('/api/capture-agent/templates');
        pageState.templates = payload.items || [];
        templates = pageState.templates.slice();
        if (defaultSelect && !pageState.selectedTemplateIds.size && pageState.templates[0]) pageState.selectedTemplateIds.add(pageState.templates[0].id);
        renderTemplates();
      } catch (error) {
        if (templatePane) templatePane.innerHTML = `<div class="deem-list-item">模板读取失败：${safe(error.message || '网络错误')}</div>`;
      }
    }

    async function loadTasks() {
      try {
        const payload = await api('/api/capture-agent/tasks?limit=200');
        pageState.tasks = payload.items || [];
        tasks = pageState.tasks.slice();
        renderTaskPicker();
      } catch (error) {
        pageState.tasks = [];
        renderTaskPicker();
        $('#selectedTaskInfo') && ($('#selectedTaskInfo').textContent = `历史任务读取失败：${error.message || '网络错误'}`);
      }
    }

    async function uploadTemplates(files) {
      if (!files || !files.length) return;
      const invalid = Array.from(files).find(file => !file.name.toLowerCase().endsWith('.docx'));
      if (invalid) { alert('仅支持上传 DOCX 模板。'); return; }
      const form = new FormData();
      Array.from(files).forEach(file => form.append('files', file));
      const status = $('#templateUploadStatus');
      if (status) status.textContent = `正在上传 ${files.length} 个模板……`;
      try {
        const payload = await api('/api/capture-agent/templates', { method: 'POST', body: form });
        (payload.items || []).forEach(item => pageState.selectedTemplateIds.add(item.id));
        if (status) status.textContent = `已上传：${(payload.items || []).map(item => item.file_name).join('、')}`;
        await loadTemplates(false);
      } catch (error) {
        if (status) status.textContent = `上传失败：${error.message || '网络错误'}`;
      } finally {
        const upload = $('#captureTemplateUpload');
        if (upload) upload.value = '';
      }
    }

    function updateMode() {
      const mode = $('input[name="taskMode"]:checked')?.value || 'template';
      if (templatePane) templatePane.style.display = 'grid';
      if (commandPane) commandPane.style.display = mode === 'command' ? 'block' : 'none';
    }
    $$('input[name="taskMode"]').forEach(input => input.addEventListener('change', updateMode));
    $('#refreshTemplateBtn')?.addEventListener('click', () => loadTemplates(false));
    $('#captureTemplateUpload')?.addEventListener('change', event => uploadTemplates(event.target.files));
    $('#createTaskBtn')?.addEventListener('click', () => {
      const mode = $('input[name="taskMode"]:checked')?.value || 'template';
      const selectedTemplates = pageState.templates.filter(tpl => pageState.selectedTemplateIds.has(tpl.id));
      const rawInstruction = ($('#taskInstruction')?.value || '').trim();
      if (mode === 'template' && !selectedTemplates.length) { alert('请先选择或上传一个模板，或切换到任务指令模式。'); return; }
      if (mode === 'command' && !rawInstruction) { alert('请输入任务指令。'); return; }
      const name = ($('#taskName')?.value || '新建智能检测任务').trim();
      const place = ($('#taskPlace')?.value || '').trim();
      const operator = ($('#taskOperator')?.value || '').trim();
      const instruction = rawInstruction || `根据选定模板执行“${name}”，地点：${place}。请结合后续设备状态、设备能力与参数范围，生成 MHz 参数下的采集计划。`;
      const context = {
        selected_task_id: pageState.selectedTaskId,
        name, place, operator, mode, instruction,
        template_ids: selectedTemplates.map(tpl => tpl.id),
        template_names: selectedTemplates.map(templateTitle),
        created_at: new Date().toISOString(),
      };
      localStorage.setItem(DETECT_TASK_CONTEXT_KEY, JSON.stringify(context));
      window.location.href = `/detect/verify?name=${encodeURIComponent(name)}`;
    });
    Promise.all([loadTemplates(true), loadTasks()]);
    updateMode();
  }

  function setupVerify() {
    const title = $('#verifyTaskName');
    if (!title) return;
    const params = new URLSearchParams(location.search);
    const stored = localStorage.getItem(DETECT_TASK_CONTEXT_KEY);
    let taskContext;
    try { taskContext = stored ? JSON.parse(stored) : {}; } catch (_) { taskContext = {}; }
    taskContext = taskContext || {};
    const name = params.get('name') || taskContext.name || '新建任务';
    title.textContent = '调用设备平台接口';

    const summaryEl = $('#deviceStatusSummary');
    const listEl = $('#deviceListPane');
    const paramEl = $('#deviceParamPane');
    const startBtn = $('#startDetectBtn');
    const readyTitle = $('#deviceReadyTitle');
    const readyText = $('#deviceReadyText');
    let usrpDevices = [];
    let probeDevices = [];
    let selectedUsrpIndexes = new Set();
    let selectedProbeIndexes = new Set();
    let devicesPayload = null;
    let probesPayload = null;
    let paramsPayload = null;
    let usrpError = '';
    let probeError = '';

    function renderParams(paramsData) {
      if (!paramEl) return;
      if (!paramsData || !Object.keys(paramsData).length) {
        paramEl.textContent = '尚未读取到当前 USRP 参数。';
        return;
      }
      paramEl.innerHTML = `<strong>当前 USRP 平台参数（MHz）：</strong><br>
        设备：${safe(paramsData.dev_id || '-')}；中心频率：${formatMhz(paramsData.freq)}；采样率：${formatMhz(paramsData.sample_rate)}；带宽：${formatMhz(paramsData.bandwidth)}；增益：${safe(paramsData.gain ?? '-')} dB；天线：${safe(paramsData.antenna || '-')}`;
    }

    function selectedUsrps() {
      return usrpDevices.filter((_, index) => selectedUsrpIndexes.has(index));
    }

    function selectedProbes() {
      return probeDevices.filter((_, index) => selectedProbeIndexes.has(index));
    }

    function updateReadyState() {
      const usrps = selectedUsrps();
      const probes = selectedProbes();
      if (startBtn) startBtn.disabled = usrps.length === 0;
      if (readyTitle) readyTitle.textContent = usrps.length ? '执行设备已就绪' : '请至少选择一台 USRP';
      if (readyText) {
        if (!usrps.length) {
          readyText.textContent = '现有主采集流程需要至少一台 USRP。WiFi/蓝牙探针可作为辅助证据设备按需勾选。';
        } else if (probes.length) {
          readyText.textContent = `已选择 ${usrps.length} 台 USRP、${probes.length} 台 WiFi/蓝牙探针。`;
        } else {
          readyText.textContent = `已选择 ${usrps.length} 台 USRP，未选择 WiFi/蓝牙探针。任务将按现有 USRP 流程执行。`;
        }
      }
      if (summaryEl) {
        const notes = [];
        notes.push(`检测到 USRP ${usrpDevices.length} 台、WiFi/蓝牙探针 ${probeDevices.length} 台；当前勾选 USRP ${usrps.length} 台、探针 ${probes.length} 台。`);
        if (usrpError) notes.push(`USRP 接口提示：${usrpError}`);
        if (probeError) notes.push(`探针接口提示：${probeError}`);
        summaryEl.textContent = notes.join(' ');
      }
    }

    function renderDeviceGroups() {
      if (!listEl) return;
      const usrpHtml = usrpDevices.length ? usrpDevices.map((device, index) => {
        const cfg = device.dev_config || {};
        const status = String(device.status || 'UNKNOWN').toUpperCase();
        const checked = selectedUsrpIndexes.has(index);
        return `<label class="detect-device-card ${checked ? 'active' : ''}" data-device-kind="usrp" data-index="${index}">
          <input type="checkbox" name="selectedUsrpDevice" data-index="${index}" ${checked ? 'checked' : ''}>
          <div class="detect-device-head"><strong>${safe(device.dev_id || '未命名 USRP')}</strong><span>${safe(status)}</span></div>
          <div class="detect-device-meta">类型：USRP；IP：${safe(device.dev_ip || '-')}；任务：${safe(device.task_id || '-')}；更新时间：${safe(device.updated_at || '-')}</div>
          <div class="detect-device-range"><b>频率范围</b>${rangeText(cfg.freq_range)}</div>
          <div class="detect-device-range"><b>采样率范围</b>${rangeText(cfg.sample_rate_range)}</div>
          <div class="detect-device-range"><b>带宽范围</b>${rangeText(cfg.bandwidth_range)}</div>
          <div class="detect-device-range"><b>增益范围</b>${rangeText(cfg.gain_range, 'dB')}</div>
          ${Array.isArray(cfg.rx_antennas) ? `<div class="detect-device-range"><b>天线</b>${safe(cfg.rx_antennas.join('、'))}</div>` : ''}
        </label>`;
      }).join('') : `<div class="deem-report-box compact">未检测到 USRP。${usrpError ? `错误：${safe(usrpError)}` : ''}</div>`;

      const probeHtml = probeDevices.length ? probeDevices.map((device, index) => {
        const status = String(device.status || 'UNKNOWN').toUpperCase();
        const checked = selectedProbeIndexes.has(index);
        return `<label class="detect-device-card detect-probe-card ${checked ? 'active' : ''}" data-device-kind="probe" data-index="${index}">
          <input type="checkbox" name="selectedProbeDevice" data-index="${index}" ${checked ? 'checked' : ''}>
          <div class="detect-device-head"><strong>${safe(device.probe_id || device.device_ip || '未命名探针')}</strong><span>${safe(status)}</span></div>
          <div class="detect-device-meta">类型：WiFi/蓝牙探针；IP：${safe(device.device_ip || '-')}；最近接收：${safe(formatTime(device.last_received_at))}</div>
          <div class="detect-device-range"><b>连接次数</b>${safe(device.connection_count ?? '-')}</div>
          <div class="detect-device-range"><b>完整报文</b>${safe(device.received_message_count ?? '-')}</div>
          <div class="detect-device-range"><b>成功解析</b>${safe(device.parsed_message_count ?? '-')}</div>
          <div class="detect-device-range"><b>更新时间</b>${safe(formatTime(device.updated_at))}</div>
        </label>`;
      }).join('') : `<div class="deem-report-box compact">未检测到 WiFi/蓝牙探针。${probeError ? `错误：${safe(probeError)}` : ''}</div>`;

      listEl.innerHTML = `<section class="detect-device-group">
          <div class="detect-device-group-title"><h3>USRP 主采集设备</h3><span>${usrpDevices.length} 台，默认全选</span></div>
          <div class="detect-device-group-grid">${usrpHtml}</div>
        </section>
        <section class="detect-device-group">
          <div class="detect-device-group-title"><h3>WiFi/蓝牙探针辅助设备</h3><span>${probeDevices.length} 台，默认全选，可取消</span></div>
          <div class="detect-device-group-grid">${probeHtml}</div>
        </section>`;

      listEl.querySelectorAll('input[name="selectedUsrpDevice"]').forEach(input => {
        input.addEventListener('change', () => {
          const index = Number(input.dataset.index);
          if (input.checked) selectedUsrpIndexes.add(index); else selectedUsrpIndexes.delete(index);
          input.closest('.detect-device-card')?.classList.toggle('active', input.checked);
          updateReadyState();
        });
      });
      listEl.querySelectorAll('input[name="selectedProbeDevice"]').forEach(input => {
        input.addEventListener('change', () => {
          const index = Number(input.dataset.index);
          if (input.checked) selectedProbeIndexes.add(index); else selectedProbeIndexes.delete(index);
          input.closest('.detect-device-card')?.classList.toggle('active', input.checked);
          updateReadyState();
        });
      });
      updateReadyState();
    }

    async function loadDevicePlatform() {
      if (summaryEl) summaryEl.textContent = '正在同时检测 USRP 与 WiFi/蓝牙探针……';
      try {
        const [scanResult, probeResult, paramsResult] = await Promise.all([
          api('/api/devices/scan', { method: 'POST' }).catch(async error => {
            const statusResult = await api('/api/devices/status').catch(() => ({ devices: [] }));
            return { ...statusResult, scan_error: error.message };
          }),
          api('/api/probes/devices').catch(error => ({ items: [], probe_error: error.message })),
          api('/api/devices/params').catch(() => ({})),
        ]);
        devicesPayload = scanResult;
        probesPayload = probeResult;
        paramsPayload = paramsResult;
        usrpDevices = Array.isArray(scanResult.devices) ? scanResult.devices : [];
        probeDevices = Array.isArray(probeResult.items) ? probeResult.items : [];
        usrpError = scanResult.scan_error || scanResult.error || '';
        probeError = probeResult.probe_error || '';
        selectedUsrpIndexes = new Set(usrpDevices.map((_, index) => index));
        selectedProbeIndexes = new Set(probeDevices.map((_, index) => index));
        renderParams(paramsResult);
        renderDeviceGroups();
      } catch (error) {
        if (summaryEl) summaryEl.textContent = `调用设备平台接口失败：${error.message || '网络错误'}`;
        if (listEl) listEl.innerHTML = '<div class="deem-report-box compact">无法读取设备状态与能力，请检查后端设备接口。</div>';
      }
    }

    startBtn?.addEventListener('click', async () => {
      const chosenUsrps = selectedUsrps();
      const chosenProbes = selectedProbes();
      if (!chosenUsrps.length) { alert('请至少选择一台 USRP 主采集设备。'); return; }
      const primaryUsrp = chosenUsrps[0];
      const reasoningMode = $('input[name="reasoningMode"]:checked')?.value || 'deep';
      const originalText = startBtn.textContent;
      startBtn.disabled = true;
      startBtn.textContent = '正在创建真实任务……';

      const selectedUsrpBriefs = chosenUsrps.map(device => {
        const cfg = device.dev_config || {};
        return {
          dev_id: device.dev_id,
          status: device.status,
          dev_ip: device.dev_ip,
          capability_mhz: {
            freq_range: cfg.freq_range || null,
            sample_rate_range: cfg.sample_rate_range || null,
            bandwidth_range: cfg.bandwidth_range || null,
            gain_range: cfg.gain_range || null,
            rx_antennas: cfg.rx_antennas || null,
          },
          current_config_mhz: device.current_config || {},
          platform_params_mhz: paramsPayload || {},
        };
      });
      const selectedProbeBriefs = chosenProbes.map(device => ({
        probe_id: device.probe_id,
        device_ip: device.device_ip,
        status: device.status,
        last_received_at: device.last_received_at,
        connection_count: device.connection_count,
        received_message_count: device.received_message_count,
        parsed_message_count: device.parsed_message_count,
        updated_at: device.updated_at,
      }));

      try {
        await api('/api/devices/params', { method: 'POST', body: { dev_id: primaryUsrp.dev_id } });
      } catch (_) { /* 任务创建仍由后端规划器和设备校验继续处理 */ }
      const templateLine = (taskContext.template_names || []).length ? `已选择模板：${taskContext.template_names.join('、')}。` : '未选择模板。';
      const probeLine = selectedProbeBriefs.length
        ? `已选择 WiFi/蓝牙探针 ${selectedProbeBriefs.map(item => item.probe_id || item.device_ip).join('、')}。USRP 流程完成后，先询问用户确认，再依次调用探针设备、目标汇总、观测时段三个接口获取辅助证据。`
        : '未选择 WiFi/蓝牙探针，本次仅执行现有 USRP 采集流程。';
      const instruction = [
        `智能检测任务：${name}`,
        taskContext.place ? `任务地点：${taskContext.place}` : '',
        taskContext.operator ? `操作员：${taskContext.operator}` : '',
        templateLine,
        `用户任务指令：${taskContext.instruction || '根据任务模板完成园区电磁环境智能检测。'}`,
        `采集智能体模式：${reasoningMode === 'fast' ? '快速模式（非思考）' : '深度思考模式'}。`,
        '设备平台接口已返回当前设备状态、能力与参数范围；请全部按 MHz 理解与生成采集参数。',
        `已选择 USRP 设备与能力数据：${JSON.stringify(selectedUsrpBriefs, null, 2)}`,
        probeLine,
        `已选择探针状态数据：${JSON.stringify(selectedProbeBriefs, null, 2)}`,
        '请在不改变现有 USRP 流程的前提下生成采集计划，等待用户确认计划后执行；探针流程作为 USRP 成功结果之后的可选辅助证据流程，失败不得覆盖 USRP 完成状态。',
      ].filter(Boolean).join('\n');
      try {
        const created = await api('/api/capture-agent/tasks', {
          method: 'POST',
          body: {
            instruction,
            template_ids: taskContext.template_ids || [],
            title: name,
            place: taskContext.place || '',
            operator: taskContext.operator || 'operator',
            source: 'detect_flow',
            parent_task_id: taskContext.selected_task_id || '',
            reasoning_mode: reasoningMode,
            selected_usrp_devices: selectedUsrpBriefs,
            selected_probe_devices: selectedProbeBriefs,
          },
        });
        const taskId = created.item?.id;
        if (!taskId) throw new Error('任务创建接口未返回任务 ID');
        localStorage.setItem(CAPTURE_PENDING_KEY, JSON.stringify({
          source: 'detect_flow', task_id: taskId, task_name: name,
          template_ids: taskContext.template_ids || [], instruction,
          reasoning_mode: reasoningMode,
          selected_usrp_devices: selectedUsrpBriefs,
          selected_probe_devices: selectedProbeBriefs,
          devices_payload: devicesPayload, probes_payload: probesPayload,
          created_at: new Date().toISOString(),
        }));
        localStorage.removeItem(DETECT_TASK_CONTEXT_KEY);
        window.location.href = `/capture-agent?from=detect&task=${encodeURIComponent(taskId)}`;
      } catch (error) {
        alert(`真实任务创建失败：${error.message || '网络错误'}`);
        startBtn.disabled = false;
        startBtn.textContent = originalText;
      }
    });

    loadDevicePlatform();
  }

  function setupTemplates() {
    const table = $('#templateTableBody');
    const detail = $('#templateDetail');
    if (!table || !detail) return;
    let activeId = '';
    let rows = [];
    let batch = false;
    let detailToken = 0;
    const batchBtn = $('#templateBatchBtn');

    function renderTable() {
      const head = $('#templateTableHead');
      if (head) head.innerHTML = `${batch ? '<th>选择</th>' : ''}<th>创建时间</th><th>模板名称</th><th>适用场景</th><th>操作员</th><th>操作</th>`;
      if (!rows.length) {
        table.innerHTML = `<tr><td colspan="${batch ? 6 : 5}" class="deem-empty-cell">共享模板库暂无数据，请点击“新建模板”上传 DOCX。</td></tr>`;
        return;
      }
      table.innerHTML = rows.map(tpl => `<tr data-id="${safe(tpl.id)}" class="${tpl.id === activeId ? 'active' : ''}">
        ${batch ? `<td><input class="template-check" type="checkbox" data-id="${safe(tpl.id)}"></td>` : ''}
        <td>${safe(formatTime(tpl.created_at))}</td><td>${safe(templateTitle(tpl))}</td><td>${safe(tpl.scene || '通用检测场景')}</td><td>${safe(tpl.operator || 'operator')}</td>
        <td><button class="deem-btn ghost table-action-btn" type="button" data-template-view="${safe(tpl.id)}">查看详细</button></td>
      </tr>`).join('');
    }

    async function renderDetail() {
      const summary = templates.find(t => t.id === activeId) || rows[0];
      if (!summary) { detail.innerHTML = '<div class="deem-report-box">暂无模板详情。</div>'; return; }
      activeId = summary.id;
      const token = ++detailToken;
      detail.innerHTML = '<div class="deem-report-box">正在读取真实模板文档……</div>';
      try {
        const payload = await api(`/api/capture-agent/templates/${encodeURIComponent(summary.id)}`);
        if (token !== detailToken) return;
        const tpl = payload.item || summary;
        detail.innerHTML = `<div class="deem-kv">
          <div><span>模板名称</span><strong>${safe(templateTitle(tpl))}</strong></div><div><span>操作员</span><strong>${safe(tpl.operator || 'operator')}</strong></div>
          <div><span>适用场景</span><strong>${safe(tpl.scene || '通用检测场景')}</strong></div><div><span>创建时间</span><strong>${safe(formatTime(tpl.created_at))}</strong></div>
          <div><span>文件名称</span><strong>${safe(tpl.file_name || '-')}</strong></div><div><span>文件大小</span><strong>${safe(tpl.size_bytes || 0)} B</strong></div>
        </div>
        <div class="deem-report-box deem-template-preview"><strong>检测模板内容阅览区</strong><br>${safe((tpl.markdown || tpl.text || tpl.text_preview || '暂无内容').slice(0, 1800))}</div>
        <div class="deem-form-actions">
          <button class="deem-btn primary" type="button" data-detail-view="${safe(tpl.id)}">查看完整文档</button>
          <button class="deem-btn ghost" type="button" data-detail-rename="${safe(tpl.id)}">重命名</button>
          <button class="deem-btn danger" type="button" data-detail-delete="${safe(tpl.id)}">删除模板</button>
        </div>`;
      } catch (error) {
        if (token === detailToken) detail.innerHTML = `<div class="deem-report-box">模板详情读取失败：${safe(error.message || '网络错误')}</div>`;
      }
    }

    async function loadTemplates() {
      table.innerHTML = '<tr><td colspan="5" class="deem-empty-cell">正在读取共享真实模板库……</td></tr>';
      try {
        const payload = await api('/api/capture-agent/templates');
        templates = payload.items || [];
        rows = templates.slice();
        activeId = rows[0]?.id || '';
        renderTable();
        renderDetail();
      } catch (error) {
        templates = []; rows = [];
        renderTable();
        detail.innerHTML = `<div class="deem-report-box">模板读取失败：${safe(error.message || '网络错误')}</div>`;
      }
    }

    async function renameTemplate(id) {
      const tpl = templates.find(item => item.id === id);
      const name = prompt('请输入新的模板名称', templateTitle(tpl));
      if (!name?.trim()) return;
      await api(`/api/capture-agent/templates/${encodeURIComponent(id)}/rename`, { method: 'PUT', body: { name: name.trim() } });
      await loadTemplates();
      activeId = id;
      renderTable();
      renderDetail();
    }

    async function deleteTemplates(ids) {
      if (!ids.length) return;
      if (!confirm(`确认删除 ${ids.length} 个真实模板吗？原始 DOCX 文件也会删除。`)) return;
      await Promise.all(ids.map(id => api(`/api/capture-agent/templates/${encodeURIComponent(id)}`, { method: 'DELETE' })));
      await loadTemplates();
    }

    table.addEventListener('click', event => {
      if (event.target.matches('input')) return;
      const view = event.target.closest('[data-template-view]');
      const tr = event.target.closest('tr[data-id]');
      const id = view?.dataset.templateView || tr?.dataset.id;
      if (!id) return;
      activeId = id;
      renderTable();
      renderDetail();
      if (view) openTemplateDocument(id);
    });
    detail.addEventListener('click', event => {
      const view = event.target.closest('[data-detail-view]');
      const rename = event.target.closest('[data-detail-rename]');
      const del = event.target.closest('[data-detail-delete]');
      if (view) openTemplateDocument(view.dataset.detailView);
      if (rename) renameTemplate(rename.dataset.detailRename).catch(error => alert(`重命名失败：${error.message}`));
      if (del) deleteTemplates([del.dataset.detailDelete]).catch(error => alert(`删除失败：${error.message}`));
    });
    $('#templateSearchBtn')?.addEventListener('click', () => {
      const q = ($('#templateSearchInput')?.value || '').trim();
      rows = templates.filter(t => !q || [templateTitle(t), t.scene, t.operator, t.file_name].join(' ').includes(q));
      if (!rows.some(t => t.id === activeId)) activeId = rows[0]?.id || '';
      renderTable(); renderDetail();
    });
    $('#templateSearchInput')?.addEventListener('keydown', event => { if (event.key === 'Enter') $('#templateSearchBtn')?.click(); });
    $('#templateFilterBtn')?.addEventListener('click', () => {
      const q = (prompt('输入场景关键词，例如：会议室、机房、办公区', '机房') || '').trim();
      rows = templates.filter(t => !q || String(t.scene || '').includes(q) || templateTitle(t).includes(q));
      if (!rows.some(t => t.id === activeId)) activeId = rows[0]?.id || '';
      renderTable(); renderDetail();
    });
    batchBtn?.addEventListener('click', async () => {
      if (!batch) {
        batch = true;
        batchBtn.textContent = '删除选中';
        renderTable();
        return;
      }
      const selected = $$('.template-check:checked').map(input => input.dataset.id);
      if (!selected.length) {
        batch = false;
        batchBtn.textContent = '批量操作';
        renderTable();
        return;
      }
      try {
        await deleteTemplates(selected);
        batch = false;
        batchBtn.textContent = '批量操作';
      } catch (error) { alert(`批量删除失败：${error.message || '网络错误'}`); }
    });
    loadTemplates();
  }

  function setupCreateTemplate() {
    const button = $('#createTemplateBtn');
    const fileInput = $('#templateDocxFile');
    if (!button || !fileInput) return;
    const preview = $('#templateFilePreview');
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (preview) preview.textContent = file ? `已选择：${file.name}（${Math.ceil(file.size / 1024)} KB）` : '请选择一个 DOCX 模板文件。';
    });
    button.addEventListener('click', async () => {
      const file = fileInput.files?.[0];
      if (!file) { alert('请选择 DOCX 模板文件。'); return; }
      if (!file.name.toLowerCase().endsWith('.docx')) { alert('仅支持 DOCX 模板文件。'); return; }
      const original = button.textContent;
      button.disabled = true;
      button.textContent = '正在保存真实模板……';
      const form = new FormData();
      form.append('files', file);
      form.append('name', ($('#newTemplateName')?.value || '').trim());
      form.append('scene', ($('#newTemplateScene')?.value || '').trim());
      form.append('operator', ($('#newTemplateOperator')?.value || 'operator').trim());
      try {
        await api('/api/capture-agent/templates', { method: 'POST', body: form });
        window.location.href = '/templates';
      } catch (error) {
        alert(`模板保存失败：${error.message || '网络错误'}`);
        button.disabled = false;
        button.textContent = original;
      }
    });
  }

  function setupDevicePage() {
    if (!$('#devicePage')) return;

    async function api(path, options = {}) {
      const headers = new Headers(options.headers || {});
      if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
      const resp = await fetch(path, { ...options, headers });
      const contentType = resp.headers.get('content-type') || '';
      const payload = contentType.includes('application/json') ? await resp.json().catch(() => ({})) : await resp.text();
      if (!resp.ok) throw new Error((payload && payload.detail) || (payload && payload.message) || payload || `请求失败：${resp.status}`);
      return payload;
    }

    $('#scanDeviceBtn')?.addEventListener('click', async () => {
      const resultEl = $('#deviceScanResult');
      if (resultEl) resultEl.textContent = '正在扫描真实设备...';
      try {
        const result = await api('/api/devices/scan', { method: 'POST' });
        const devices = result.devices || [];
        if (!devices.length) {
          if (resultEl) resultEl.textContent = '未发现设备。';
          return;
        }
        if (resultEl) resultEl.textContent = `已扫描到 ${devices.length} 台设备：` + devices.map(d => `${safe(d.dev_id || '-')} ${safe(d.status || 'UNKNOWN')}`).join('、');
      } catch (error) {
        if (resultEl) resultEl.textContent = '真实扫描失败，保留模拟展示：已扫描到 3 台 USRP：USRP-01 在线、USRP-02 空闲、USRP-03 离线。' + (error.message ? `（${error.message}）` : '');
      }
    });
    $('#configDeviceBtn')?.addEventListener('click', async () => {
      const resultEl = $('#deviceActionResult');
      try {
        await api('/api/devices/params', { method: 'POST', body: JSON.stringify({}) });
        if (resultEl) resultEl.textContent = '参数已下发到后端配置接口。';
      } catch (error) {
        if (resultEl) resultEl.textContent = '参数下发失败，已保留前端配置展示。' + (error.message ? `（${error.message}）` : '');
      }
    });
    $('#startCaptureBtn')?.addEventListener('click', async () => {
      const resultEl = $('#deviceActionResult');
      try {
        await api('/api/control/start', { method: 'POST', body: '{}' });
        if (resultEl) resultEl.textContent = '采集已启动。';
      } catch (error) {
        if (resultEl) resultEl.textContent = '采集启动失败：' + (error.message || '网络错误');
      }
    });
    $('#stopDeviceBtn')?.addEventListener('click', async () => {
      const resultEl = $('#deviceActionResult');
      try {
        await api('/api/control/stop', { method: 'POST', body: '{}' });
        if (resultEl) resultEl.textContent = '采集已停止。';
      } catch (error) {
        if (resultEl) resultEl.textContent = '停止失败：' + (error.message || '网络错误');
      }
    });
  }

  function setupAlgorithmPage() {
    if (!$('#algoTree')) return;
    $('#algoTree').addEventListener('click', e => {
      const li = e.target.closest('li[data-name]');
      if (!li) return;
      $$('#algoTree li').forEach(node => node.classList.remove('active'));
      li.classList.add('active');
      $('#algoDetail').innerHTML = `<div class="deem-kv"><div><span>类别/算法</span><strong>${safe(li.dataset.name)}</strong></div><div><span>状态</span><strong>可用</strong></div><div><span>适用场景</span><strong>智能电磁检测</strong></div><div><span>操作员</span><strong>operator</strong></div></div><div class="deem-report-box">展示选定类别或算法的详细信息。当前为前端模拟逻辑，后续可接入算法管理后端接口。</div>`;
    });
    $('#newCategoryBtn')?.addEventListener('click', () => {
      const name = prompt('请输入新类别名称', '新增算法类别');
      if (name) alert(`已模拟新增类别：${name}`);
    });
  }

  function setupGenericForms() {
    $('#createAlgorithmBtn')?.addEventListener('click', () => { alert('算法已模拟新增。'); window.location.href = '/algorithms'; });
  }

  document.addEventListener('DOMContentLoaded', () => {
    setupLogin();
    setupTaskList();
    setupNewTask();
    setupVerify();
    setupTemplates();
    setupCreateTemplate();
    setupDevicePage();
    setupAlgorithmPage();
    setupGenericForms();
  });
})();
