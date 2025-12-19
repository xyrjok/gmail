/**
 * worker.js
 * * 绑定变量: 
 * - DB (D1 Database)
 * - ADMIN_USERNAME
 * - ADMIN_PASSWORD
 */

export default {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      const path = url.pathname;
      
      // 1. CORS 跨域处理
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
        });
      }

      // 2. 公开邮件查询接口 (拦截非 API/Admin 的请求)
      if (!path.startsWith('/api/') && !path.startsWith('/admin') && path !== '/' && path !== '/favicon.ico') {
        const code = path.substring(1); // 去掉开头的 /
        
        // 查询规则
        const rule = await env.DB.prepare('SELECT * FROM access_rules WHERE query_code = ?').bind(code).first();

        if (rule) {
            // 2.1 检查有效期
            if (rule.valid_until && Date.now() > rule.valid_until) {
                return new Response("该查询链接已失效 (Expired)", { status: 403, headers: { "Content-Type": "text/plain;charset=UTF-8" } });
            }

            // 2.2 构建查询条件
            // 根据规则的 name 或 alias 查找对应的唯一邮箱账号
            const account = await env.DB.prepare(`
                SELECT * FROM accounts 
                WHERE (name = ? OR alias = ? OR name = ? OR alias = ?) 
                AND status = 1
            `).bind(rule.name, rule.name, rule.alias, rule.alias).first();

            if (!account) {
                return new Response("未找到对应的有效邮箱账号 (Account Not Found or Disabled)", { status: 404, headers: { "Content-Type": "text/plain;charset=UTF-8" } });
            }

            // 构建 Gmail 搜索语句
            let qParts = [];
            if (rule.match_sender) qParts.push(`from:${rule.match_sender}`);
            if (rule.match_receiver) qParts.push(`to:${rule.match_receiver}`);
            if (rule.match_body) {
                // 处理多关键字 OR 逻辑，并加引号
                const bodyQ = rule.match_body.split('|').map(k => `"${k.trim()}"`).join(' OR ');
                qParts.push(`(${bodyQ})`);
            }
            const qStr = qParts.join(' ') || "label:inbox OR label:spam";
            
            // 解析抓取数量 (支持 5-3 格式: 抓5显3)
            let limitFetch = 5;
            let limitShow = 5;
            const limitStr = String(rule.fetch_limit || '5');
            if (limitStr.includes('-')) {
                const parts = limitStr.split('-');
                limitFetch = parseInt(parts[0]) || 5;
                limitShow = parseInt(parts[1]) || limitFetch;
            } else {
                limitFetch = parseInt(limitStr) || 5;
                limitShow = limitFetch;
            }
            const limit = limitFetch; 

            let results = [];
            let apiSuccess = false;

            // [Step 1] 尝试 API (如果账号支持)
            if (account.type.includes('API')) {
                try {
                    // [修改] 直接传递 account 对象，不再查表，或者依然调用优化后的 getAccountAuth
                    const authData = await getAccountAuth(env, account.id);
                    if (authData && authData.refresh_token) {
                        const accessToken = await getAccessToken(authData);
                        const listResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${limit}&q=${encodeURIComponent(qStr)}`, {
                            headers: { 'Authorization': `Bearer ${accessToken}` }
                        });
                        
                        if (listResp.ok) {
                            const listData = await listResp.json();
                            if (listData.messages) {
                                const detailTasks = listData.messages.map(async (msgItem) => {
                                    const detailResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgItem.id}`, {
                                        headers: { 'Authorization': `Bearer ${accessToken}` }
                                    });
                                    if (detailResp.ok) {
                                        const detail = await detailResp.json();
                                        let subject = '(No Subject)';
                                        let sender = 'Unknown';
                                        const headers = detail.payload.headers || [];
                                        headers.forEach(h => {
                                            if (h.name === 'Subject') subject = h.value;
                                            if (h.name === 'From') sender = h.value;
                                        });
                                        
                                        // 强制本地匹配
                                        if (rule.match_body) {
                                            const bodyLower = (detail.snippet || '').toLowerCase();
                                            const keys = rule.match_body.split('|').map(k => k.trim().toLowerCase());
                                            if (!keys.some(k => bodyLower.includes(k))) return;
                                        }
                                        results.push({
                                            subject: subject,
                                            sender: sender,
                                            received_at: parseInt(detail.internalDate || Date.now()),
                                            body: detail.snippet || ''
                                        });
                                    }
                                });
                                await Promise.all(detailTasks);
                            }
                            apiSuccess = true; 
                        }
                    }
                } catch (e) {
                    console.error("API Fetch Failed:", e);
                }
            }

            // [Step 2] 如果 API 失败或不可用，尝试 GAS (如果账号支持)
            if (!apiSuccess && account.type.includes('GAS') && account.script_url) {
                try {
                    let scriptUrl = account.script_url.trim();
                    const joinChar = scriptUrl.includes('?') ? '&' : '?';
                    const gasUrl = `${scriptUrl}${joinChar}action=get&limit=${limit * 3}`;
                    
                    const resp = await fetch(gasUrl);
                    if (resp.ok) {
                        const json = await resp.json();
                        let items = [];
                        if (Array.isArray(json)) items = json;
                        else if (json.data && Array.isArray(json.data)) items = json.data;

                        for (const item of items) {
                            const subject = item.subject || '(No Subject)';
                            const sender = item.from || item.sender || 'Unknown';
                            const body = item.snippet || item.body || '';
                            const received_at = item.date ? new Date(item.date).getTime() : Date.now();

                            let match = true;
                            if (rule.match_sender && !sender.toLowerCase().includes(rule.match_sender.toLowerCase())) match = false;
                            
                            if (rule.match_body) {
                                const keys = rule.match_body.split('|').map(k => k.trim().toLowerCase());
                                if (!keys.some(k => body.toLowerCase().includes(k))) match = false;
                            }
                            
                            if (match) {
                                results.push({ subject, sender, received_at, body });
                            }
                        }
                    }
                } catch (e) {
                    console.error("GAS Fetch Failed:", e);
                }
            }

            // 排序与截取
            results.sort((a, b) => b.received_at - a.received_at);
            if (results.length > limitShow) {
                results = results.slice(0, limitShow);
            }

            // 输出
            if (results.length === 0) {
                if (url.searchParams.get('format') === 'json') {
                    return new Response(JSON.stringify({ error: "暂无邮件" }), { headers: corsHeaders() });
                }
                return new Response("暂无符合条件的邮件。", { headers: { "Content-Type": "text/plain;charset=UTF-8" } });
            }

            if (url.searchParams.get('format') === 'json') {
                const jsonResponse = results.map(mail => ({
                    subject: mail.subject,
                    sender: mail.sender,
                    received_at: formatDateSimple(mail.received_at),
                    body: stripHtml(mail.body)
                }));
                return new Response(JSON.stringify(jsonResponse), { headers: corsHeaders() });
            }

            const outputText = results.map(mail => {
                return formatDateSimple(mail.received_at) + " | " + stripHtml(mail.body);
            }).join('\n');

            return new Response(outputText, { headers: { "Content-Type": "text/plain;charset=UTF-8" } });
        }
      }
  
      // 3. 身份验证
      const authHeader = request.headers.get("Authorization");
      if (!checkAuth(authHeader, env)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders() });
      }
  
      // 4. API 路由
      if (url.pathname.startsWith('/api/accounts')) return handleAccounts(request, env);
      if (url.pathname.startsWith('/api/tasks')) return handleTasks(request, env);
      if (url.pathname.startsWith('/api/emails')) return handleEmails(request, env);
      if (url.pathname.startsWith('/api/rules')) return handleRules(request, env);
      
      return new Response("Backend Active", { headers: corsHeaders() });
    },
  
    // 定时任务触发器
    async scheduled(event, env, ctx) {
      ctx.waitUntil(processScheduledTasks(env));
    }
};
  
// --- 辅助函数 ---

const corsHeaders = () => ({
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
});

function checkAuth(header, env) {
    if (!header) return false;
    const base64 = header.split(" ")[1];
    if (!base64) return false;
    const [user, pass] = atob(base64).split(":");
    return user === env.ADMIN_USERNAME && pass === env.ADMIN_PASSWORD;
}

function getRandFromRange(str) {
    if (!str) return 0;
    if (String(str).includes('-')) {
        const parts = str.split('-');
        const min = parseInt(parts[0]) || 0;
        const max = parseInt(parts[1]) || 0;
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }
    return parseInt(str) || 0;
}

function calculateNextRun(baseTimeMs, configStr) {
    if (!configStr) return baseTimeMs + 86400000; 

    let addMs = 0;
    if (configStr.includes('|')) {
        const parts = configStr.split('|');
        const d = getRandFromRange(parts[0]);
        const h = getRandFromRange(parts[1]);
        const m = getRandFromRange(parts[2]);
        const s = getRandFromRange(parts[3]);
        addMs += d * 24 * 60 * 60 * 1000 + h * 60 * 60 * 1000 + m * 60 * 1000 + s * 1000;
    } 
    else if (configStr.includes(',')) {
        const parts = configStr.split(',');
        const val = getRandFromRange(parts[0]);
        const unit = parts[1];
        let multiplier = 24 * 60 * 60 * 1000;
        if (unit === 'minute') multiplier = 60 * 1000;
        if (unit === 'hour') multiplier = 60 * 60 * 1000;
        addMs = val * multiplier;
    } else {
        addMs = getRandFromRange(configStr) * 86400000;
    }
    if (addMs <= 0) addMs = 60000;
    return baseTimeMs + addMs;
}

function formatDateSimple(ts) {
    if(!ts) return '';
    try {
        const date = new Date(Number(ts));
        const utc8Date = new Date(date.getTime() + 8 * 3600000);
        const y = utc8Date.getUTCFullYear();
        const m = String(utc8Date.getUTCMonth() + 1).padStart(2, '0');
        const d = String(utc8Date.getUTCDate()).padStart(2, '0');
        const h = String(utc8Date.getUTCHours()).padStart(2, '0');
        const min = String(utc8Date.getUTCMinutes()).padStart(2, '0');
        const s = String(utc8Date.getUTCSeconds()).padStart(2, '0');
        return `${y}-${m}-${d} ${h}:${min}:${s}`;
    } catch(e) {
        return new Date(ts).toISOString().replace('T', ' ').substring(0, 19);
    }
}

function generateQueryCode(length = 10) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function stripHtml(html) {
    if (!html) return "";
    let text = html.replace(/<a\s+(?:[^>]*?\s+)?href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '$2 ($1)');
    text = text.replace(/<(?:br|\/p|div)\s*\/?>/gi, '\n');
    text = text.replace(/<[^>]*>/g, '');
    text = text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    return text.split('\n').map(line => line.trim()).filter(line => line).join('\n');
}

// [修改] 直接从 accounts 表读取认证信息，不再查 account_auth 表
async function getAccountAuth(env, accountId) {
    return await env.DB.prepare("SELECT client_id, client_secret, refresh_token FROM accounts WHERE id = ?").bind(accountId).first();
}

async function getAccessToken(authData) {
    if (!authData || !authData.refresh_token) {
        throw new Error("Missing Refresh Token");
    }
    // 兼容旧数据逻辑，如果没ID/Secret则尝试直接用 Token
    if (!authData.client_id || !authData.client_secret) {
        return authData.refresh_token; 
    }

    try {
        const params = new URLSearchParams();
        params.append('client_id', authData.client_id);
        params.append('client_secret', authData.client_secret);
        params.append('refresh_token', authData.refresh_token);
        params.append('grant_type', 'refresh_token');

        const resp = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString()
        });

        if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(`OAuth2 Refresh Failed: ${resp.status} - ${errText}`);
        }

        const data = await resp.json();
        return data.access_token;
    } catch (e) {
        console.error("Token refresh failed:", e.message);
        throw e; 
    }
}

// --- 核心业务逻辑 ---

async function executeSendEmail(env, account, toEmail, subject, content, mode) {
    const finalSubject = subject ? subject : "Remind";
    const finalContent = content ? content : "Reminder of current time: " + new Date().toUTCString();

    try {
        let useMode = mode; 
        
        if (!useMode || useMode === 'AUTO') {
            // [修改] 直接检查 account 对象本身是否有 API 凭据
            if (account.refresh_token) {
                useMode = 'API';
            } else {
                useMode = 'GAS';
            }
        }

        if (useMode === 'API') {
            // [修改] 直接复用 account 对象或重新查询(这里保持一致性重新查询最稳)
            const authData = await getAccountAuth(env, account.id);
            if (!authData || !authData.refresh_token) {
                throw new Error("无 API 配置数据 (No Auth Data)");
            }
            
            const accessToken = await getAccessToken(authData);

            const emailLines = [];
            emailLines.push(`To: ${toEmail}`);
            emailLines.push(`Subject: =?UTF-8?B?${btoa(unescape(encodeURIComponent(finalSubject)))}?=`);
            emailLines.push(`Content-Type: text/plain; charset="UTF-8"`);
            emailLines.push(``);
            emailLines.push(finalContent);
            
            const raw = btoa(unescape(encodeURIComponent(emailLines.join('\r\n'))))
                        .replace(/\+/g, '-')
                        .replace(/\//g, '_')
                        .replace(/=+$/, '');

            const resp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/send`, {
                method: 'POST',
                headers: { 
                    'Authorization': `Bearer ${accessToken}`, 
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ raw: raw })
            });

            if (!resp.ok) {
                const err = await resp.json();
                throw new Error(`API Error: ${err.error?.message || 'Unknown'}`);
            }
            return { success: true };
            
        } else {
            let scriptUrl = account.script_url ? account.script_url.trim() : '';
            
            if (!scriptUrl.startsWith("http")) {
                throw new Error("当前账号无有效的 GAS URL，无法使用 GAS 发送");
            }

            if (scriptUrl.includes('?')) {
                if (!scriptUrl.endsWith('&')) scriptUrl += '&';
            } else {
                scriptUrl += '?';
            }

            const params = new URLSearchParams();
            params.append('action', 'send'); 
            params.append('to', toEmail);
            params.append('subject', finalSubject); 
            params.append('body', finalContent);    

            const resp = await fetch(scriptUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: params.toString()
            });
            
            const text = await resp.text();
            
            if (!resp.ok) throw new Error(`GAS HTTP Error: ${resp.status}`);
            if (text.trim().startsWith("<")) throw new Error("GAS返回了HTML。请检查URL是否正确");
            
            if (text.includes("OK") || text.includes("Sent") || text.includes("成功")) return { success: true };
            
            try {
                const json = JSON.parse(text);
                if (json.result === 'success' || json.status === 'success') return { success: true };
                else throw new Error(`GAS Refused: ${json.message || json.error || '未知错误'}`);
            } catch (e) {
                if (!text.includes("OK") && !text.includes("Sent")) {
                    if (e.message.startsWith("GAS Refused")) throw e;
                    throw new Error(`GAS Response Invalid: ${text.substring(0, 50)}...`);
                }
                return { success: true };
            }
        }
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function findBestAccount(env, referenceAccountId, mode) {
    const refAccount = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(referenceAccountId).first();
    if (!refAccount) throw new Error("Reference account not found");

    const { results: allAccounts } = await env.DB.prepare("SELECT * FROM accounts WHERE name = ? AND status = 1").bind(refAccount.name).all();
    
    let targetAccount = null;

    // 此处 type 字段在数据库里虽然有 API/GAS 标识，但因为是单表，我们也可以直接根据字段内容判断
    if (mode === 'API') {
        targetAccount = allAccounts.find(a => a.type.includes('API') || a.refresh_token);
        if (!targetAccount) throw new Error(`No API account found for ${refAccount.name}`);
    } else if (mode === 'GAS') {
        targetAccount = allAccounts.find(a => a.type.includes('GAS') || a.script_url);
        if (!targetAccount) throw new Error(`No GAS account found for ${refAccount.name}`);
    } else {
        // Auto
        targetAccount = allAccounts.find(a => a.type.includes('API') || a.refresh_token);
        if (!targetAccount) {
            targetAccount = allAccounts.find(a => a.type.includes('GAS') || a.script_url);
        }
        if (!targetAccount) throw new Error(`No available account (API or GAS) for ${refAccount.name}`);
    }

    return targetAccount;
}

async function syncEmails(env, accountId, mode, limit = 5) {
    const account = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(accountId).first();
    if (!account) throw new Error("Account not found");

    let messages = [];

    // [修改] 简化判断逻辑：基于是否有值
    const hasGas = !!account.script_url;
    const hasApi = !!account.refresh_token;

    const useGas = (mode === 'GAS') || (!mode && hasGas && !hasApi) || (!mode && !hasApi && hasGas);
    const useApi = (mode === 'API') || (!mode && hasApi); // 默认优先 API

    if (useGas && hasGas) {
        let scriptUrl = account.script_url.trim();
        if (scriptUrl.includes('?')) {
             if (!scriptUrl.endsWith('&')) scriptUrl += '&';
        } else {
             scriptUrl += '?';
        }

        const params = new URLSearchParams();
        params.append('action', 'get'); 
        params.append('limit', '5');
        if (!scriptUrl.includes('token=')) params.append('token', '123456'); 

        const resp = await fetch(scriptUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString()
        });

        if (!resp.ok) throw new Error("GAS Network Error: " + resp.status);
        
        const text = await resp.text();
        let json;
        try { json = JSON.parse(text); } catch (e) { throw new Error("GAS Response Invalid JSON: " + text.substring(0, 50)); }

        if (Array.isArray(json)) {
            messages = json.map(item => {
                const dateTs = new Date(item.date).getTime();
                const fakeId = 'gas_' + dateTs + '_' + btoa(encodeURIComponent(item.subject || '')).substring(0, 10);
                return {
                    id_str: fakeId,
                    sender: item.from,
                    subject: item.subject,
                    body: item.snippet,
                    date: dateTs
                };
            });
        } 
        else if (json.status === 'success' && Array.isArray(json.data)) {
            messages = json.data.map(item => ({
                id_str: item.id_str || ('gas_' + new Date(item.date).getTime()),
                sender: item.sender || item.from,
                subject: item.subject,
                body: item.body || item.snippet,
                date: item.date
            }));
        }
        else if (json.status === 'error') {
            throw new Error("GAS Error: " + json.message);
        }

    } 
    else if (useApi && hasApi) {
        const authData = await getAccountAuth(env, account.id);
        if (!authData) throw new Error("No Auth Data found for API fetch");

        const accessToken = await getAccessToken(authData);

        const q = encodeURIComponent("label:inbox OR label:spam");
        const listResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${limit}&q=${q}`, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        
        if (!listResp.ok) throw new Error("Gmail API List Failed: " + listResp.status);
        const listData = await listResp.json();
        
        if (listData.messages) {
            for (const msgItem of listData.messages) {
                const detailResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgItem.id}`, {
                    headers: { 'Authorization': `Bearer ${accessToken}` }
                });
                if (detailResp.ok) {
                    const detail = await detailResp.json();
                    let subject = '(No Subject)';
                    let sender = 'Unknown';
                    const headers = detail.payload.headers || [];
                    headers.forEach(h => {
                        if (h.name === 'Subject') subject = h.value;
                        if (h.name === 'From') sender = h.value;
                    });
                    messages.push({
                        id_str: msgItem.id,
                        sender: sender,
                        subject: subject,
                        body: detail.snippet || '(No Content)',
                        date: parseInt(detail.internalDate || Date.now())
                    });
                }
            }
        }
    }

    if (messages.length === 0) return 0;
    
    return messages.map(msg => ({
      id_str: msg.id_str,
      sender: msg.sender,
      subject: msg.subject,
      body: msg.body,
      received_at: msg.date 
  }));
}

// --- 路由处理 ---

async function handleRules(req, env) {
    const url = new URL(req.url);
    const method = req.method;

    if (method === 'GET') {
        if (url.pathname === '/api/rules/export') {
            const { results } = await env.DB.prepare('SELECT * FROM access_rules ORDER BY id DESC').all();
            const csvHeader = "ID,Name,Alias,QueryCode,FetchLimit,ValidUntil,MatchSender,MatchReceiver,MatchBody\n";
            const csvBody = results.map(r => 
                `"${r.id}","${r.name}","${r.alias}","${r.query_code}","${r.fetch_limit||''}","${r.valid_until||''}","${r.match_sender||''}","${r.match_receiver||''}","${r.match_body||''}"`
            ).join('\n');
            return new Response(csvHeader + csvBody, { headers: { "Content-Type": "text/csv;charset=UTF-8", "Content-Disposition": "attachment; filename=rules.csv" } });
        }
        const { results } = await env.DB.prepare('SELECT * FROM access_rules ORDER BY id DESC').all();
        return new Response(JSON.stringify(results), { headers: corsHeaders() });
    }

    if (method === 'POST') {
        if (url.pathname === '/api/rules/import') {
            const data = await req.json();
            if (!Array.isArray(data)) return new Response("Invalid data", { status: 400 });
            let count = 0;
            for (const item of data) {
                const code = item.query_code || generateQueryCode(); 
                await env.DB.prepare(`
                    INSERT INTO access_rules (name, alias, query_code, fetch_limit, valid_until, match_sender, match_receiver, match_body)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `).bind(item.name, item.alias, code, item.fetch_limit, item.valid_until, item.match_sender, item.match_receiver, item.match_body).run();
                count++;
            }
            return new Response(JSON.stringify({ success: true, count }), { headers: corsHeaders() });
        }

        const data = await req.json();
        if (!data.name || !data.alias) return new Response(JSON.stringify({ error: "Name/Alias required" }), { status: 400, headers: corsHeaders() });
        
        let code = data.query_code;
        if (!code) code = generateQueryCode(); 
        
        if (!data.id) {
             const existing = await env.DB.prepare('SELECT id FROM access_rules WHERE query_code = ?').bind(code).first();
             if (existing) return new Response(JSON.stringify({ error: "查询码已存在，请更换" }), { status: 400, headers: corsHeaders() });
        }

        if (data.id) {
            await env.DB.prepare(`UPDATE access_rules SET name=?, alias=?, query_code=?, fetch_limit=?, valid_until=?, match_sender=?, match_receiver=?, match_body=? WHERE id=?`)
                .bind(data.name, data.alias, code, data.fetch_limit, data.valid_until, data.match_sender, data.match_receiver, data.match_body, data.id).run();
        } else {
            await env.DB.prepare(`INSERT INTO access_rules (name, alias, query_code, fetch_limit, valid_until, match_sender, match_receiver, match_body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
                .bind(data.name, data.alias, code, data.fetch_limit, data.valid_until, data.match_sender, data.match_receiver, data.match_body).run();
        }
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders() });
    }

    if (method === 'DELETE') {
        const ids = await req.json();
        if (!Array.isArray(ids)) return new Response("Invalid IDs", { status: 400 });
        const placeholders = ids.map(() => '?').join(',');
        await env.DB.prepare(`DELETE FROM access_rules WHERE id IN (${placeholders})`).bind(...ids).run();
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders() });
    }
    return new Response("OK", { headers: corsHeaders() });
}

async function handleAccounts(req, env) {
  const method = req.method;
  const url = new URL(req.url);
  
  // === GET 请求 (查询) ===
  if (method === 'GET') {
    const type = url.searchParams.get('type'); 
    
    // 1. 简易模式
    if (type === 'simple') {
        const { results } = await env.DB.prepare(
            "SELECT id, name, alias FROM accounts ORDER BY id DESC"
        ).all();
        return new Response(JSON.stringify(results), { headers: corsHeaders() });
    }

    // 2. 导出模式 (全部数据，已不需要 JOIN)
    if (type === 'export') {
        const { results } = await env.DB.prepare(`
            SELECT * FROM accounts ORDER BY id DESC
        `).all();
        return new Response(JSON.stringify(results), { headers: corsHeaders() });
    }

    // 3. 默认分页模式 (已移除 JOIN)
    const page = parseInt(url.searchParams.get('page')) || 1;
    const limit = parseInt(url.searchParams.get('limit')) || 50;
    const q = url.searchParams.get('q') || '';

    let whereClause = "";
    let params = [];
    
    if (q) {
        whereClause = "WHERE name LIKE ? OR alias LIKE ?";
        params.push(`%${q}%`, `%${q}%`);
    }

    const countStmt = `SELECT COUNT(*) as total FROM accounts ${whereClause}`;
    const totalResult = await env.DB.prepare(countStmt).bind(...params).first();
    const total = totalResult.total;

    const sql = `
        SELECT * FROM accounts 
        ${whereClause} 
        ORDER BY id DESC 
        LIMIT ? OFFSET ?
    `;
    params.push(limit, (page - 1) * limit);

    const { results } = await env.DB.prepare(sql).bind(...params).all();

    return new Response(JSON.stringify({
        data: results,
        total: total,
        page: page,
        limit: limit,
        total_pages: Math.ceil(total / limit)
    }), { headers: corsHeaders() });
  } 
  
  // === POST 请求：添加账号 (修复逻辑，直接存入 accounts) ===
  if (method === 'POST') {
    const data = await req.json();

    // === 批量导入 ===
    if (Array.isArray(data)) {
        let imported = 0;
        let skipped = 0;
        for (const acc of data) {
            if (!acc.name) continue;
            const exists = await env.DB.prepare("SELECT 1 FROM accounts WHERE name = ?").bind(acc.name).first();
            if (exists) { skipped++; continue; }

            const apiConfig = acc.api_config || (acc.script_url && acc.script_url.includes(',') ? acc.script_url : null);
            const gasUrl = acc.gas_url || (acc.script_url && acc.script_url.startsWith('http') ? acc.script_url : null);
            
            const storedUrl = (acc.type === 'API') ? 'Using DB Auth (Imported)' : (gasUrl || '');
            
            // 解析 API 凭据
            let cId=null, cSec=null, rTok=null;
            if (apiConfig) {
                 if(apiConfig.includes(',')) {
                     const parts = apiConfig.split(',').map(s=>s.trim());
                     if(parts.length >= 3) { cId=parts[0]; cSec=parts[1]; rTok=parts[2]; }
                 } else if (apiConfig.length > 20) {
                     rTok = apiConfig.trim();
                 }
            }

            await env.DB.prepare(
                "INSERT INTO accounts (name, alias, type, script_url, client_id, client_secret, refresh_token, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
            ).bind(acc.name, acc.alias || '', acc.type || 'API', storedUrl, cId, cSec, rTok, 1).run();

            imported++;
        }
        return new Response(JSON.stringify({ ok: true, imported, skipped }), { headers: corsHeaders() });
    }

    // === 单个添加 ===
    const rawApiConfig = data.api_config || (data.script_url && data.script_url.includes(',') ? data.script_url : null);
    const rawGasUrl = data.gas_url || (data.script_url && !data.script_url.includes(',') ? data.script_url : null);
    
    let storedUrl = '';
    if (data.type === 'API') {
        storedUrl = 'Using DB Auth (Secure)';
    } else {
        storedUrl = rawGasUrl || ''; 
    }

    let cId=null, cSec=null, rTok=null;
    if (rawApiConfig) {
         if(rawApiConfig.includes(',')) {
             const parts = rawApiConfig.split(',').map(s=>s.trim());
             if(parts.length >= 3) { cId=parts[0]; cSec=parts[1]; rTok=parts[2]; }
         } else if (rawApiConfig.length > 20) {
             rTok = rawApiConfig.trim();
         }
    }

    await env.DB.prepare("INSERT INTO accounts (name, alias, type, script_url, client_id, client_secret, refresh_token, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(data.name, data.alias, data.type, storedUrl, cId, cSec, rTok, data.status ? 1 : 0).run();
            
    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
  }

  // === PUT 请求：更新账号 (修复逻辑，直接存入 accounts) ===
  if (method === 'PUT') {
    const data = await req.json();
    
    const rawApiConfig = data.api_config || (data.script_url && data.script_url.includes(',') ? data.script_url : null);
    const rawGasUrl = data.gas_url || (data.script_url && !data.script_url.includes(',') ? data.script_url : null);
    
    let storedUrl = '';
    if (data.type === 'API') {
         storedUrl = 'Using DB Auth (Updated)';
    } else {
         storedUrl = rawGasUrl || ''; 
    }

    let cId=null, cSec=null, rTok=null;
    if (rawApiConfig) {
         if(rawApiConfig.includes(',')) {
             const parts = rawApiConfig.split(',').map(s=>s.trim());
             if(parts.length >= 3) { cId=parts[0]; cSec=parts[1]; rTok=parts[2]; }
         } else if (rawApiConfig.length > 20) {
             rTok = rawApiConfig.trim();
         }
    }

    await env.DB.prepare("UPDATE accounts SET name=?, alias=?, type=?, script_url=?, client_id=?, client_secret=?, refresh_token=?, status=? WHERE id=?")
      .bind(data.name, data.alias, data.type, storedUrl, cId, cSec, rTok, data.status ? 1 : 0, data.id).run();
    
    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
  }

  if (method === 'DELETE') {
    const id = url.searchParams.get('id');
    const ids = url.searchParams.get('ids'); 
    if (ids) {
        const idList = ids.split(',').map(Number);
        // [修改] 只删除 accounts 表
        await env.DB.prepare(`DELETE FROM accounts WHERE id IN (${ids})`).run();
    } else if (id) {
        await env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(id).run();
    }
    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
  }
  
  return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
}

async function handleTasks(req, env) {
  const method = req.method;
  const url = new URL(req.url);

  if (method === 'POST') {
    const data = await req.json();
    
    if (Array.isArray(data)) {
         const stmt = env.DB.prepare(`
            INSERT INTO send_tasks (account_id, to_email, subject, content, base_date, delay_config, next_run_at, is_loop, status, execution_mode)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
         `);
         const batch = data.map(t => {
            let nextRun = Date.now();
            if (t.base_date) {
                nextRun = new Date(t.base_date).getTime();
            } else {
                nextRun = calculateNextRun(Date.now(), t.delay_config);
            }
            return stmt.bind(t.account_id, t.to_email, t.subject, t.content, t.base_date, t.delay_config, nextRun, t.is_loop, t.execution_mode || 'AUTO');
         });
         await env.DB.batch(batch);
         return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
    }

    const mode = data.execution_mode || 'AUTO';

    if (data.immediate) {
        try {
            const account = await findBestAccount(env, data.account_id, mode);
            const result = await executeSendEmail(env, account, data.to_email, data.subject, data.content, mode);
            return new Response(JSON.stringify({ ok: result.success, error: result.error }), { headers: corsHeaders() });
        } catch (e) {
            return new Response(JSON.stringify({ ok: false, error: e.message }), { headers: corsHeaders() });
        }
    }
    
    let nextRun = Date.now();
    if (data.base_date) {
        nextRun = new Date(data.base_date).getTime();
    } else {
        nextRun = calculateNextRun(Date.now(), data.delay_config);
    }

    await env.DB.prepare(`
      INSERT INTO send_tasks (account_id, to_email, subject, content, base_date, delay_config, next_run_at, is_loop, status, execution_mode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).bind(data.account_id, data.to_email, data.subject, data.content, data.base_date, data.delay_config, nextRun, data.is_loop, mode).run();
    
    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
  }
  
  if (method === 'PUT') {
      const data = await req.json();
      
      if (data.action === 'execute') {
          const task = await env.DB.prepare("SELECT * FROM send_tasks WHERE id = ?").bind(data.id).first();
          if(task) {
              try {
                  const mode = task.execution_mode || 'AUTO';
                  const account = await findBestAccount(env, task.account_id, mode);
                  const res = await executeSendEmail(env, account, task.to_email, task.subject, task.content, mode);
                  
                  if (res.success) {
                       await env.DB.prepare("UPDATE send_tasks SET status = 'success', success_count = IFNULL(success_count, 0) + 1 WHERE id = ?").bind(task.id).run();
                       return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
                  } else {
                       await env.DB.prepare("UPDATE send_tasks SET status = 'error', fail_count = IFNULL(fail_count, 0) + 1 WHERE id = ?").bind(task.id).run();
                       return new Response(JSON.stringify({ ok: false, error: res.error }), { headers: corsHeaders() });
                  }
              } catch(e) {
                  await env.DB.prepare("UPDATE send_tasks SET status = 'error', fail_count = IFNULL(fail_count, 0) + 1 WHERE id = ?").bind(task.id).run();
                  return new Response(JSON.stringify({ ok: false, error: e.message }), { headers: corsHeaders() });
              }
          }
          return new Response(JSON.stringify({ ok: false, error: "Task not found" }), { headers: corsHeaders() });
      }

      if (data.id) {
          let nextRun = Date.now();
          if (data.base_date) {
              nextRun = new Date(data.base_date).getTime();
          } else {
               nextRun = calculateNextRun(Date.now(), data.delay_config);
          }
          
          await env.DB.prepare(`
            UPDATE send_tasks 
            SET account_id=?, to_email=?, subject=?, content=?, base_date=?, delay_config=?, is_loop=?, execution_mode=?, next_run_at=? 
            WHERE id=?
          `).bind(data.account_id, data.to_email, data.subject, data.content, data.base_date, data.delay_config, data.is_loop, data.execution_mode, nextRun, data.id).run();
          return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
      }
  }

  if (method === 'DELETE') {
    const id = url.searchParams.get('id');
    const ids = url.searchParams.get('ids');
    if (ids) {
        const idList = ids.split(',').map(Number);
        const stmt = env.DB.prepare("DELETE FROM send_tasks WHERE id = ?");
        await env.DB.batch(idList.map(i => stmt.bind(i)));
    } else if (id) {
        await env.DB.prepare("DELETE FROM send_tasks WHERE id = ?").bind(id).run();
    }
    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
  }

  // === GET 请求 (查询任务) ===
  if (method === 'GET') {
     const page = parseInt(url.searchParams.get('page')) || 1;
     const limit = parseInt(url.searchParams.get('limit')) || 50;
     const q = url.searchParams.get('q') || '';

     let whereClause = "";
     let params = [];

     if (q) {
         // 注意：因为我们要搜 accounts.name，所以下面必须先 LEFT JOIN
         whereClause = "WHERE send_tasks.subject LIKE ? OR send_tasks.to_email LIKE ? OR accounts.name LIKE ?";
         params.push(`%${q}%`, `%${q}%`, `%${q}%`);
     }

     const countStmt = `
         SELECT COUNT(*) as total 
         FROM send_tasks 
         LEFT JOIN accounts ON send_tasks.account_id = accounts.id
         ${whereClause}
     `;
     const totalResult = await env.DB.prepare(countStmt).bind(...params).first();
     const total = totalResult.total;

     const sql = `
        SELECT send_tasks.*, accounts.name as account_name 
        FROM send_tasks 
        LEFT JOIN accounts ON send_tasks.account_id = accounts.id
        ${whereClause} 
        ORDER BY send_tasks.next_run_at ASC 
        LIMIT ? OFFSET ?
     `;
     
     params.push(limit, (page - 1) * limit);

     const { results } = await env.DB.prepare(sql).bind(...params).all();

     return new Response(JSON.stringify({
         data: results,
         total: total,
         page: page,
         limit: limit,
         total_pages: Math.ceil(total / limit)
     }), { headers: corsHeaders() });
  }
  
  return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
}

async function handleEmails(req, env) {
   const url = new URL(req.url);
   const method = req.method;

   if (method === 'POST') {
      return new Response(JSON.stringify({ ok: true, count: 0 }), { headers: corsHeaders() });
  }
  
  // 实时获取模式
  if (method === 'GET') {
      let limit = parseInt(url.searchParams.get('limit'));
      if (!limit || limit <= 0) limit = 20; 
      
      const accountId = url.searchParams.get('account_id');
      const mode = url.searchParams.get('mode');

      if (accountId) {
          try {
              const results = await syncEmails(env, accountId, mode, limit);
              return new Response(JSON.stringify(results), { headers: corsHeaders() });
          } catch (e) {
              return new Response(JSON.stringify({ error: e.message }), { headers: corsHeaders() });
          }
      } else {
          return new Response(JSON.stringify([]), { headers: corsHeaders() });
      }
  }
   
   return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
}

async function processScheduledTasks(env) {
    const now = Date.now();
    const { results } = await env.DB.prepare("SELECT * FROM send_tasks WHERE status = 'pending' AND next_run_at <= ?").bind(now).all();
    
    for (const task of results) {
        try {
            const mode = task.execution_mode || 'AUTO';
            const account = await findBestAccount(env, task.account_id, mode);
            const res = await executeSendEmail(env, account, task.to_email, task.subject, task.content, mode);
            
            if(!res.success) {
                 await env.DB.prepare("UPDATE send_tasks SET status = 'error', fail_count = IFNULL(fail_count, 0) + 1 WHERE id = ?").bind(task.id).run();
                 continue;
            }
        } catch (e) {
            console.error(`Task ${task.id} failed:`, e);
            await env.DB.prepare("UPDATE send_tasks SET status = 'error', fail_count = IFNULL(fail_count, 0) + 1 WHERE id = ?").bind(task.id).run();
            continue;
        }

        if (task.is_loop) {
            let nextRun = calculateNextRun(Date.now(), task.delay_config);
            await env.DB.prepare("UPDATE send_tasks SET next_run_at = ?, success_count = IFNULL(success_count, 0) + 1 WHERE id = ?").bind(nextRun, task.id).run();
        } else {
            await env.DB.prepare("UPDATE send_tasks SET status = 'success', success_count = IFNULL(success_count, 0) + 1 WHERE id = ?").bind(task.id).run();
        }
    }
}
