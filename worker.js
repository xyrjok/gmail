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
  
  // [新增] 辅助函数：解析范围字符串 (例如 "10-20" 或 "5")
  function getRandFromRange(str) {
      if (!str) return 0;
      // 如果是范围 "10-20"
      if (String(str).includes('-')) {
          const parts = str.split('-');
          const min = parseInt(parts[0]) || 0;
          const max = parseInt(parts[1]) || 0;
          return Math.floor(Math.random() * (max - min + 1)) + min;
      }
      // 如果是固定值 "5"
      return parseInt(str) || 0;
  }

  // [修改] 计算下次运行时间 (替代 calculateDelay)
  // 支持格式: "dRange|hRange|mRange|sRange" (例如 "1-2|0-5|0-0|0-0")
  // 也兼容旧格式 (为了不报错)
  function calculateNextRun(baseTimeMs, configStr) {
      if (!configStr) {
          // 没填配置，默认 +1 天
          return baseTimeMs + 86400000; 
      }
  
      let addMs = 0;

      // === 新版逻辑: Pipe 分隔 (Day|Hour|Min|Sec) ===
      if (configStr.includes('|')) {
          const parts = configStr.split('|'); // [day, hour, min, sec]
          
          const d = getRandFromRange(parts[0]);
          const h = getRandFromRange(parts[1]);
          const m = getRandFromRange(parts[2]);
          const s = getRandFromRange(parts[3]);

          addMs += d * 24 * 60 * 60 * 1000;
          addMs += h * 60 * 60 * 1000;
          addMs += m * 60 * 1000;
          addMs += s * 1000;
      } 
      // === 旧版逻辑兼容 (Comma 分隔) ===
      else if (configStr.includes(',')) {
          // 兼容旧数据的逻辑
          const parts = configStr.split(',');
          const val = getRandFromRange(parts[0]);
          const unit = parts[1];
          let multiplier = 24 * 60 * 60 * 1000; // default day
          if (unit === 'minute') multiplier = 60 * 1000;
          if (unit === 'hour') multiplier = 60 * 60 * 1000;
          addMs = val * multiplier;
      } else {
          // 纯数字默认当做天
          addMs = getRandFromRange(configStr) * 86400000;
      }

      // 如果计算出的增量为0 (例如填了0-0)，强制加1分钟防止死循环
      if (addMs <= 0) addMs = 60000;

      return baseTimeMs + addMs;
  }
  
  async function getAccountAuth(env, accountId) {
      return await env.DB.prepare("SELECT * FROM account_auth WHERE account_id = ?").bind(accountId).first();
  }
  
  async function getAccessToken(authData) {
      if (!authData || !authData.refresh_token) {
          throw new Error("Missing Refresh Token");
      }
      if (!authData.client_id || !authData.client_secret) {
          console.warn("Missing Client ID/Secret for account, trying raw refresh token as access token.");
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
              const authData = await getAccountAuth(env, account.id);
              if (authData && authData.refresh_token) {
                  useMode = 'API';
              } else {
                  useMode = 'GAS';
              }
          }
  
          if (useMode === 'API') {
              const authData = await getAccountAuth(env, account.id);
              if (!authData) {
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
  
      if (mode === 'API') {
          targetAccount = allAccounts.find(a => a.type === 'API' || a.type === 'API/GAS');
          if (!targetAccount) throw new Error(`No API account found for ${refAccount.name}`);
      } else if (mode === 'GAS') {
          targetAccount = allAccounts.find(a => a.type === 'GAS' || a.type === 'API/GAS');
          if (!targetAccount) throw new Error(`No GAS account found for ${refAccount.name}`);
      } else {
          targetAccount = allAccounts.find(a => a.type === 'API' || a.type === 'API/GAS');
          if (!targetAccount) {
              targetAccount = allAccounts.find(a => a.type === 'GAS');
          }
          if (!targetAccount) throw new Error(`No available account (API or GAS) for ${refAccount.name}`);
      }
  
      return targetAccount;
  }
  
  async function syncEmails(env, accountId, mode) {
      const account = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(accountId).first();
      if (!account) throw new Error("Account not found");
  
      let messages = [];
  
      const useGas = (mode === 'GAS') || (!mode && account.type === 'GAS');
      const useApi = (mode === 'API') || (!mode && account.type === 'API');
  
      if (useGas) {
          let scriptUrl = account.script_url ? account.script_url.trim() : '';
          if (!scriptUrl) throw new Error("Missing GAS URL for fetching");
  
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
      else if (useApi) {
          const authData = await getAccountAuth(env, account.id);
          if (!authData) throw new Error("No Auth Data found for API fetch");
  
          const accessToken = await getAccessToken(authData);
  
          const q = encodeURIComponent("label:inbox OR label:spam");
          const listResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&q=${q}`, {
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
                          date: Date.now()
                      });
                  }
              }
          }
      }
  
      if (messages.length === 0) return 0;
      
      let syncCount = 0;
      for (const msg of messages) {
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
  
  async function saveAuthInfo(env, accountId, rawInput) {
      if (rawInput && rawInput.includes(',')) {
          const parts = rawInput.split(',').map(s => s.trim());
          if (parts.length >= 3) {
              const [clientId, clientSecret, refreshToken] = parts;
              await env.DB.prepare(`
                  INSERT INTO account_auth (account_id, client_id, client_secret, refresh_token, updated_at)
                  VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(account_id) DO UPDATE SET
                  client_id=excluded.client_id,
                  client_secret=excluded.client_secret,
                  refresh_token=excluded.refresh_token,
                  updated_at=excluded.updated_at
              `).bind(accountId, clientId, clientSecret, refreshToken, Date.now()).run();
              return true;
          }
      }
      if (rawInput && rawInput.length > 20) {
           await env.DB.prepare(`
              INSERT INTO account_auth (account_id, refresh_token, updated_at)
              VALUES (?, ?, ?)
              ON CONFLICT(account_id) DO UPDATE SET refresh_token=excluded.refresh_token
          `).bind(accountId, rawInput, Date.now()).run();
      }
      return false;
  }
  
  async function handleAccounts(req, env) {
    const method = req.method;
    const url = new URL(req.url);
    
    // === GET 请求 (查询) ===
    if (method === 'GET') {
      const type = url.searchParams.get('type'); // 'simple' | 'export' | null(默认分页)
      
      // 1. 简易模式 (用于发件下拉列表，只查 ID 和 Name，量大也不怕)
      if (type === 'simple') {
          const { results } = await env.DB.prepare(
              "SELECT id, name, alias FROM accounts ORDER BY id DESC"
          ).all();
          return new Response(JSON.stringify(results), { headers: corsHeaders() });
      }
  
      // 2. 导出模式 (用于批量导出，获取全部完整数据)
      if (type === 'export') {
          const { results } = await env.DB.prepare(`
              SELECT accounts.*, account_auth.client_id, account_auth.client_secret, account_auth.refresh_token 
              FROM accounts 
              LEFT JOIN account_auth ON accounts.id = account_auth.account_id 
              ORDER BY accounts.id DESC
          `).all();
          return new Response(JSON.stringify(results), { headers: corsHeaders() });
      }
  
      // 3. 默认分页模式 (用于表格显示 + 后端搜索)
      const page = parseInt(url.searchParams.get('page')) || 1;
      const limit = parseInt(url.searchParams.get('limit')) || 50; // 默认每页 50 条
      const q = url.searchParams.get('q') || '';
  
      let whereClause = "";
      let params = [];
      
      // 构建搜索条件
      if (q) {
          whereClause = "WHERE name LIKE ? OR alias LIKE ?";
          params.push(`%${q}%`, `%${q}%`);
      }
  
      // 第一步：查总数
      const countStmt = `SELECT COUNT(*) as total FROM accounts ${whereClause}`;
      const totalResult = await env.DB.prepare(countStmt).bind(...params).first();
      const total = totalResult.total;
  
      // 第二步：查分页数据
      const sql = `
          SELECT accounts.*, account_auth.client_id, account_auth.client_secret, account_auth.refresh_token 
          FROM accounts 
          LEFT JOIN account_auth ON accounts.id = account_auth.account_id 
          ${whereClause} 
          ORDER BY accounts.id DESC 
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
    
    // === POST 请求：添加账号 ===
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
  
              const res = await env.DB.prepare(
                  "INSERT INTO accounts (name, alias, type, script_url, status) VALUES (?, ?, ?, ?, ?) RETURNING id"
              ).bind(acc.name, acc.alias || '', acc.type || 'API', storedUrl, 1).first();
  
              if (acc.type && acc.type.includes('API') && apiConfig) {
                  await saveAuthInfo(env, res.id, apiConfig);
              }
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
  
      const res = await env.DB.prepare("INSERT INTO accounts (name, alias, type, script_url, status) VALUES (?, ?, ?, ?, ?) RETURNING id")
        .bind(data.name, data.alias, data.type, storedUrl, data.status ? 1 : 0).first();
              
      if (data.type && data.type.includes('API') && rawApiConfig) {
          await saveAuthInfo(env, res.id, rawApiConfig);
      }
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
    }
  
    // === PUT 请求：更新账号 ===
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
  
      await env.DB.prepare("UPDATE accounts SET name=?, alias=?, type=?, script_url=?, status=? WHERE id=?")
        .bind(data.name, data.alias, data.type, storedUrl, data.status ? 1 : 0, data.id).run();
      
      if (data.type && data.type.includes('API') && rawApiConfig) {
          await saveAuthInfo(env, data.id, rawApiConfig);
      }
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
    }
  
    if (method === 'DELETE') {
      const id = url.searchParams.get('id');
      const ids = url.searchParams.get('ids'); 
      if (ids) {
          const idList = ids.split(',').map(Number);
          await env.DB.batch([
              env.DB.prepare(`DELETE FROM accounts WHERE id IN (${ids})`),
              env.DB.prepare(`DELETE FROM account_auth WHERE account_id IN (${ids})`)
          ]);
      } else if (id) {
          await env.DB.batch([
              env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(id),
              env.DB.prepare("DELETE FROM account_auth WHERE account_id = ?").bind(id)
          ]);
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
              // 如果有起始日期，则基于起始日期；否则基于当前时间+随机延迟
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
  
       // 支持搜索：主题 OR 收件人 OR 发件账号名
       if (q) {
           // 注意：因为我们要搜 accounts.name，所以下面必须先 LEFT JOIN
           whereClause = "WHERE send_tasks.subject LIKE ? OR send_tasks.to_email LIKE ? OR accounts.name LIKE ?";
           params.push(`%${q}%`, `%${q}%`, `%${q}%`);
       }
  
       // 1. 查总数 (关联查询)
       const countStmt = `
           SELECT COUNT(*) as total 
           FROM send_tasks 
           LEFT JOIN accounts ON send_tasks.account_id = accounts.id
           ${whereClause}
       `;
       const totalResult = await env.DB.prepare(countStmt).bind(...params).first();
       const total = totalResult.total;
  
       // 2. 查分页数据 (关联查询以获取 account_name)
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
         try {
             const data = await req.json();
             const accountId = data.account_id;
             const mode = data.mode; 
             if (!accountId) throw new Error("Missing account_id");
             
             const count = await syncEmails(env, accountId, mode);
             return new Response(JSON.stringify({ ok: true, count: count }), { headers: corsHeaders() });
         } catch (e) {
             return new Response(JSON.stringify({ ok: false, error: e.message }), { headers: corsHeaders() });
         }
     }
     
     if (method === 'GET') {
         let limit = parseInt(url.searchParams.get('limit'));
         if (!limit || limit <= 0) limit = 20; 
         
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
              // [核心] 循环逻辑: 调用 calculateNextRun 计算自定义随机间隔
              let nextRun = calculateNextRun(Date.now(), task.delay_config);
              await env.DB.prepare("UPDATE send_tasks SET next_run_at = ?, success_count = IFNULL(success_count, 0) + 1 WHERE id = ?").bind(nextRun, task.id).run();
          } else {
              await env.DB.prepare("UPDATE send_tasks SET status = 'success', success_count = IFNULL(success_count, 0) + 1 WHERE id = ?").bind(task.id).run();
          }
      }
  }
