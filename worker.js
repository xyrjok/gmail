/**
 * worker.js
 * 绑定变量: DB (D1 Database), ADMIN_USERNAME, ADMIN_PASSWORD
 * * 数据库变动提示:
 * 请务必在 D1 控制台执行: ALTER TABLE send_tasks ADD COLUMN execution_mode TEXT DEFAULT 'AUTO';
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

    // 2. 身份验证 (Basic Auth)
    const authHeader = request.headers.get("Authorization");
    if (!checkAuth(authHeader, env)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders() });
    }

    // 3. API 路由分发
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
    // 计算随机天数对应的毫秒数
    const days = Math.floor(Math.random() * (max - min + 1)) + min;
    return days * 24 * 60 * 60 * 1000; 
}

// --- 核心业务逻辑 ---

// 1. 发送邮件核心函数 (包含 GAS 检查和 API 实现)
async function executeSendEmail(account, toEmail, content) {
    try {
        if (account.type === 'GAS') {
            const resp = await fetch(account.script_url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ to: toEmail, subject: "Auto Mail", body: content })
            });
            
            // 增强检查：GAS 权限不足时会返回 200 OK 但内容是 HTML 登录页
            const text = await resp.text();
            if (!resp.ok) throw new Error(`GAS HTTP Error: ${resp.status}`);
            
            // 检查返回内容是否包含 HTML 标签
            if (text.trim().startsWith("<")) {
                throw new Error("GAS返回了HTML而非JSON。请检查脚本部署权限是否为'任何人(Anyone)'");
            }
            
            return { success: true };

        } else if (account.type === 'API') {
            // Gmail API 发送实现
            const token = account.script_url; // 假设 script_url 字段存的是 Token
            
            // 构建邮件内容 (处理中文编码)
            const emailBody = `To: ${toEmail}\r\n` +
                              `Subject: Auto Mail\r\n` +
                              `Content-Type: text/plain; charset="UTF-8"\r\n\r\n` +
                              content;
            
            // Base64URL 编码
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

// 2. 智能账号查找函数 (策略：AUTO / API / GAS)
async function findBestAccount(env, referenceAccountId, mode) {
    // 获取用户当前选择的账号作为基准 (为了拿到邮箱名)
    const refAccount = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(referenceAccountId).first();
    if (!refAccount) throw new Error("Reference account not found");

    // 找出所有同名邮箱 (不管类型)
    const { results: allAccounts } = await env.DB.prepare("SELECT * FROM accounts WHERE name = ? AND status = 1").bind(refAccount.name).all();
    
    let targetAccount = null;

    if (mode === 'API') {
        targetAccount = allAccounts.find(a => a.type === 'API');
        if (!targetAccount) throw new Error(`No API account found for ${refAccount.name}`);
    } else if (mode === 'GAS') {
        targetAccount = allAccounts.find(a => a.type === 'GAS');
        if (!targetAccount) throw new Error(`No GAS account found for ${refAccount.name}`);
    } else {
        // AUTO 模式 (默认): 优先 API，其次 GAS
        targetAccount = allAccounts.find(a => a.type === 'API');
        if (!targetAccount) {
            targetAccount = allAccounts.find(a => a.type === 'GAS');
        }
        if (!targetAccount) throw new Error(`No available account (API or GAS) for ${refAccount.name}`);
    }

    return targetAccount;
}

// --- 路由处理函数 ---

async function handleAccounts(req, env) {
  const method = req.method;
  const url = new URL(req.url);
  
  if (method === 'GET') {
    const { results } = await env.DB.prepare("SELECT * FROM accounts ORDER BY id DESC").all();
    return new Response(JSON.stringify(results), { headers: corsHeaders() });
  } 
  
  if (method === 'POST') { // 新增
    const data = await req.json();
    await env.DB.prepare("INSERT INTO accounts (name, alias, type, script_url, status) VALUES (?, ?, ?, ?, ?)")
      .bind(data.name, data.alias, data.type, data.script_url, data.status ? 1 : 0).run();
    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
  }

  if (method === 'PUT') { // 编辑
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

    // === 立即发送 ===
    if (data.immediate) {
        try {
            const account = await findBestAccount(env, data.account_id, mode);
            const result = await executeSendEmail(account, data.to_email, data.content);
            return new Response(JSON.stringify({ ok: result.success, error: result.error }), { headers: corsHeaders() });
        } catch (e) {
            return new Response(JSON.stringify({ ok: false, error: e.message }), { headers: corsHeaders() });
        }
    }
    
    // === 定时任务入库 ===
    let nextRun = Date.now();
    if (data.base_date) nextRun = new Date(data.base_date).getTime();
    if (data.delay_config) nextRun += calculateDelay(data.delay_config);

    await env.DB.prepare(`
      INSERT INTO send_tasks (account_id, to_email, content, base_date, delay_config, next_run_at, is_loop, status, execution_mode)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).bind(data.account_id, data.to_email, data.content, data.base_date, data.delay_config, nextRun, data.is_loop, mode).run();
    
    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
  }
  
  if (method === 'PUT') { // 手动触发待执行任务
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

// --- Cron 调度逻辑 ---

async function processScheduledTasks(env) {
    const now = Date.now();
    // 找出所有待执行的任务
    const { results } = await env.DB.prepare("SELECT * FROM send_tasks WHERE status = 'pending' AND next_run_at <= ?").bind(now).all();
    
    for (const task of results) {
        try {
            // 1. 智能查找账号
            const mode = task.execution_mode || 'AUTO';
            const account = await findBestAccount(env, task.account_id, mode);
            
            // 2. 执行发送
            const res = await executeSendEmail(account, task.to_email, task.content);
            
            // 发送失败处理
            if(!res.success) {
                 await env.DB.prepare("UPDATE send_tasks SET status = 'error' WHERE id = ?").bind(task.id).run();
                 continue; // 跳过后续循环更新逻辑
            }
        } catch (e) {
            console.error(`Task ${task.id} failed:`, e);
            await env.DB.prepare("UPDATE send_tasks SET status = 'error' WHERE id = ?").bind(task.id).run();
            continue;
        }

        // 3. 处理循环逻辑 (仅当发送成功时)
        if (task.is_loop) {
            let nextRun = Date.now();
            if (task.delay_config) {
                nextRun += calculateDelay(task.delay_config);
            } else {
                nextRun += 24 * 60 * 60 * 1000; // 默认一天
            }
            await env.DB.prepare("UPDATE send_tasks SET next_run_at = ? WHERE id = ?").bind(nextRun, task.id).run();
        } else {
            await env.DB.prepare("UPDATE send_tasks SET status = 'success' WHERE id = ?").bind(task.id).run();
        }
    }
}
