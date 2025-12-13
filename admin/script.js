const API_BASE = "https://gm.xyrj.dpdns.org";

// 全局变量定义 (分页相关)
let cachedAccounts = []; // 当前页的账号列表
let currentAccountPage = 1;
let currentAccountTotalPages = 1;
let accountSearchTimer = null;

let cachedTasks = []; // 当前页的任务列表
let currentTaskPage = 1;
let currentTaskTotalPages = 1;
let taskSearchTimer = null;

let currentInboxPage = 1;
let currentInboxTotalPages = 1;
let inboxSearchTimer = null;
let currentInboxAccountId = null;
let currentEmailLimit = 0; 
let currentFetchMode = 'API'; 

let lastMouseX = 0, lastMouseY = 0;

// 工具函数
function formatChinaTime(ts) {
    if (!ts) return '-';
    return new Date(ts).toLocaleString('zh-CN', { 
        timeZone: 'Asia/Shanghai', 
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
}

function toLocalISOString(date) {
    const pad = (n) => n < 10 ? '0' + n : n;
    return date.getFullYear() + '-' +
        pad(date.getMonth() + 1) + '-' +
        pad(date.getDate()) + 'T' +
        pad(date.getHours()) + ':' +
        pad(date.getMinutes());
}

function escapeHtml(text) {
    if (!text) return text;
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

document.addEventListener('mousemove', (e) => {
    lastMouseX = e.pageX;
    lastMouseY = e.pageY;
});
document.addEventListener('click', (e) => {
    lastMouseX = e.pageX;
    lastMouseY = e.pageY;
});

function showToast(msg) {
    const el = document.getElementById('mouse-toast');
    el.innerText = msg;
    el.style.left = lastMouseX + 10 + 'px';
    el.style.top = lastMouseY + 10 + 'px';
    el.style.display = 'block';
    requestAnimationFrame(() => el.style.opacity = 1);
    setTimeout(() => {
        el.style.opacity = 0;
        setTimeout(() => el.style.display = 'none', 300);
    }, 2000);
}

function copyText(text) {
    if (!text || text === 'null' || text === '-') return;
    navigator.clipboard.writeText(text)
        .then(() => showToast("已复制！"))
        .catch(() => showToast("复制失败"));
}

function getHeaders() {
    return {
        'Authorization': 'Basic ' + localStorage.getItem("auth_token"),
        'Content-Type': 'application/json'
    };
}

function doLogin() {
    const u = $("#admin-user").val();
    const p = $("#admin-pass").val();
    const token = btoa(u + ":" + p);
    localStorage.setItem("auth_token", token);
    
    fetch(API_BASE, { headers: { 'Authorization': 'Basic ' + token } })
        .then(res => {
            if(res.ok) {
                $("#login-overlay").fadeOut();
                loadAccounts();
                loadAllAccountNames(); // 预加载发件人列表
            } else {
                showToast("账号或密码错误");
            }
        }).catch(()=> showToast("连接失败"));
}

function doLogout() {
    localStorage.removeItem("auth_token");
    location.reload();
}

// 页面切换逻辑
function showSection(id) {
    $(".content-section").removeClass("active");
    $("#" + id).addClass("active");
    $(".list-group-item").removeClass("active");
    $(event.currentTarget).addClass("active");
    
    if(id === 'section-accounts') {
        loadAccounts(currentAccountPage);
    }
    if(id === 'section-send') {
        // 确保下拉列表有数据
        if ($("#account-list-options option").length === 0) {
            loadAllAccountNames();
        }
        loadTasks(currentTaskPage);
    }
    if(id === 'section-receive') {
        loadInboxAccounts(currentInboxPage);
    }
}

// ================== 邮箱管理 (分页 & 后端搜索) ==================

function loadAccounts(page = 1) {
    const searchQuery = $("#section-accounts input[placeholder*='搜索']").val().trim();
    currentAccountPage = page;
    
    $("#account-list-body").html('<tr><td colspan="8" class="text-center py-4"><div class="spinner-border text-primary spinner-border-sm"></div> 加载中...</td></tr>');

    return fetch(`${API_BASE}/api/accounts?page=${page}&limit=50&q=${encodeURIComponent(searchQuery)}`, { headers: getHeaders() })
        .then(r => r.json())
        .then(res => {
            const list = res.data || [];
            cachedAccounts = list; 
            currentAccountTotalPages = res.total_pages || 1;
            
            renderAccounts(list);
            
            // 更新分页 UI
            $("#acc-page-info").text(`第 ${res.page} / ${res.total_pages} 页 (共 ${res.total} 条)`);
            $("#btn-prev-acc").prop("disabled", res.page <= 1);
            $("#btn-next-acc").prop("disabled", res.page >= res.total_pages);
        });
}

function renderAccounts(data) {
    let html = '';
    data.forEach(acc => {
        const statusSwitch = `
        <div class="form-check form-switch">
            <input class="form-check-input" type="checkbox" ${acc.status ? 'checked' : ''} onchange="toggleAccountStatus(${acc.id}, this.checked)">
        </div>`;
        
        let apiDisplay = '-';
        if (acc.client_id) {
            apiDisplay = `ID:${acc.client_id}, Secret:${acc.client_secret ? '******' : '-'}, Token:${acc.refresh_token}`;
        } else if (acc.type.includes('API') && !acc.client_id) {
                apiDisplay = `<span class="text-muted">无配置或旧数据</span>`;
        }
        
        let gasDisplay = '-';
        if (acc.script_url && acc.script_url.startsWith('http')) {
            gasDisplay = `<span class="gas-url-cell cursor-pointer" onclick="copyText('${acc.script_url}')" title="${acc.script_url}">${acc.script_url}</span>`;
        }

        let badgeClass = 'bg-secondary';
        if (acc.type === 'API') badgeClass = 'bg-success';
        else if (acc.type === 'GAS') badgeClass = 'bg-primary';
        else if (acc.type === 'API/GAS') badgeClass = 'bg-info text-dark';

        html += `<tr>
            <td><input type="checkbox" class="acc-check" value="${acc.id}"></td>
            <td class="cursor-pointer fw-bold" onclick="copyText('${acc.name}')">${acc.name}</td>
            <td class="cursor-pointer" onclick="copyText('${acc.alias}')">${acc.alias || '-'}</td>
            <td class="cursor-pointer" onclick="copyText('${acc.client_id},${acc.client_secret},${acc.refresh_token}')" title="点击复制">
                <div class="api-config-cell">${apiDisplay}</div>
            </td>
            <td>${gasDisplay}</td>
            <td><span class="badge ${badgeClass}">${acc.type}</span></td>
            <td>${statusSwitch}</td>
            <td>
                <button class="btn btn-sm btn-light text-primary py-0" onclick="openEditModal(${acc.id})"><i class="fas fa-edit"></i></button> 
                <button class="btn btn-sm btn-light text-danger py-0" onclick="delAccount(${acc.id})"><i class="fas fa-trash"></i></button>
            </td>
        </tr>`;
    });
    if(data.length === 0) html = '<tr><td colspan="8" class="text-center text-muted">无数据</td></tr>';
    $("#account-list-body").html(html);
}

// 后端搜索防抖
function filterAccounts(text) {
    if (accountSearchTimer) clearTimeout(accountSearchTimer);
    accountSearchTimer = setTimeout(() => {
        loadAccounts(1);
    }, 300);
}

function changeAccountPage(delta) {
    const newPage = currentAccountPage + delta;
    if (newPage > 0 && newPage <= currentAccountTotalPages) {
        loadAccounts(newPage);
    }
}

// 加载所有账号名称 (用于发件下拉列表)
function loadAllAccountNames() {
    fetch(`${API_BASE}/api/accounts?type=simple`, { headers: getHeaders() })
        .then(r => r.json())
        .then(data => {
            let optionsHtml = '';
            window.accountNameMap = {}; // 建立映射
            data.forEach(acc => {
                optionsHtml += `<option value="${acc.name}">别名: ${acc.alias || '-'}</option>`;
                window.accountNameMap[acc.name] = acc.id;
            });
            $("#account-list-options").html(optionsHtml);
        });
}

// 导出全量数据
function exportAccounts() {
        const btn = $(event.target).closest('button');
        const orgHtml = btn.html();
        btn.html('<i class="fas fa-spinner fa-spin"></i> 导出中...');
        
        fetch(`${API_BASE}/api/accounts?type=export`, { headers: getHeaders() })
            .then(r => r.json())
            .then(data => {
                const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(data, null, 2));
                const downloadAnchorNode = document.createElement('a');
                downloadAnchorNode.setAttribute("href", dataStr);
                downloadAnchorNode.setAttribute("download", "accounts_backup_full.json");
                document.body.appendChild(downloadAnchorNode);
                downloadAnchorNode.click();
                downloadAnchorNode.remove();
                btn.html(orgHtml);
            }).catch(() => {
                showToast("导出失败");
                btn.html(orgHtml);
            });
}

function toggleAccountStatus(id, isActive) {
    const acc = cachedAccounts.find(a => a.id === id);
    if (!acc) return;
    // 乐观更新
    const originalStatus = acc.status;
    acc.status = isActive ? 1 : 0;
    
    fetch(API_BASE + '/api/accounts', { method: 'PUT', headers: getHeaders(), body: JSON.stringify(acc) })
        .then(r => r.json()).then(res => {
            if(res.ok) { showToast(isActive ? "邮箱已启用" : "邮箱已禁用"); }
            else { 
                showToast("更新失败"); 
                acc.status = originalStatus; // 回滚
                loadAccounts(currentAccountPage); 
            }
        });
}

function openAddModal() {
    $("#accModalTitle").text("添加邮箱");
    $("#acc-id").val(""); 
    $("#acc-name").val("");
    $("#acc-alias").val("");
    $("#acc-api-config").val(""); 
    $("#acc-gas-url").val("");
    $("#acc-status").prop("checked", true);
    new bootstrap.Modal(document.getElementById('addAccountModal')).show();
}

function openEditModal(id) {
    const acc = cachedAccounts.find(a => a.id === id);
    if(!acc) return;
    $("#accModalTitle").text("编辑邮箱");
    $("#acc-id").val(acc.id);
    $("#acc-name").val(acc.name);
    $("#acc-alias").val(acc.alias);
    if (acc.client_id) {
        $("#acc-api-config").val(`${acc.client_id},${acc.client_secret},${acc.refresh_token}`);
    } else {
        $("#acc-api-config").val("");
    }
    $("#acc-gas-url").val(acc.script_url && acc.script_url.startsWith('http') ? acc.script_url : "");
    $("#acc-status").prop("checked", acc.status == 1);
    new bootstrap.Modal(document.getElementById('addAccountModal')).show();
}

function saveAccount() {
    const id = $("#acc-id").val();
    const apiConfig = $("#acc-api-config").val().trim();
    const gasUrl = $("#acc-gas-url").val().trim();
    
    let type = "";
    if (apiConfig && gasUrl) {
        type = "API/GAS";
    } else if (apiConfig) {
        type = "API";
    } else if (gasUrl) {
        type = "GAS";
    } else {
        showToast("请至少填写 API 配置或 GAS URL 其中一项");
        return;
    }

    const data = {
        name: $("#acc-name").val(),
        alias: $("#acc-alias").val(),
        api_config: apiConfig,
        gas_url: gasUrl,
        type: type, 
        status: $("#acc-status").is(":checked")
    };

    const method = id ? 'PUT' : 'POST';
    if(id) data.id = id;
    
    const btn = $(event.target);
    if(btn.length) btn.prop('disabled', true);

    fetch(API_BASE + '/api/accounts', { method, headers: getHeaders(), body: JSON.stringify(data) })
    .then(r => r.json())
    .then(res => {
        if(btn.length) btn.prop('disabled', false); 
        
        if (res.ok) {
            bootstrap.Modal.getInstance(document.getElementById('addAccountModal')).hide();
            showToast(id ? "更新成功" : "添加成功");
            
            loadAccounts(currentAccountPage);
            loadAllAccountNames(); // 刷新下拉列表
        } else {
            alert("错误: " + res.error);
        }
    })
    .catch(err => {
        if(btn.length) btn.prop('disabled', false);
        showToast("网络请求失败");
    });
}

function batchDelAccounts() {
    const ids = $(".acc-check:checked").map(function(){return this.value;}).get();
    if(ids.length === 0) return showToast("请先选择");
    if(confirm("确定删除选中邮箱?")) {
        fetch(API_BASE + '/api/accounts?ids=' + ids.join(','), { method: 'DELETE', headers: getHeaders() })
            .then(() => { showToast("删除成功"); loadAccounts(currentAccountPage); loadAllAccountNames(); });
    }
}

function delAccount(id) {
    if(confirm("删除此邮箱?")) {
        fetch(API_BASE + '/api/accounts?id=' + id, { method: 'DELETE', headers: getHeaders() })
            .then(() => { loadAccounts(currentAccountPage); loadAllAccountNames(); });
    }
}

// ================== 发件任务 (分页 & 后端搜索) ==================

function loadTasks(page = 1) {
    const searchQuery = $("#section-send input[placeholder*='搜主题']").val().trim();
    currentTaskPage = page;

    $("#task-list-body").html('<tr><td colspan="7" class="text-center text-muted py-3"><i class="fas fa-spinner fa-spin"></i> 加载任务中...</td></tr>');

    // _t防止缓存
    fetch(`${API_BASE}/api/tasks?page=${page}&limit=50&q=${encodeURIComponent(searchQuery)}&_t=${Date.now()}`, { headers: getHeaders() })
        .then(r => r.json())
        .then(res => {
            const list = res.data || [];
            cachedTasks = list;
            currentTaskTotalPages = res.total_pages || 1;
            
            renderTaskList(list);
            
            $("#task-page-info").text(`第 ${res.page} / ${res.total_pages} 页 (共 ${res.total} 条)`);
            $("#btn-prev-task").prop("disabled", res.page <= 1);
            $("#btn-next-task").prop("disabled", res.page >= res.total_pages);
        });
}

function renderTaskList(taskList) {
    let html = '';
    taskList.forEach(task => {
        let statusColor = task.status === 'success' ? 'text-success' : (task.status === 'error' ? 'text-danger' : 'text-warning');
        const statusMap = { 'pending': '等待中', 'success': '成功', 'error': '失败', 'running': '运行中' };
        const statusText = statusMap[task.status] || task.status;
        
        const countsDisplay = `<div style="font-size: 0.75rem; color: #666; margin-top: 2px;">成功:${task.success_count||0} / 失败:${task.fail_count||0}</div>`;

        // 优先显示联表查询到的 account_name，如果没有则显示 ID
        const accName = task.account_name ? task.account_name : `<span class="text-muted">ID:${task.account_id}</span>`;
        
        const loopSwitch = `
        <div class="form-check form-switch">
            <input class="form-check-input" type="checkbox" ${task.is_loop ? 'checked' : ''} onchange="toggleTaskLoop(${task.id}, this.checked)">
        </div>`;
        
        const nextRunStr = formatChinaTime(task.next_run_at);

        html += `<tr>
            <td><input type="checkbox" class="task-check" value="${task.id}"></td>
            <td>${escapeHtml(accName)}</td>
            <td><span class="text-truncate-cell" title="${escapeHtml(task.subject||'')}">${escapeHtml(task.subject || '-')}</span></td>
            <td>${nextRunStr}</td>
            <td>${loopSwitch}</td>
            <td class="${statusColor} fw-bold">
                ${statusText}
                ${countsDisplay}
            </td>
            <td>
                <button class="btn btn-sm btn-outline-primary py-0" title="执行" onclick="manualRun(${task.id})"><i class="fas fa-play"></i></button>
                <button class="btn btn-sm btn-outline-secondary py-0" title="编辑" onclick="editTask(${task.id})"><i class="fas fa-edit"></i></button>
                <button class="btn btn-sm btn-outline-danger py-0" title="删除" onclick="delTask(${task.id})"><i class="fas fa-trash"></i></button>
            </td>
        </tr>`;
    });
    if(taskList.length === 0) html = '<tr><td colspan="7" class="text-center text-muted">无任务</td></tr>';
    $("#task-list-body").html(html);
}

function filterTasks(text) {
    if (taskSearchTimer) clearTimeout(taskSearchTimer);
    taskSearchTimer = setTimeout(() => {
        loadTasks(1);
    }, 300);
}

function changeTaskPage(delta) {
    const newPage = currentTaskPage + delta;
    if (newPage > 0 && newPage <= currentTaskTotalPages) {
        loadTasks(newPage);
    }
}

function getSelectedAccountId() {
    const name = $("#send-account-input").val();
    return window.accountNameMap ? window.accountNameMap[name] : null;
}

// 修改 loadAllAccountNames 以支持 ID 查找
function loadAllAccountNames() {
    fetch(`${API_BASE}/api/accounts?type=simple`, { headers: getHeaders() })
        .then(r => r.json())
        .then(data => {
            let optionsHtml = '';
            window.accountNameMap = {}; // 建立映射
            data.forEach(acc => {
                optionsHtml += `<option value="${acc.name}">别名: ${acc.alias || '-'}</option>`;
                window.accountNameMap[acc.name] = acc.id;
            });
            $("#account-list-options").html(optionsHtml);
        });
}

function toggleTaskLoop(id, isLoop) {
    const task = cachedTasks.find(t => t.id === id);
    if (!task) return;
    const data = { ...task, is_loop: isLoop };
    fetch(API_BASE + '/api/tasks', { method: 'PUT', headers: getHeaders(), body: JSON.stringify(data) })
        .then(r => r.json()).then(res => {
            if(res.ok) { showToast("循环状态已更新"); task.is_loop = isLoop; }
            else { showToast("更新失败: " + res.error); loadTasks(currentTaskPage); }
        });
}

function saveTask() {
    const id = $("#edit-task-id").val();
    const accId = getSelectedAccountId();
    if (!accId) { showToast("请填写正确的发件邮箱名称（需在列表中存在）"); return; }

    // [核心修改] 拼接 d|h|m|s 格式字符串
    const d = $("#delay-d").val().trim() || "0";
    const h = $("#delay-h").val().trim() || "0";
    const m = $("#delay-m").val().trim() || "0";
    const s = $("#delay-s").val().trim() || "0";
    const delayConfigStr = `${d}|${h}|${m}|${s}`; // 新格式: d|h|m|s
    const checkLoop = $("#loop-switch").is(":checked");
    if (checkLoop && d === "0" && h === "0" && m === "0" && s === "0") {
        showToast("⚠️ 开启循环时，必须设置至少一项延迟时间");
        return; // 阻止提交
    }
    const localDateStr = $("#date-a").val();
    let utcDateStr = "";
    if (localDateStr) {
        utcDateStr = new Date(localDateStr).toISOString();
    }

    const data = {
        account_id: accId,
        to_email: $("#send-to").val(),
        subject: $("#send-subject").val(),
        content: $("#send-content").val(),
        base_date: utcDateStr, 
        delay_config: delayConfigStr,
        is_loop: $("#loop-switch").is(":checked"),
        execution_mode: getExecutionMode()
    };

    const method = id ? 'PUT' : 'POST';
    if(id) data.id = id;

    fetch(API_BASE + '/api/tasks', { method, headers: getHeaders(), body: JSON.stringify(data) }).then(() => {
        showToast(id ? "修改成功" : "添加成功");
        cancelEditTask();
        loadTasks(currentTaskPage);
    });
}

function getExecutionMode() {
    if ($("#pref-api").is(":checked")) return 'API';
    if ($("#pref-gas").is(":checked")) return 'GAS';
    return 'AUTO';
}

function editTask(id) {
    const task = cachedTasks.find(t => t.id === id);
    if(!task) return;
    $("#edit-task-id").val(task.id);
    
    $("#send-account-input").val(task.account_name || '');
    
    $("#send-to").val(task.to_email);
    $("#send-subject").val(task.subject);
    $("#send-content").val(task.content);
    
    if (task.base_date) {
        const dateObj = new Date(task.base_date);
        if (!isNaN(dateObj.getTime())) {
            $("#date-a").val(toLocalISOString(dateObj));
        } else {
            $("#date-a").val("");
        }
    } else {
        $("#date-a").val("");
    }
    
    // [核心修改] 回显 d|h|m|s
    if (task.delay_config && task.delay_config.includes('|')) {
        const parts = task.delay_config.split('|');
        $("#delay-d").val(parts[0] || "0");
        $("#delay-h").val(parts[1] || "0");
        $("#delay-m").val(parts[2] || "0");
        $("#delay-s").val(parts[3] || "0");
    } else if (task.delay_config && task.delay_config.includes(',')) {
        // 兼容旧格式显示 (虽然不太完美，但能看)
        const parts = task.delay_config.split(',');
        if(parts[1] === 'day') $("#delay-d").val(parts[0]);
        else if(parts[1] === 'hour') $("#delay-h").val(parts[0]);
        else if(parts[1] === 'minute') $("#delay-m").val(parts[0]);
    } else {
        // 纯数字当做天
        $("#delay-d").val(task.delay_config || "0");
    }
    
    $("#loop-switch").prop("checked", !!task.is_loop);
    let mode = task.execution_mode || 'AUTO';
    $(`input[name="pref-mode"][id="pref-${mode.toLowerCase()}"]`).prop("checked", true);
    $("#task-card-title").text("编辑任务 (ID: " + id + ")");
    $("#btn-save-task").html('<i class="fas fa-save"></i> 更新任务');
    $("#btn-cancel-edit").removeClass("d-none");
    document.querySelector('.content-section.active').scrollIntoView();
}

function cancelEditTask() {
    $("#edit-task-id").val("");
    $("#task-card-title").text("创建任务 / 立即发送");
    $("#btn-save-task").html('<i class="fas fa-clock"></i> 添加任务');
    $("#btn-cancel-edit").addClass("d-none");
    $("#send-account-input").val("");
    $("#send-to").val("");
    $("#send-subject").val("");
    $("#send-content").val("");
    
    $("#delay-d").val("");
    $("#delay-h").val("");
    $("#delay-m").val("");
    $("#delay-s").val("");
    
    $("#date-a").val("");
}

function manualRun(id) {
    if(!confirm("立即执行?")) return;
    fetch(API_BASE + '/api/tasks', { method: 'PUT', headers: getHeaders(), body: JSON.stringify({ id: id, action: 'execute' }) })
        .then(r=>r.json()).then(res=>{
        if(res.ok) { showToast("执行成功"); loadTasks(currentTaskPage); }
        else showToast("失败: "+res.error);
    });
}

function delTask(id) {
    if(confirm("确定删除任务?")) {
        fetch(API_BASE + '/api/tasks?id=' + id, { method: 'DELETE', headers: getHeaders() })
            .then(() => { showToast("已删除"); loadTasks(currentTaskPage); });
    }
}

function batchDelTasks() {
    const ids = $(".task-check:checked").map(function(){return this.value;}).get();
    if(ids.length === 0) return showToast("请先选择");
    if(confirm("确定删除选中任务?")) {
        fetch(API_BASE + '/api/tasks?ids=' + ids.join(','), { method: 'DELETE', headers: getHeaders() })
            .then(() => { showToast("批量删除完成"); loadTasks(currentTaskPage); });
    }
}

function sendNow() {
    const accId = getSelectedAccountId();
    if(!accId) { showToast("请填写正确的发件邮箱名称"); return; }

    const data = {
        account_id: accId,
        to_email: $("#send-to").val(),
        subject: $("#send-subject").val(),
        content: $("#send-content").val(),
        immediate: true,
        execution_mode: getExecutionMode()
    };
    
    const btn = $(event.target).closest('button');
    const originalHtml = btn.html();
    btn.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i> 发送中...');
    
    fetch(API_BASE + '/api/tasks', { method: 'POST', headers: getHeaders(), body: JSON.stringify(data) })
    .then(r => r.json())
    .then(res => {
        btn.prop('disabled', false).html(originalHtml);
        if(res.ok) showToast("发送成功");
        else showToast("失败: " + (res.error || '未知'));
    })
    .catch(() => {
        btn.prop('disabled', false).html(originalHtml);
        showToast("网络错误");
    });
}

// ================== 收件管理 (分页 & 后端搜索) ==================

function loadInboxAccounts(page = 1) {
    const searchQuery = $("#section-receive input[placeholder*='搜索收件邮箱']").val().trim();
    currentInboxPage = page;
    
    $("#inbox-account-list").html('<div class="p-3 text-center text-muted"><i class="fas fa-spinner fa-spin"></i> 加载中...</div>');

    fetch(`${API_BASE}/api/accounts?page=${page}&limit=20&q=${encodeURIComponent(searchQuery)}`, { headers: getHeaders() })
        .then(r => r.json())
        .then(res => {
            const list = res.data || []; 
            currentInboxTotalPages = res.total_pages || 1;
            
            renderInboxAccounts(list);
            
            $("#inbox-page-info").text(`${res.page}/${res.total_pages}`);
            $("#btn-prev-inbox").prop("disabled", res.page <= 1);
            $("#btn-next-inbox").prop("disabled", res.page >= res.total_pages);
        });
}

function renderInboxAccounts(accounts) {
    let html = '';
    let startIdx = (currentInboxPage - 1) * 20 + 1;

    accounts.forEach((acc, i) => {
        if (acc.status) { 
            const hasApi = acc.type.includes('API');
            const hasGas = acc.type.includes('GAS');
            let apiChecked = (hasApi) ? 'checked' : '';
            let gasChecked = (!hasApi && hasGas) ? 'checked' : '';
            
            let apiDisabled = !hasApi ? 'disabled' : '';
            let gasDisabled = !hasGas ? 'disabled' : '';

            const activeClass = (currentInboxAccountId == acc.id) ? 'active' : '';

            html += `
            <div class="list-group-item list-group-item-action py-2 account-row ${activeClass}" id="acc-row-${acc.id}" onclick="selectAccount(${acc.id}, this)">
                <div class="row align-items-center g-0">
                    <div class="col text-truncate">
                        <div class="d-flex align-items-center">
                            <span class="badge bg-light text-secondary border me-2" style="min-width: 25px;">${startIdx + i}</span>
                            <span class="fw-bold text-truncate" title="${acc.name}">${acc.name}</span>
                        </div>
                    </div>
                    <div class="col-auto ms-2">
                        <div class="btn-group btn-group-sm" role="group" onclick="event.stopPropagation()">
                            <input type="radio" class="btn-check" name="mode_${acc.id}" id="mode_api_${acc.id}" value="API" ${apiChecked} ${apiDisabled} onchange="updateFetchMode(${acc.id}, 'API')">
                            <label class="btn btn-outline-success" for="mode_api_${acc.id}" style="font-size: 0.6rem; padding: 0.1rem 0.3rem;">API</label>

                            <input type="radio" class="btn-check" name="mode_${acc.id}" id="mode_gas_${acc.id}" value="GAS" ${gasChecked} ${gasDisabled} onchange="updateFetchMode(${acc.id}, 'GAS')">
                            <label class="btn btn-outline-primary" for="mode_gas_${acc.id}" style="font-size: 0.6rem; padding: 0.1rem 0.3rem;">GAS</label>
                        </div>
                    </div>
                </div>
            </div>`;
        }
    });

    if(html === '') html = '<div class="p-3 text-center text-muted small">无匹配账号</div>';
    $("#inbox-account-list").html(html);
}

function filterInboxAccounts(text) {
    if (inboxSearchTimer) clearTimeout(inboxSearchTimer);
    inboxSearchTimer = setTimeout(() => {
        loadInboxAccounts(1);
    }, 300);
}

function changeInboxPage(delta) {
    const newPage = currentInboxPage + delta;
    if (newPage > 0 && newPage <= currentInboxTotalPages) {
        loadInboxAccounts(newPage);
    }
}

function selectAccount(accountId, element) {
    currentInboxAccountId = accountId;
    
    const mode = $(`input[name="mode_${accountId}"]:checked`).val();
    currentFetchMode = mode || 'API';

    $(".account-row").removeClass("active");
    $(element).addClass("active");
    
    currentEmailLimit = 0; 
    $(".limit-btn").removeClass("active");
    $("#custom-limit-input").val("");
    
    $("#email-content-view").html(`
        <div class="text-center mt-5 text-muted">
            <i class="fas fa-hand-pointer fa-3x mb-3"></i>
            <p>已选中邮箱: <b>${$(element).find('.fw-bold').text()}</b></p>
            <p>当前模式: <span class="badge bg-secondary">${currentFetchMode}</span></p>
            <p class="small mt-3">点击上方 "1封" / "3封" 按钮<br>将自动同步并显示最新邮件</p>
        </div>
    `);
}

function updateFetchMode(accId, mode) {
    if (currentInboxAccountId === accId) {
        currentFetchMode = mode;
        showToast("收件模式已切换为: " + mode);
    }
}

function setLimit(num) {
    currentEmailLimit = parseInt(num);
    $(".limit-btn").removeClass("active");
    $(".limit-btn").each(function() {
        if ($(this).text().includes(num + "封")) $(this).addClass("active");
    });
    $("#custom-limit-input").val(""); 

    if (currentInboxAccountId) {
        syncAndLoad(); 
    } else {
        showToast("请先在左侧选择一个邮箱");
    }
}

function setCustomLimit(val) {
    if (!val || val <= 0) return;
    currentEmailLimit = parseInt(val);
    $(".limit-btn").removeClass("active");
    if (currentInboxAccountId) {
        syncAndLoad();
    } else {
        showToast("请先在左侧选择一个邮箱");
    }
}

function syncAndLoad() {
    if (!currentInboxAccountId || !currentEmailLimit) return;

    $("#email-content-view").html(`
        <div class="text-center mt-5">
            <div class="spinner-border text-primary"></div>
            <p class="mt-2 text-muted">正在通过 <b>${currentFetchMode}</b> 同步...</p>
        </div>
    `);

    fetch(API_BASE + '/api/emails', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ 
            account_id: currentInboxAccountId,
            mode: currentFetchMode 
        })
    })
    .then(r => r.json())
    .then(res => {
        if (res.ok) {
            if(res.count > 0) showToast(`收取到 ${res.count} 封新邮件`);
            fetchEmailsAfterSync(); 
        } else {
            $("#email-content-view").html(`
                <div class="text-center mt-5 text-danger">
                    <i class="fas fa-times-circle fa-3x mb-3"></i>
                    <p>同步失败: ${res.error}</p>
                    <button class="btn btn-outline-secondary btn-sm mt-3" onclick="fetchEmailsAfterSync()">
                        尝试加载旧缓存
                    </button>
                </div>
            `);
        }
    })
    .catch(err => {
        $("#email-content-view").html(`<div class="text-center mt-5 text-danger"><p>网络错误: ${err.message}</p></div>`);
    });
}

function fetchEmailsAfterSync() {
    fetch(`${API_BASE}/api/emails?account_id=${currentInboxAccountId}&limit=${currentEmailLimit}`, { 
        headers: getHeaders() 
    })
    .then(r => r.json())
    .then(data => {
        if (!data || data.length === 0) {
            $("#email-content-view").html(`
                <div class="text-center mt-5 text-muted">
                    <i class="fas fa-inbox fa-3x mb-3"></i>
                    <p>暂无邮件</p>
                </div>`);
            return;
        }

        let html = `<div class="p-3">
            <div class="d-flex justify-content-between align-items-center mb-3 border-bottom pb-2">
                <h5 class="m-0">最新收件 (显示 ${data.length} 封)</h5>
                <small class="text-muted">刚刚更新</small>
            </div>
            <div class="list-group">`;
        
        data.forEach(email => {
            const dateStr = formatChinaTime(email.received_at);
            html += `
                <div class="list-group-item list-group-item-action flex-column align-items-start p-3 mb-2 shadow-sm border rounded">
                    <div class="d-flex w-100 justify-content-between mb-2">
                        <h6 class="mb-1 fw-bold text-primary">${escapeHtml(email.subject || '(无主题)')}</h6>
                        <small class="text-muted text-nowrap ms-2">${dateStr}</small>
                    </div>
                    <p class="mb-1 text-secondary small">发件人: ${escapeHtml(email.sender || '未知')}</p>
                    <div class="mt-2 p-2 bg-light rounded text-break" style="font-size: 0.9rem; white-space: pre-wrap;">${email.body || '(无内容)'}</div>
                </div>`;
        });
        
        html += `</div></div>`;
        $("#email-content-view").html(html);
    });
}

// ================== 批量导入/处理 ==================
function openBatchAccountModal() {
    $("#import-acc-json").val("");
    $("#import-acc-file-input").val("");
    new bootstrap.Modal(document.getElementById('batchAccountImportModal')).show();
}

function submitBatchAccountImport() {
    const activeTab = $("#importTabs .active").attr("data-bs-target");
    let jsonString = "";

    if (activeTab === "#tab-paste") {
        jsonString = $("#import-acc-json").val();
        if (!jsonString.trim()) return showToast("请输入 JSON 内容");
        processImport(jsonString);
    } else {
        const fileInput = document.getElementById('import-acc-file-input');
        const file = fileInput.files[0];
        if (!file) return showToast("请选择文件");
        
        const reader = new FileReader();
        reader.onload = function(e) {
            processImport(e.target.result);
        };
        reader.readAsText(file);
    }
}

function processImport(jsonStr) {
    try {
        const json = JSON.parse(jsonStr);
        if (!Array.isArray(json)) throw new Error("JSON 必须是数组格式");

        fetch(API_BASE + '/api/accounts', {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify(json)
        }).then(r => r.json()).then(res => {
            if (res.ok) {
                bootstrap.Modal.getInstance(document.getElementById('batchAccountImportModal')).hide();
                alert(`导入完成！\n成功: ${res.imported}\n跳过: ${res.skipped}`);
                loadAccounts(currentAccountPage);
                loadAllAccountNames();
            } else {
                alert("导入失败: " + res.error);
            }
        });
    } catch(err) {
        alert("JSON 格式错误: " + err.message);
    }
}

function openBatchTaskModal() {
    new bootstrap.Modal(document.getElementById('batchTaskModal')).show();
}

function submitBatchTasks() {
    try {
        const json = JSON.parse($("#batch-task-json").val());
        if(!Array.isArray(json)) throw new Error("必须是数组");
        fetch(API_BASE + '/api/tasks', { method: 'POST', headers: getHeaders(), body: JSON.stringify(json) })
            .then(() => {
                bootstrap.Modal.getInstance(document.getElementById('batchTaskModal')).hide();
                showToast("批量添加成功");
                loadTasks(currentTaskPage);
            });
    } catch(e) {
        alert("JSON 格式错误: " + e.message);
    }
}

function toggleAll(type) {
    const checked = $("#check-all-" + type).is(":checked");
    $("." + type + "-check").prop("checked", checked);
}

// 初始化
if(localStorage.getItem("auth_token")) {
    $("#login-overlay").hide();
    loadAccounts();
    loadAllAccountNames();
}
