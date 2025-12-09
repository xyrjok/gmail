/**
 * worker.js
 * 绑定变量: DB (D1 Database), ADMIN_USERNAME, ADMIN_PASSWORD
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // 1. 简单的跨域处理 (CORS)
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // 2. 身份验证中间件 (Basic Auth 简单实现)
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

  // 定时任务触发器 (Cron Triggers)
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

// --- 业务逻辑 ---

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

  if (method === 'DELETE') {
    const id = url.searchParams.get('id');
    await env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(id).run();
    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
  }
  
  // 编辑逻辑略 (UPDATE...)
  return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
}

async function handleTasks(req, env) {
  const method = req.method;
  
  if (method === 'POST') { // 添加发送任务
    const data = await req.json();
    
    // 计算首次运行时间
    let nextRun = Date.now();
    if (data.base_date) {
        nextRun = new Date(data.base_date).getTime();
    }
    // 如果有B框延迟配置，计算随机延迟
    if (data.delay_config) {
        nextRun += calculateDelay(data.delay_config);
    }

    await env.DB.prepare(`
      INSERT INTO send_tasks (account_id, to_email, content, base_date, delay_config, next_run_at, is_loop, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `).bind(data.account_id, data.to_email, data.content, data.base_date, data.delay_config, nextRun, data.is_loop).run();
    
    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
  }
  
  if (method === 'GET') {
     const { results } = await env.DB.prepare("SELECT * FROM send_tasks ORDER BY next_run_at ASC").all();
     return new Response(JSON.stringify(results), { headers: corsHeaders() });
  }
  
  // 批量删除等逻辑...
  return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
}

async function handleEmails(req, env) {
   // 获取收件箱逻辑
   const { results } = await env.DB.prepare("SELECT * FROM received_emails ORDER BY received_at DESC").all();
   return new Response(JSON.stringify(results), { headers: corsHeaders() });
}


// --- 定时任务核心逻辑 ---

function calculateDelay(configStr) {
    // 解析 "10-20" 这种格式，返回毫秒数
    // 如果是单个数字 "5"，则范围是 5
    let min = 0, max = 0;
    if (configStr.includes('-')) {
        [min, max] = configStr.split('-').map(Number);
    } else {
        min = max = Number(configStr);
    }
    const days = Math.floor(Math.random() * (max - min + 1)) + min;
    return days * 24 * 60 * 60 * 1000; 
}

async function processScheduledTasks(env) {
    const now = Date.now();
    // 找出所有待执行的任务
    const { results } = await env.DB.prepare("SELECT * FROM send_tasks WHERE status = 'pending' AND next_run_at <= ?").bind(now).all();
    
    for (const task of results) {
        // 1. 获取账号信息
        const account = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(task.account_id).first();
        
        if (account) {
            // 2. 执行发送 (这里根据 type 调用 GAS 或 API)
            try {
                if (account.type === 'GAS') {
                    await fetch(account.script_url, {
                        method: 'POST',
                        body: JSON.stringify({ to: task.to_email, subject: "Auto Mail", body: task.content })
                    });
                }
                // API 逻辑略 (需要 OAuth Token 处理)
            } catch (e) {
                console.error("Send failed", e);
            }
        }

        // 3. 处理循环逻辑
        if (task.is_loop) {
            let nextRun = Date.now(); // 从当前完成时间开始算
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
