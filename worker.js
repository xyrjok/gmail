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

// 1. 发送邮件核心函数 (包含 URL 智能修正和 GAS 校验)
async function executeSendEmail(account, toEmail, content) {
    try {
        if (account.type === 'GAS') {
            // === URL 智能修正逻辑 ===
            // 用户要求：把带token和不带看成一个整体，后面自动添加后缀
            // 实现：
            // 1. 如果 URL 里没有 '?'，说明是纯链接，添加 '?' (符合 .../exec? 格式)
            // 2. 如果 URL 里已有 '?'，说明有 token，添加 '&' (符合 ...token=123& 格式，防止破坏 token 值)
            let scriptUrl = account.script_url.trim();
            if (scriptUrl.includes('?')) {
                if (!scriptUrl.endsWith('&')) scriptUrl += '&';
            } else {
                scriptUrl += '?';
            }

            const resp = await fetch(scriptUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ to: toEmail, subject: "Auto Mail", body: content })
            });
            
            const text = await resp.text();
            
            // HTTP 状态检查
            if (!resp.ok) throw new Error(`GAS HTTP Error: ${resp.status}`);
            
            // HTML 返回检查 (GAS 权限错误或 URL 错误通常返回 HTML)
            if (text.trim().startsWith("<")) {
                throw new Error("GAS返回了HTML。请检查：1.部署权限是否为'任何人'; 2.URL是否正确");
            }
            
            // JSON 逻辑检查
            try {
                const json = JSON.parse(text);
                if (json.result !== 'success') {
                    throw new Error(`GAS Refused: ${json.message || '未知错误'}`);
                }
            } catch (e) {
                if (e.message.startsWith("GAS Refused")) throw e;
                throw new Error(`GAS Response Invalid: ${text.substring(0, 50)}...`);
            }
            
            return { success: true };

        } else if (account.type === 'API') {
            const token = account.script_url; 
            const emailBody = `To: ${toEmail}\r\n` +
                              `Subject: Auto Mail\r\n` +
                              `Content-Type: text/plain; charset="UTF-8"\r\n\r\n` +
                              content;
            
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
    await env.DB.prepare("INSERT INTO accounts (name, alias, type, script_url, status) VALUES (?, ?, ?, ?, ?)")
      .bind(data.name, data.alias, data.type, data.script_url, data.status ? 1 : 0).run();
    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
  }

  if (method === 'PUT') {
    const data = await req.json();
    if (!data.id) return new Response(JSON.stringify({ error: "Missing ID" }), { status: 400, headers: corsHeaders() });
    
    await env.DB.prepare("UPDATE accounts SET name=?, alias=?, type=?, script_url=?, status=? WHERE id=?")
      .bind(data.name, data.alias, data.type, data.script_url, data.status ? 1 : 0, data.id).run();
    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
  }

  if (method === 'DELETE') {
    const id = url.searchParams.get('id');
    await env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(id).run();
    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
  }
  
  return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
}

async function handleTasks(req, env) {
  const method = req.method;
  
  if (method === 'POST') {
    const data = await req.json();
    const mode = data.execution_mode || 'AUTO';

    if (data.immediate) {
        try {
            const account = await findBestAccount(env, data.account_id, mode);
            const result = await executeSendEmail(account, data.to_email, data.content);
            return new Response(JSON.stringify({ ok: result.success, error: result.error }), { headers: corsHeaders() });
        } catch (e) {
            return new Response(JSON.stringify({ ok: false, error: e.message }), { headers: corsHeaders() });
        }
    }
    
    let nextRun = Date.now();
    if (data.base_date) nextRun = new Date(data.base_date).getTime();
    if (data.delay_config) nextRun += calculateDelay(data.delay_config);

    await env.DB.prepare(`
      INSERT INTO send_tasks (account_id, to_email, content, base_date, delay_config, next_run_at, is_loop, status, execution_mode)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).bind(data.account_id, data.to_email, data.content, data.base_date, data.delay_config, nextRun, data.is_loop, mode).run();
    
    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
  }
  
  if (method === 'PUT') {
      const data = await req.json();
      const task = await env.DB.prepare("SELECT * FROM send_tasks WHERE id = ?").bind(data.id).first();
      
      if(task) {
          try {
              const mode = task.execution_mode || 'AUTO';
              const account = await findBestAccount(env, task.account_id, mode);
              const res = await executeSendEmail(account, task.to_email, task.content);
              
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

  if (method === 'GET') {
     const { results } = await env.DB.prepare("SELECT * FROM send_tasks ORDER BY next_run_at ASC LIMIT 50").all();
     return new Response(JSON.stringify(results), { headers: corsHeaders() });
  }
  
  return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
}

async function handleEmails(req, env) {
   const { results } = await env.DB.prepare("SELECT * FROM received_emails ORDER BY received_at DESC LIMIT 50").all();
   return new Response(JSON.stringify(results), { headers: corsHeaders() });
}

async function processScheduledTasks(env) {
    const now = Date.now();
    const { results } = await env.DB.prepare("SELECT * FROM send_tasks WHERE status = 'pending' AND next_run_at <= ?").bind(now).all();
    
    for (const task of results) {
        try {
            const mode = task.execution_mode || 'AUTO';
            const account = await findBestAccount(env, task.account_id, mode);
            
            const res = await executeSendEmail(account, task.to_email, task.content);
            
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
