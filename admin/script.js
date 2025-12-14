const API_BASE = "https://gm.xyrj.dpdns.org";

// ================== 全局变量定义 ==================

// 1. 邮箱管理分页
let cachedAccounts = []; 
let currentAccountPage = 1;
let currentAccountTotalPages = 1;
let accountSearchTimer = null;

// 2. 任务管理分页
let cachedTasks = []; 
let currentTaskPage = 1;
let currentTaskTotalPages = 1;
let taskSearchTimer = null;

// 3. 收件查看分页
let currentInboxPage = 1;
let currentInboxTotalPages = 1;
let inboxSearchTimer = null;
let currentInboxAccountId = null;
let currentEmailLimit = 0; 
let currentFetchMode = 'API'; 

// 4. [新增] 收件规则管理
let cachedRules = [];
let ruleSearchTimer = null;

// 鼠标位置 (用于 Toast)
let lastMouseX = 0, lastMouseY = 0;

// ================== 工具函数 ==================

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

function generateRandomString(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
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

// ================== 登录/注销 ==================

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
                loadAllAccountNames(); 
            } else {
                showToast("账号或密码错误");
            }
        }).catch(()=> showToast("连接失败"));
}

function doLogout() {
    localStorage.removeItem("auth_token");
    location.reload();
}

// ================== 页面切换逻辑 ==================

function showSection(id) {
    $(".content-section").removeClass("active");
    $("#" + id).addClass("active");
    $(".list-group-item").removeClass("active");
    $(event.currentTarget).addClass("active");
    
    if(id === 'section-accounts') {
        loadAccounts(currentAccountPage);
    }
    if(id === 'section-rules') {
        loadRules(); // [新增] 加载规则
    }
    if(id === 'section-send') {
        if ($("#account-list-options option").length === 0) {
            loadAllAccountNames();
        }
        loadTasks(currentTaskPage);
    }
    if(id === 'section-receive') {
        loadInboxAccounts(currentInboxPage);
    }
}

// ================== 1. 邮箱管理 (Accounts) ==================

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

function loadAllAccountNames() {
    fetch(`${API_BASE}/api/accounts?type=simple`, { headers: getHeaders() })
        .then(r => r.json())
        .then(data => {
            let optionsHtml = '';
            window.accountNameMap = {}; 
            data.forEach(acc => {
                optionsHtml += `<option value="${acc.name}">别名: ${acc.alias || '-'}</option>`;
                window.accountNameMap[acc.name] = acc.id;
            });
            $("#account-list-options").html(optionsHtml);
        });
}

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
    const originalStatus = acc.status;
    acc.status = isActive ? 1 : 0;
    
    fetch(API_BASE + '/api/accounts', { method: 'PUT', headers: getHeaders(), body: JSON.stringify(acc) })
        .then(r => r.json()).then(res => {
            if(res.ok) { showToast(isActive ? "邮箱已启用" : "邮箱已禁用"); }
            else { 
                showToast("更新失败"); 
                acc.status = originalStatus; 
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
            loadAllAccountNames(); 
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

// ================== 2. [新增] 收件规则管理 (Rules) ==================

function loadRules() {
    const searchQuery = $("#section-rules input[placeholder*='搜索']").val().trim();
    
    $("#rule-list-body").html('<tr><td colspan="8" class="text-center py-4"><div class="spinner-border text-primary spinner-border-sm"></div> 加载中...</td></tr>');

    // 这里假设后端一次性返回所有数据（如果没有分页），或者我们自己在前端过滤
    fetch(`${API_BASE}/api/rules`, { headers: getHeaders() })
        .then(r => r.json())
        .then(data => {
            // 前端简单过滤
            let filtered = data;
            if (searchQuery) {
                const lowerQ = searchQuery.toLowerCase();
                filtered = data.filter(r => 
                    r.name.toLowerCase().includes(lowerQ) || 
                    (r.alias && r.alias.toLowerCase().includes(lowerQ)) ||
                    r.query_code.toLowerCase().includes(lowerQ)
                );
            }
            
            cachedRules = filtered;
            renderRules(filtered);
            $("#rule-page-info").text(`共 ${filtered.length} 条规则`);
        });
}

function renderRules(data) {
    let html = '';
    const host = window.location.host; // 获取当前域名
    const protocol = window.location.protocol;

    data.forEach(r => {
        const fullLink = `${protocol}//${host}/${r.query_code}`;
        
        let validStr = '<span class="badge bg-success">永久有效</span>';
        if (r.valid_until) {
            const date = new Date(r.valid_until);
            const isExpired = Date.now() > r.valid_until;
            validStr = `<span class="badge ${isExpired ? 'bg-danger' : 'bg-info'}">${formatChinaTime(r.valid_until)}</span>`;
        }

        let matchStr = [];
        if (r.match_sender) matchStr.push(`<span class="badge bg-light text-dark border">发: ${escapeHtml(r.match_sender)}</span>`);
        if (r.match_receiver) matchStr.push(`<span class="badge bg-light text-dark border">收: ${escapeHtml(r.match_receiver)}</span>`);
        if (r.match_body) matchStr.push(`<span class="badge bg-light text-dark border">文: ${escapeHtml(r.match_body)}</span>`);
        if (matchStr.length === 0) matchStr.push('<span class="text-muted small">无限制</span>');

        html += `<tr>
            <td><input type="checkbox" class="rule-check" value="${r.id}"></td>
            <td class="fw-bold">${escapeHtml(r.name)}</td>
            <td>${escapeHtml(r.alias)}</td>
            <td>
                <div class="input-group input-group-sm" style="width: 140px;" onclick="copyLink('${fullLink}')" title="点击复制链接">
                    <span class="input-group-text bg-light"><i class="fas fa-link"></i></span>
                    <input type="text" class="form-control cursor-pointer bg-white" value="${r.query_code}" readonly>
                </div>
            </td>
            <td>${r.fetch_limit || 5}</td>
            <td>${validStr}</td>
            <td>${matchStr.join(' ')}</td>
            <td>
                <button class="btn btn-sm btn-light text-primary py-0" onclick="openEditRuleModal(${r.id})"><i class="fas fa-edit"></i></button> 
                <button class="btn btn-sm btn-light text-danger py-0" onclick="delRule(${r.id})"><i class="fas fa-trash"></i></button>
            </td>
        </tr>`;
    });

    if(data.length === 0) html = '<tr><td colspan="8" class="text-center text-muted">暂无规则</td></tr>';
    $("#rule-list-body").html(html);
}

function filterRules(text) {
    if (ruleSearchTimer) clearTimeout(ruleSearchTimer);
    ruleSearchTimer = setTimeout(() => {
        loadRules();
    }, 300);
}

function copyLink(url) {
    copyText(url);
}

function generateRandomRuleCode() {
    $("#rule-code").val(generateRandomString(10));
}

function openAddRuleModal() {
    $("#ruleModalTitle").text("添加收件规则");
    $("#rule-id").val("");
    $("#rule-name").val("");
    $("#rule-alias").val("");
    $("#rule-code").val(""); 
    $("#rule-limit").val("5");
    $("#rule-valid").val("");
    $("#rule-match-sender").val("");
    $("#rule-match-receiver").val("");
    $("#rule-match-body").val("");
    
    new bootstrap.Modal(document.getElementById('addRuleModal')).show();
}

function openEditRuleModal(id) {
    const rule = cachedRules.find(r => r.id === id);
    if (!rule) return;

    $("#ruleModalTitle").text("编辑收件规则");
    $("#rule-id").val(rule.id);
    $("#rule-name").val(rule.name);
    $("#rule-alias").val(rule.alias);
    $("#rule-code").val(rule.query_code);
    $("#rule-limit").val(rule.fetch_limit || 5);
    
    if (rule.valid_until) {
        $("#rule-valid").val(toLocalISOString(new Date(rule.valid_until)));
    } else {
        $("#rule-valid").val("");
    }

    $("#rule-match-sender").val(rule.match_sender || "");
    $("#rule-match-receiver").val(rule.match_receiver || "");
    $("#rule-match-body").val(rule.match_body || "");

    new bootstrap.Modal(document.getElementById('addRuleModal')).show();
}

function saveRule() {
    const id = $("#rule-id").val();
    const name = $("#rule-name").val().trim();
    const alias = $("#rule-alias").val().trim();

    if (!name || !alias) {
        return showToast("邮箱名和别名不能为空");
    }

    // 有效期处理
    let validUntil = null;
    const dateStr = $("#rule-valid").val();
    if (dateStr) {
        validUntil = new Date(dateStr).getTime();
    }

    const data = {
        name: name,
        alias: alias,
        query_code: $("#rule-code").val().trim(), // 后端会处理为空自动生成
        fetch_limit: parseInt($("#rule-limit").val()) || 5,
        valid_until: validUntil,
        match_sender: $("#rule-match-sender").val().trim(),
        match_receiver: $("#rule-match-receiver").val().trim(),
        match_body: $("#rule-match-body").val().trim()
    };

    const method = 'POST'; // 无论是新增还是修改，后端接口统一用POST处理（根据是否有id判断）
    if(id) data.id = id;

    const btn = $(event.target);
    btn.prop('disabled', true);

    fetch(API_BASE + '/api/rules', { method, headers: getHeaders(), body: JSON.stringify(data) })
        .then(r => r.json())
        .then(res => {
            btn.prop('disabled', false);
            if (res.success) {
                bootstrap.Modal.getInstance(document.getElementById('addRuleModal')).hide();
                showToast(id ? "规则已更新" : "规则已添加");
                loadRules();
            } else {
                alert("错误: " + (res.error || "未知错误"));
            }
        })
        .catch(err => {
            btn.prop('disabled', false);
            showToast("请求失败");
        });
}

function delRule(id) {
    if(!confirm("确定删除该规则吗？")) return;
    // 后端 api/rules DELETE 接受数组
    fetch(API_BASE + '/api/rules', { 
        method: 'DELETE', 
        headers: getHeaders(), 
        body: JSON.stringify([id]) 
    }).then(r => r.json()).then(res => {
        if(res.success) {
            showToast("删除成功");
            loadRules();
        } else {
            showToast("删除失败");
        }
    });
}

function batchDelRules() {
    const ids = $(".rule-check:checked").map(function(){return parseInt(this.value);}).get();
    if(ids.length === 0) return showToast("请先选择规则");
    
    if(!confirm(`确定删除选中的 ${ids.length} 条规则吗？`)) return;

    fetch(API_BASE + '/api/rules', { 
        method: 'DELETE', 
        headers: getHeaders(), 
        body: JSON.stringify(ids) 
    }).then(r => r.json()).then(res => {
        if(res.success) {
            showToast("批量删除成功");
            loadRules();
        } else {
            showToast("删除失败");
        }
    });
}

function exportRules() {
    window.open(`${API_BASE}/api/rules/export`);
}

function openBatchRuleModal() {
    $("#import-rule-file-input").val("");
    new bootstrap.Modal(document.getElementById('batchRuleImportModal')).show();
}

function submitBatchRuleImport() {
    const fileInput = document.getElementById('import-rule-file-input');
    const file = fileInput.files[0];
    if (!file) return showToast("请选择 JSON 文件");

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const json = JSON.parse(e.target.result);
            if (!Array.isArray(json)) throw new Error("JSON 必须是数组");
            
            fetch(API_BASE + '/api/rules/import', {
                method: 'POST',
                headers: getHeaders(),
                body: JSON.stringify(json)
            }).then(r => r.json()).then(res => {
                if (res.success) {
                    bootstrap.Modal.getInstance(document.getElementById('batchRuleImportModal')).hide();
                    alert(`导入完成! 成功导入 ${res.count} 条规则`);
                    loadRules();
                } else {
                    alert("导入失败: " + res.error);
                }
            });
        } catch(err) {
            alert("文件解析错误: " + err.message);
        }
    };
    reader.readAsText(file);
}


// ================== 3. 发件任务管理 (Tasks) ==================

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

    const d = $("#delay-d").val().trim() || "0";
    const h = $("#delay-h").val().trim() || "0";
    const m = $("#delay-m").val().trim() || "0";
    const s = $("#delay-s").val().trim() || "0";
    const delayConfigStr = `${d}|${h}|${m}|${s}`; 
    const checkLoop = $("#loop-switch").is(":checked");
    if (checkLoop && d === "0" && h === "0" && m === "0" && s === "0") {
        showToast("⚠️ 开启循环时，必须设置至少一项延迟时间");
        return; 
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
    
    if (task.delay_config && task.delay_config.includes('|')) {
        const parts = task.delay_config.split('|');
        $("#delay-d").val(parts[0] || "0");
        $("#delay-h").val(parts[1] || "0");
        $("#delay-m").val(parts[2] || "0");
        $("#delay-s").val(parts[3] || "0");
    } else if (task.delay_config && task.delay_config.includes(',')) {
        const parts = task.delay_config.split(',');
        if(parts[1] === 'day') $("#delay-d").val(parts[0]);
        else if(parts[1] === 'hour') $("#delay-h").val(parts[0]);
        else if(parts[1] === 'minute') $("#delay-m").val(parts[0]);
    } else {
        $("#delay-d").val(task.delay_config || "0");
    }
    
    $("#loop-switch").prop("checked", !!task.is_loop);
    let mode = task.execution_mode || 'AUTO';
    $(`input[name="pref-mode"][id="pref-${mode.toLowerCase()}"]`).prop("checked", true);
    $("#task-card-title").text("编辑任务 (ID: " + id + ")");
    $("#btn-save-task").html('<i class="fas fa-save"></i> 更新任务');
    $("#btn-cancel-edit").removeClass("d-none");
    // 切换到发送设置tab并滚动
    if (!$('#section-send').hasClass('active')) {
        showSection('section-send');
    }
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

// ================== 4. 收件管理 (Inbox) ==================

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

// ================== 批量导入/处理 (Accounts/Tasks) ==================

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
