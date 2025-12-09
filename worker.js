/**
 * worker.js
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // CORS 处理
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // 鉴权
    const authHeader = request.headers.get("Authorization");
    if (!checkAuth(authHeader, env)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders() });
    }

    // 路由
    if (url.pathname.startsWith('/api/accounts')) return handleAccounts(request, env);
    if (url.pathname.startsWith('/api/tasks')) return handleTasks(request, env);
    if (url.pathname.startsWith('/api/emails')) return handleEmails(request, env);
    
    return new Response("Backend Active", { headers: corsHeaders() });
  },

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

// 核心：执行单次发送逻辑 (独立出来供立即发送和定时任务共用)
async function executeSendEmail(account, toEmail, content) {
    try {
        if (account.type === 'GAS') {
            const resp = await fetch(account.script_url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ to: toEmail, subject: "Auto Mail", body: content })
            });
            if(!resp.ok) throw new Error(`GAS Response: ${resp.status}`);
            return { success: true };
        } else if (account.type === 'API') {
            // 这里预留 Gmail API 逻辑，目前仅返回模拟成功
            // 真实环境需要处理 OAuth Token 刷新和 API 调用
            return { success: true, note: "API Logic Mocked" };
        }
    } catch (e) {
        return { success: false, error: e.message };
    }
    return { success: false, error: "Unknown Account Type" };
}

// --- 业务逻辑 ---

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

  if (method === 'PUT') { // 编辑 (新增的功能)
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

    // === 立即发送逻辑 (新增) ===
    if (data.immediate) {
        const account = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(data.account_id).first();
        if (!account) return new Response(JSON.stringify({ ok: false, error: "Account not found" }), { headers: corsHeaders() });

        const result = await executeSendEmail(account, data.to_email, data.content);
        
        // 可选：记录一条状态为 success/error 的任务记录用于日志查看，或者直接返回结果
        // 这里选择直接返回结果
        return new Response(JSON.stringify({ ok: result.success, error: result.error }), { headers: corsHeaders() });
    }
    
    // === 正常定时任务入库逻辑 ===
    let nextRun = Date.now();
    if (data.base_date) {
        nextRun = new Date(data.base_date).getTime();
    }
    if (data.delay_config) {
        nextRun += calculateDelay(data.delay_config);
    }

    await env.DB.prepare(`
      INSERT INTO send_tasks (account_id, to_email, content, base_date, delay_config, next_run_at, is_loop, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `).bind(data.account_id, data.to_email, data.content, data.base_date, data.delay_config, nextRun, data.is_loop).run();
    
    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
  }
  
  if (method === 'PUT') { // 手动触发待执行任务
      const data = await req.json();
      const task = await env.DB.prepare("SELECT * FROM send_tasks WHERE id = ?").bind(data.id).first();
      if(task) {
          // 这里强制立即把时间改为过去，等待Cron或立即执行逻辑
          // 既然是手动执行，我们复用 processSingleTask 逻辑会更好，但为了简单，这里仅仅是重置时间为0让cron立刻捡起来
          // 或者直接执行：
          const account = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(task.account_id).first();
          if(account) {
             await executeSendEmail(account, task.to_email, task.content);
             await env.DB.prepare("UPDATE send_tasks SET status = 'success' WHERE id = ?").bind(task.id).run();
             return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
          }
      }
      return new Response(JSON.stringify({ ok: false }), { headers: corsHeaders() });
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

// --- 定时任务核心逻辑 ---

function calculateDelay(configStr) {
    let min = 0, max = 0;
    if (configStr && configStr.includes('-')) {
        [min, max] = configStr.split('-').map(Number);
    } else {
        min = max = Number(configStr || 0);
    }
    // 简单起见，这里按 分钟 计算测试，如果你是按天，请改为 * 24 * 60 * 60 * 1000
    // 源码里是 * 24 * 60... (天)，这里保持原逻辑
    const days = Math.floor(Math.random() * (max - min + 1)) + min;
    return days * 24 * 60 * 60 * 1000; 
}

async function processScheduledTasks(env) {
    const now = Date.now();
    const { results } = await env.DB.prepare("SELECT * FROM send_tasks WHERE status = 'pending' AND next_run_at <= ?").bind(now).all();
    
    for (const task of results) {
        const account = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(task.account_id).first();
        
        if (account) {
            const res = await executeSendEmail(account, task.to_email, task.content);
            if(!res.success) {
                 // 记录错误或者重试逻辑，这里简单标记为 error
                 await env.DB.prepare("UPDATE send_tasks SET status = 'error' WHERE id = ?").bind(task.id).run();
                 continue; // 跳过循环更新
            }
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
