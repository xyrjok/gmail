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
  
  // 支持单位解析 (格式: "min-max,unit" 或 "val,unit" 或 兼容旧格式 "min-max")
  function calculateDelay(configStr) {
      if (!configStr) return 0;

      // 1. 拆分数值和单位
      // 兼容旧数据: 如果没有逗号，默认当作 'day'
      let rangePart = configStr;
      let unit = 'day'; 
      
      if (configStr.includes(',')) {
          const parts = configStr.split(',');
          rangePart = parts[0]; // 例如 "10-20" 或 "0"
          unit = parts[1];      // "minute", "hour", "day"
      }

      // 2. 解析数值范围
      let min = 0, max = 0;
      if (rangePart.includes('-')) {
          [min, max] = rangePart.split('-').map(Number);
      } else {
          min = max = Number(rangePart || 0);
      }
      
      // 如果输入 0，直接返回 0 (准时发送)
      if (min === 0 && max === 0) return 0;

      // 3. 生成随机数
      const randomValue = Math.floor(Math.random() * (max - min + 1)) + min;

      // 4. 根据单位计算毫秒数
      let multiplier = 1;
      switch (unit) {
          case 'minute': multiplier = 60 * 1000; break;
          case 'hour':   multiplier = 60 * 60 * 1000; break;
          case 'day':    multiplier = 24 * 60 * 60 * 1000; break;
          default:       multiplier = 24 * 60 * 60 * 1000; // 默认按天
      }
      
      return randomValue * multiplier;
  }
  
  // [核心] 获取账号的 OAuth 凭证 (从 account_auth 表)
  async function getAccountAuth(env, accountId) {
      return await env.DB.prepare("SELECT * FROM account_auth WHERE account_id = ?").bind(accountId).first();
  }
  
  // [核心] 使用独立的 ID/Secret 换取 Access Token
  async function getAccessToken(authData) {
      if (!authData || !authData.refresh_token) {
          throw new Error("Missing Refresh Token");
      }
      // 如果没有 ID/Secret，说明可能是旧数据，直接返回 token 试一试（兼容性）
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
  
  // 1. 发送邮件核心函数 (修改版：默认API，无配置自动降级GAS；指定模式则强制)
  async function executeSendEmail(env, account, toEmail, subject, content, mode) {
      const finalSubject = subject ? subject : "Remind";
      const finalContent = content ? content : "Reminder of current time: " + new Date().toUTCString();
  
      try {
          // === 1. 确定最终使用的发送模式 ===
          let useMode = mode; // 'API', 'GAS' 或 undefined/'AUTO'
          
          // 如果是自动模式 (AUTO) 或未指定，则根据是否有 API 配置来决定
          if (!useMode || useMode === 'AUTO') {
              // 检查该账号是否有 API 凭证记录
              const authData = await getAccountAuth(env, account.id);
              
              // 只要有 refresh_token，就认为可以尝试 API 发送
              if (authData && authData.refresh_token) {
                  useMode = 'API';
              } else {
                  useMode = 'GAS';
              }
          }
  
          // === 2. 执行发送逻辑 ===
          
          if (useMode === 'API') {
              // ------ API 模式 ------
              const authData = await getAccountAuth(env, account.id);
              if (!authData) {
                  throw new Error("无 API 配置数据 (No Auth Data)");
              }
              
              // 获取 Token
              const accessToken = await getAccessToken(authData);
  
              // 构建邮件
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
  
              // 发送
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
              // ------ GAS 模式 ------
              let scriptUrl = account.script_url ? account.script_url.trim() : '';
              
              // 检查 URL 有效性 (防止 API 账号降级到 GAS 时用到占位符 URL)
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
              
              // 成功判定
              if (text.includes("OK") || text.includes("Sent") || text.includes("成功")) return { success: true };
              
              // 尝试解析 JSON 错误
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
  
  // 2. 智能账号查找函数 (已修复支持 API/GAS)
  async function findBestAccount(env, referenceAccountId, mode) {
      const refAccount = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(referenceAccountId).first();
      if (!refAccount) throw new Error("Reference account not found");
  
      // 查找同名账号
      const { results: allAccounts } = await env.DB.prepare("SELECT * FROM accounts WHERE name = ? AND status = 1").bind(refAccount.name).all();
      
      let targetAccount = null;
  
      if (mode === 'API') {
          // 允许 API 或 API/GAS
          targetAccount = allAccounts.find(a => a.type === 'API' || a.type === 'API/GAS');
          if (!targetAccount) throw new Error(`No API account found for ${refAccount.name}`);
      } else if (mode === 'GAS') {
          // 允许 GAS 或 API/GAS
          targetAccount = allAccounts.find(a => a.type === 'GAS' || a.type === 'API/GAS');
          if (!targetAccount) throw new Error(`No GAS account found for ${refAccount.name}`);
      } else {
          // AUTO: 优先找支持 API 的 (含 API/GAS)
          targetAccount = allAccounts.find(a => a.type === 'API' || a.type === 'API/GAS');
          // 没找到则找 GAS
          if (!targetAccount) {
              targetAccount = allAccounts.find(a => a.type === 'GAS');
          }
          if (!targetAccount) throw new Error(`No available account (API or GAS) for ${refAccount.name}`);
      }
  
      return targetAccount;
  }
  
  // 3. 邮件同步函数
  async function syncEmails(env, accountId, mode) {
      const account = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(accountId).first();
      if (!account) throw new Error("Account not found");
  
      let messages = [];
  
      // 决策逻辑: 如果指定了 mode，则强制匹配；否则 fallback 到 account.type
      const useGas = (mode === 'GAS') || (!mode && account.type === 'GAS');
      const useApi = (mode === 'API') || (!mode && account.type === 'API');
  
      // === GAS 模式 ===
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
      // === API 模式 ===
      else if (useApi) {
          const authData = await getAccountAuth(env, account.id);
          if (!authData) throw new Error("No Auth Data found for API fetch");
  
          const accessToken = await getAccessToken(authData);
  
          // [修改点] 增加 q 参数过滤 label:inbox OR label:spam
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
  
      // === 入库逻辑 ===
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
    
    // === GET 请求 ===
    if (method === 'GET') {
      const { results } = await env.DB.prepare(`
          SELECT accounts.*, account_auth.client_id, account_auth.client_secret, account_auth.refresh_token 
          FROM accounts 
          LEFT JOIN account_auth ON accounts.id = account_auth.account_id 
          ORDER BY accounts.id DESC
      `).all();
      return new Response(JSON.stringify(results), { headers: corsHeaders() });
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
              // [修复] 批量添加时，如果有 base_date，直接用 base_date，不加延迟
              let nextRun = Date.now();
              if (t.base_date) {
                  nextRun = new Date(t.base_date).getTime();
              } else {
                  if (t.delay_config) nextRun += calculateDelay(t.delay_config);
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
              // [修复点] 传递 mode
              const result = await executeSendEmail(env, account, data.to_email, data.subject, data.content, mode);
              return new Response(JSON.stringify({ ok: result.success, error: result.error }), { headers: corsHeaders() });
          } catch (e) {
              return new Response(JSON.stringify({ ok: false, error: e.message }), { headers: corsHeaders() });
          }
      }
      
      // [修复] 单个添加时，如果有 base_date，严格按照 base_date 执行
      let nextRun = Date.now();
      if (data.base_date) {
          nextRun = new Date(data.base_date).getTime();
      } else {
          if (data.delay_config) nextRun += calculateDelay(data.delay_config);
      }
  
      await env.DB.prepare(`
        INSERT INTO send_tasks (account_id, to_email, subject, content, base_date, delay_config, next_run_at, is_loop, status, execution_mode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).bind(data.account_id, data.to_email, data.subject, data.content, data.base_date, data.delay_config, nextRun, data.is_loop, mode).run();
      
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
    }
    
    if (method === 'PUT') {
        const data = await req.json();
        
        // [修改] 手动执行: 记录成功/失败次数
        if (data.action === 'execute') {
            const task = await env.DB.prepare("SELECT * FROM send_tasks WHERE id = ?").bind(data.id).first();
            if(task) {
                try {
                    const mode = task.execution_mode || 'AUTO';
                    const account = await findBestAccount(env, task.account_id, mode);
                    const res = await executeSendEmail(env, account, task.to_email, task.subject, task.content, mode);
                    
                    if (res.success) {
                         // 成功: status='success', success_count + 1
                         await env.DB.prepare("UPDATE send_tasks SET status = 'success', success_count = IFNULL(success_count, 0) + 1 WHERE id = ?").bind(task.id).run();
                         return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
                    } else {
                         // 失败: status='error', fail_count + 1
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
            // [修复] 修改任务时，如果有 base_date，重置为该时间（不加延迟）
            let nextRun = Date.now();
            if (data.base_date) {
                nextRun = new Date(data.base_date).getTime();
            } else {
                 if (data.delay_config) nextRun += calculateDelay(data.delay_config);
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
  
    if (method === 'GET') {
       const { results } = await env.DB.prepare("SELECT * FROM send_tasks ORDER BY next_run_at ASC LIMIT 100").all();
       return new Response(JSON.stringify(results), { headers: corsHeaders() });
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
              // [修复点] 传递 mode
              const res = await executeSendEmail(env, account, task.to_email, task.subject, task.content, mode);
              
              if(!res.success) {
                   // [修改] 失败: status='error', fail_count + 1
                   await env.DB.prepare("UPDATE send_tasks SET status = 'error', fail_count = IFNULL(fail_count, 0) + 1 WHERE id = ?").bind(task.id).run();
                   continue;
              }
          } catch (e) {
              console.error(`Task ${task.id} failed:`, e);
              // [修改] 异常: status='error', fail_count + 1
              await env.DB.prepare("UPDATE send_tasks SET status = 'error', fail_count = IFNULL(fail_count, 0) + 1 WHERE id = ?").bind(task.id).run();
              continue;
          }
  
          if (task.is_loop) {
              let nextRun = Date.now();
              // [说明] 循环任务计算下次时间时，才需要加延迟
              if (task.delay_config) {
                  nextRun += calculateDelay(task.delay_config);
              } else {
                  nextRun += 24 * 60 * 60 * 1000;
              }
              // [修改] 循环任务成功: success_count + 1, 更新 next_run_at
              await env.DB.prepare("UPDATE send_tasks SET next_run_at = ?, success_count = IFNULL(success_count, 0) + 1 WHERE id = ?").bind(nextRun, task.id).run();
          } else {
              // [修改] 单次任务成功: status='success', success_count + 1
              await env.DB.prepare("UPDATE send_tasks SET status = 'success', success_count = IFNULL(success_count, 0) + 1 WHERE id = ?").bind(task.id).run();
          }
      }
  }
