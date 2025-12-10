/**
 * worker.js
 * 绑定变量: DB (D1 Database), ADMIN_USERNAME, ADMIN_PASSWORD
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
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

    // 2. 身份验证
    const authHeader = request.headers.get("Authorization");
    if (!checkAuth(authHeader, env)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders() });
    }

    // 3. API 路由
    if (url.pathname.startsWith('/api/accounts')) return handleAccounts(request, env);
    if (url.pathname.startsWith('/api/tasks')) return handleTasks(request, env);
    if (url.pathname.startsWith('/api/emails')) return handleEmails(request, env);
    
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

function calculateDelay(configStr) {
    let min = 0, max = 0;
    if (configStr && configStr.includes('-')) {
        [min, max] = configStr.split('-').map(Number);
    } else {
        min = max = Number(configStr || 0);
    }
    const days = Math.floor(Math.random() * (max - min + 1)) + min;
    return days * 24 * 60 * 60 * 1000; 
}

// --- 核心业务逻辑 ---

// 1. 发送邮件核心函数
async function executeSendEmail(account, toEmail, subject, content) {
    // 默认值处理
    const finalSubject = subject ? subject : "Remind";
    const finalContent = content ? content : "Reminder of current time: " + new Date().toUTCString();

    try {
        if (account.type === 'GAS') {
            // === URL 智能修正逻辑 ===
            let scriptUrl = account.script_url.trim();
            if (scriptUrl.includes('?')) {
                if (!scriptUrl.endsWith('&')) scriptUrl += '&';
            } else {
                scriptUrl += '?';
            }

            // === 发送表单数据 ===
            const params = new URLSearchParams();
            params.append('action', 'send'); 
            params.append('to', toEmail);
            params.append('subject', finalSubject); 
            params.append('body', finalContent);    

            const resp = await fetch(scriptUrl, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/x-www-form-urlencoded' 
                },
                body: params.toString()
            });
            
            const text = await resp.text();
            
            // HTTP 状态检查
            if (!resp.ok) throw new Error(`GAS HTTP Error: ${resp.status}`);
            
            // HTML 返回检查
            if (text.trim().startsWith("<")) {
                throw new Error("GAS返回了HTML。请检查：1.部署权限是否为'任何人'; 2.URL是否正确");
            }
            
            // JSON/文本 逻辑检查
            try {
                if (text.includes("OK") || text.includes("Sent") || text.includes("成功")) {
                    return { success: true };
                }

                const json = JSON.parse(text);
                if (json.result === 'success' || json.status === 'success') {
                    return { success: true };
                } else {
                    throw new Error(`GAS Refused: ${json.message || json.error || '未知错误'}`);
                }
            } catch (e) {
                if (!text.includes("OK") && !text.includes("Sent") && !text.includes("成功")) {
                    if (e.message.startsWith("GAS Refused")) throw e;
                    throw new Error(`GAS Response Invalid: ${text.substring(0, 50)}...`);
                }
                return { success: true };
            }

        } else if (account.type === 'API') {
            const token = account.script_url; 
            const emailLines = [];
            emailLines.push(`To: ${toEmail}`);
            emailLines.push(`Subject: =?UTF-8?B?${btoa(unescape(encodeURIComponent(finalSubject)))}?=`);
            emailLines.push(`Content-Type: text/plain; charset="UTF-8"`);
            emailLines.push(``);
            emailLines.push(finalContent);
            
            const emailBody = emailLines.join('\r\n');
            const raw = btoa(unescape(encodeURIComponent(emailBody)))
                        .replace(/\+/g, '-')
                        .replace(/\//g, '_')
                        .replace(/=+$/, '');

            const resp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/send`, {
                method: 'POST',
                headers: { 
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ raw: raw })
            });

            if (!resp.ok) {
                const err = await resp.json();
                throw new Error(`API Error: ${err.error?.message || 'Unknown'}`);
            }
            return { success: true };
        }
    } catch (e) {
        return { success: false, error: e.message };
    }
    return { success: false, error: "Unknown Account Type" };
}

// 2. 智能账号查找函数
async function findBestAccount(env, referenceAccountId, mode) {
    const refAccount = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(referenceAccountId).first();
    if (!refAccount) throw new Error("Reference account not found");

    const { results: allAccounts } = await env.DB.prepare("SELECT * FROM accounts WHERE name = ? AND status = 1").bind(refAccount.name).all();
    
    let targetAccount = null;

    if (mode === 'API') {
        targetAccount = allAccounts.find(a => a.type === 'API');
        if (!targetAccount) throw new Error(`No API account found for ${refAccount.name}`);
    } else if (mode === 'GAS') {
        targetAccount = allAccounts.find(a => a.type === 'GAS');
        if (!targetAccount) throw new Error(`No GAS account found for ${refAccount.name}`);
    } else {
        // AUTO: 优先 API
        targetAccount = allAccounts.find(a => a.type === 'API');
        if (!targetAccount) {
            targetAccount = allAccounts.find(a => a.type === 'GAS');
        }
        if (!targetAccount) throw new Error(`No available account (API or GAS) for ${refAccount.name}`);
    }

    return targetAccount;
}

// 3. [新增] 兼容型邮件同步函数 (支持 API 和 GAS 双模式)
async function syncEmails(env, accountId) {
    const account = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(accountId).first();
    if (!account) throw new Error("Account not found");

    let messages = [];

    // === GAS 模式处理 ===
    if (account.type === 'GAS') {
        let scriptUrl = account.script_url.trim();
        if (scriptUrl.includes('?')) {
             if (!scriptUrl.endsWith('&')) scriptUrl += '&';
        } else {
             scriptUrl += '?';
        }

        const params = new URLSearchParams();
        // 优先使用 'sync_inbox'，脚本不支持时会报错或回退（取决于脚本写法）
        // 为了兼容旧脚本习惯，也可以发 'get'，或者两个都发看脚本识别哪个
        // 这里使用 'sync_inbox' 以配合新脚本，如果新脚本兼容了 'get' 也可以改成 'get'
        params.append('action', 'get'); 
        params.append('limit', '5');
        
        // 自动补全 Token (如果 URL 里没带)
        // 假设您的 Token 是 123456，您可以硬编码在这里，或者从其他字段读取
        if (!scriptUrl.includes('token=')) {
             params.append('token', '123456'); 
        }

        const resp = await fetch(scriptUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString()
        });

        if (!resp.ok) throw new Error("GAS Network Error: " + resp.status);
        
        const text = await resp.text();
        let json;
        try {
            json = JSON.parse(text);
        } catch (e) {
            throw new Error("GAS Response Invalid JSON: " + text.substring(0, 50));
        }

        // --- 核心转换逻辑 ---
        
        // 情况 A: 脚本返回旧版数组 [ {"from":...}, ... ]
        if (Array.isArray(json)) {
            messages = json.map(item => {
                // 生成虚拟 ID (gas_时间戳_主题前10位Base64)
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
        // 情况 B: 脚本返回新版对象 { status: 'success', data: [...] }
        else if (json.status === 'success' && Array.isArray(json.data)) {
            messages = json.data.map(item => {
                // 如果 data 里有些字段名是旧的 (from/snippet)，也兼容一下
                return {
                    id_str: item.id_str || ('gas_' + new Date(item.date).getTime()),
                    sender: item.sender || item.from,
                    subject: item.subject,
                    body: item.body || item.snippet,
                    date: item.date
                };
            });
        }
        else if (json.status === 'error') {
            throw new Error("GAS Error: " + json.message);
        }
    } 
    // === API 模式处理 ===
    else if (account.type === 'API') {
        const token = account.script_url;
        const listResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!listResp.ok) throw new Error("Gmail API List Failed: " + listResp.status);
        const listData = await listResp.json();
        
        if (listData.messages) {
            for (const msgItem of listData.messages) {
                const detailResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgItem.id}`, {
                    headers: { 'Authorization': `Bearer ${token}` }
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
                        date: Date.now()
                    });
                }
            }
        }
    }

    // === 入库逻辑 ===
    if (messages.length === 0) return 0;
    
    let syncCount = 0;
    for (const msg of messages) {
        // 查重 (防止重复收取)
        const exists = await env.DB.prepare("SELECT id FROM received_emails WHERE id_str = ?").bind(msg.id_str).first();
        if (exists) continue;

        await env.DB.prepare(`
            INSERT INTO received_emails (account_id, sender, subject, body, received_at, id_str)
            VALUES (?, ?, ?, ?, ?, ?)
        `).bind(accountId, msg.sender, msg.subject, msg.body, msg.date, msg.id_str).run();
        
        syncCount++;
    }

    return syncCount;
}

// --- 路由处理 ---

async function handleAccounts(req, env) {
  const method = req.method;
  const url = new URL(req.url);
  
  if (method === 'GET') {
    const { results } = await env.DB.prepare("SELECT * FROM accounts ORDER BY id DESC").all();
    return new Response(JSON.stringify(results), { headers: corsHeaders() });
  } 
  
  if (method === 'POST') {
    const data = await req.json();
    if (Array.isArray(data)) {
        const stmt = env.DB.prepare("INSERT INTO accounts (name, alias, type, script_url, status) VALUES (?, ?, ?, ?, ?)");
        const batch = data.map(acc => stmt.bind(acc.name, acc.alias, acc.type, acc.script_url, acc.status ? 1 : 0));
        await env.DB.batch(batch);
        return new Response(JSON.stringify({ ok: true, count: data.length }), { headers: corsHeaders() });
    }
    
    await env.DB.prepare("INSERT INTO accounts (name, alias, type, script_url, status) VALUES (?, ?, ?, ?, ?)")
      .bind(data.name, data.alias, data.type, data.script_url, data.status ? 1 : 0).run();
    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
  }

  if (method === 'PUT') {
    const data = await req.json();
    await env.DB.prepare("UPDATE accounts SET name=?, alias=?, type=?, script_url=?, status=? WHERE id=?")
      .bind(data.name, data.alias, data.type, data.script_url, data.status ? 1 : 0, data.id).run();
    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
  }

  if (method === 'DELETE') {
    const id = url.searchParams.get('id');
    const ids = url.searchParams.get('ids'); 
    
    if (ids) {
        const idList = ids.split(',').map(Number);
        const stmt = env.DB.prepare("DELETE FROM accounts WHERE id = ?");
        await env.DB.batch(idList.map(i => stmt.bind(i)));
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
            if (t.base_date) nextRun = new Date(t.base_date).getTime();
            if (t.delay_config) nextRun += calculateDelay(t.delay_config);
            return stmt.bind(t.account_id, t.to_email, t.subject, t.content, t.base_date, t.delay_config, nextRun, t.is_loop, t.execution_mode || 'AUTO');
         });
         await env.DB.batch(batch);
         return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
    }

    const mode = data.execution_mode || 'AUTO';

    if (data.immediate) {
        try {
            const account = await findBestAccount(env, data.account_id, mode);
            const result = await executeSendEmail(account, data.to_email, data.subject, data.content);
            return new Response(JSON.stringify({ ok: result.success, error: result.error }), { headers: corsHeaders() });
        } catch (e) {
            return new Response(JSON.stringify({ ok: false, error: e.message }), { headers: corsHeaders() });
        }
    }
    
    let nextRun = Date.now();
    if (data.base_date) nextRun = new Date(data.base_date).getTime();
    if (data.delay_config) nextRun += calculateDelay(data.delay_config);

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
                  const res = await executeSendEmail(account, task.to_email, task.subject, task.content);
                  
                  if (res.success) {
                       await env.DB.prepare("UPDATE send_tasks SET status = 'success' WHERE id = ?").bind(task.id).run();
                       return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
                  } else {
                       return new Response(JSON.stringify({ ok: false, error: res.error }), { headers: corsHeaders() });
                  }
              } catch(e) {
                  return new Response(JSON.stringify({ ok: false, error: e.message }), { headers: corsHeaders() });
              }
          }
          return new Response(JSON.stringify({ ok: false, error: "Task not found" }), { headers: corsHeaders() });
      }

      if (data.id) {
          let nextRun = Date.now();
          if (data.base_date) nextRun = new Date(data.base_date).getTime();
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

  if (method === 'GET') {
     const { results } = await env.DB.prepare("SELECT * FROM send_tasks ORDER BY next_run_at ASC LIMIT 100").all();
     return new Response(JSON.stringify(results), { headers: corsHeaders() });
  }
  
  return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
}

// 4. [修改后] 支持 POST 同步的 handleEmails
async function handleEmails(req, env) {
   const url = new URL(req.url);
   const method = req.method;

   // === A. POST 请求: 触发同步 (收取邮件) ===
   if (method === 'POST') {
       try {
           const data = await req.json();
           const accountId = data.account_id;
           if (!accountId) throw new Error("Missing account_id");

           // 调用同步函数
           const count = await syncEmails(env, accountId);
           return new Response(JSON.stringify({ ok: true, count: count }), { headers: corsHeaders() });
       } catch (e) {
           return new Response(JSON.stringify({ ok: false, error: e.message }), { headers: corsHeaders() });
       }
   }
   
   // === B. GET 请求: 读取数据库 ===
   if (method === 'GET') {
       let limit = parseInt(url.searchParams.get('limit'));
       if (!limit || limit <= 0) limit = 20; // 默认读取20条
       
       const accountId = url.searchParams.get('account_id');

       if (accountId) {
           const { results } = await env.DB.prepare(
               "SELECT * FROM received_emails WHERE account_id = ? ORDER BY received_at DESC LIMIT ?"
           ).bind(accountId, limit).all();
           return new Response(JSON.stringify(results), { headers: corsHeaders() });
       } else {
           const { results } = await env.DB.prepare(
               "SELECT * FROM received_emails ORDER BY received_at DESC LIMIT ?"
           ).bind(limit).all();
           return new Response(JSON.stringify(results), { headers: corsHeaders() });
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
            const res = await executeSendEmail(account, task.to_email, task.subject, task.content);
            
            if(!res.success) {
                 await env.DB.prepare("UPDATE send_tasks SET status = 'error' WHERE id = ?").bind(task.id).run();
                 continue;
            }
        } catch (e) {
            console.error(`Task ${task.id} failed:`, e);
            await env.DB.prepare("UPDATE send_tasks SET status = 'error' WHERE id = ?").bind(task.id).run();
            continue;
        }

        if (task.is_loop) {
            let nextRun = Date.now();
            if (task.delay_config) {
                nextRun += calculateDelay(task.delay_config);
            } else {
                nextRun += 24 * 60 * 60 * 1000;
            }
            await env.DB.prepare("UPDATE send_tasks SET next_run_at = ? WHERE id = ?").bind(nextRun, task.id).run();
        } else {
            await env.DB.prepare("UPDATE send_tasks SET status = 'success' WHERE id = ?").bind(task.id).run();
        }
    }
}
