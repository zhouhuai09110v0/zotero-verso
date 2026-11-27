/* Verso (formerly Verso Translate) — core module.
 * Loaded by bootstrap.js via Services.scriptloader.loadSubScript into a scope
 * object; exposes createCLITrans(env). Everything that touches Zotero / the OS
 * goes through `env`, so the pure logic can be unit-tested outside Zotero.
 */
/* eslint-disable no-unused-vars */
function createCLITrans(env) {
  "use strict";
  const { Zotero } = env;
  const PREF = "clitrans.";
  const LOG = (...a) => {
    try { Zotero.debug("[CLITrans] " + a.map(String).join(" ")); } catch (e) {}
  };

  // ---------------------------------------------------------------- prefs
  function pref(name) { return Zotero.Prefs.get(PREF + name); }
  function setPref(name, v) { return Zotero.Prefs.set(PREF + name, v); }

  function randomToken() {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let s = "zt-";
    for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }
  function ensureTokens() {
    if (!pref("bridgeToken")) setPref("bridgeToken", randomToken());
  }

  // ------------------------------------------------------------ glossary
  /** "source = target" per line; also accepts tab, "→", "," as separators. */
  function parseGlossary(text) {
    const out = [];
    for (let line of String(text || "").split(/\r?\n/)) {
      line = line.trim();
      if (!line || line.startsWith("#")) continue;
      // explicit separators win; a comma only separates when none of them is present,
      // so "trade credit, bank credit = …" keeps its comma in the source term
      const m = line.match(/^(.+?)\s*(?:=|→|->|\t)\s*(.+)$/) || line.match(/^(.+?)\s*(?:,|，)\s*(.+)$/);
      if (m && m[1].trim() && m[2].trim()) out.push([m[1].trim(), m[2].trim()]);
    }
    return out;
  }
  function glossaryForText(entries, text) {
    if (!text) return entries;
    const low = String(text).toLowerCase();
    return entries.filter(([s]) => low.includes(s.toLowerCase()));
  }
  function csvCell(s) {
    s = String(s);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function glossaryToCSV(entries, tgtLang) {
    const rows = ["source,target,tgt_lng"];
    for (const [s, t] of entries) rows.push([s, t, tgtLang].map(csvCell).join(","));
    return rows.join("\n") + "\n";
  }

  // ------------------------------------------------------------- prompts
  /** Pure: translate one paragraph from its printed image, formulas as LaTeX. */
  function paraVisionPrompt(langName, glossary) {
    return translatorSystemPrompt(langName, glossary) +
      "\n\nAn image of the paragraph exactly as printed in the PDF is attached, together with the text extracted from " +
      "it; the extracted text often loses fractions, subscripts, superscripts and symbols. Read the formulas from the " +
      "image. Translate the prose; write every formula, variable and symbol in LaTeX — inline as $…$, a displayed " +
      "equation on its own line as $$…$$. Keep labels such as (A1) or equation numbers. Output only the translation.";
  }
  function translatorSystemPrompt(langName, glossary) {
    let p =
      "You are a professional academic translator. Translate the text the user gives you into " +
      langName +
      ". Keep the meaning exact and natural for academic readers; keep numbers, citations, " +
      "variable names and math unchanged. Output ONLY the translation — no explanations, " +
      "no quotation marks, no preface, no notes.";
    if (glossary && glossary.length) {
      p += "\nUse this glossary strictly (source → target):\n" +
        glossary.map(([s, t]) => "- " + s + " → " + t).join("\n");
    }
    return p;
  }
  function cleanSelection(text) {
    // join hyphenated line breaks and single newlines from PDF extraction
    return String(text || "")
      .replace(/-\n(?=[a-z])/g, "")
      .replace(/\s*\n\s*/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  // -------------------------------------------------------------- google
  function parseGoogleResponse(json) {
    if (!Array.isArray(json) || !Array.isArray(json[0])) throw new Error("Google 返回格式无法识别");
    return json[0].map((seg) => (Array.isArray(seg) && typeof seg[0] === "string" ? seg[0] : "")).join("");
  }
  function chunkText(text, max) {
    const chunks = [];
    let rest = String(text);
    while (rest.length > max) {
      let cut = Math.max(rest.lastIndexOf(". ", max), rest.lastIndexOf("。", max), rest.lastIndexOf("\n", max));
      if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
      if (cut <= 0) cut = max;
      chunks.push(rest.slice(0, cut + 1));
      rest = rest.slice(cut + 1);
    }
    if (rest) chunks.push(rest);
    return chunks;
  }
  async function translateGoogle(text, tl) {
    const parts = [];
    for (const chunk of chunkText(text, 4000)) {
      const url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=" +
        encodeURIComponent(tl) + "&dt=t";
      // Google answers a rate-limited network with a redirect to its "sorry" captcha page (HTTP 429).
      // Zotero would retry that for a long time, which looked like "nothing happens": fail fast instead.
      const blocked = () => new Error("Google 暂时拒绝了当前网络的请求（触发了人机验证）。过一会儿再试，或直接点 GPT / Claude / Gemini。");
      let xhr;
      try {
        xhr = await Zotero.HTTP.request("POST", url, {
          body: "q=" + encodeURIComponent(chunk),
          headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
          responseType: "json",
          timeout: 10000,
          errorDelayIntervals: [],
          errorDelayMax: 0,
        });
      } catch (e) {
        const st = e && (e.status || (e.xmlhttp && e.xmlhttp.status));
        const at = (e && e.xmlhttp && e.xmlhttp.responseURL) || "";
        if (st === 429 || st === 403 || /\/sorry\//.test(at)) throw blocked();
        if (/timed? ?out|timeout/i.test(String((e && e.message) || e))) throw new Error("Google 翻译超时（10 秒没有响应）。检查网络，或直接点 GPT / Claude / Gemini。");
        throw e;
      }
      let data = xhr.response;
      if (typeof data === "string") { try { data = JSON.parse(data); } catch (e) { throw blocked(); } }
      if (!Array.isArray(data)) throw blocked();
      parts.push(parseGoogleResponse(data));
    }
    return parts.join("");
  }

  // --------------------------------------------------------------- gemini
  // Two channels: a Google AI Studio API key (fast, no CLI start-up), or a local Gemini CLI.
  function sleep(ms) { return new Promise((r) => env.setTimeout(r, ms)); }
  function geminiModel() { return (pref("geminiModel") || "gemini-3.5-flash-lite").trim(); }
  function parseGeminiResponse(d) {
    if (typeof d === "string") d = JSON.parse(d);
    const cand = d && Array.isArray(d.candidates) ? d.candidates[0] : null;
    const parts = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : [];
    const text = parts.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("").trim();
    if (text) return text;
    const why = (cand && cand.finishReason) || (d && d.promptFeedback && d.promptFeedback.blockReason) || "";
    throw new Error("Gemini 没有返回内容" + (why ? "（" + why + "）" : ""));
  }
  let geminiActive = 0;
  async function callGeminiAPI(system, user, images) {
    const key = (pref("geminiApiKey") || "").trim();
    const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(geminiModel()) + ":generateContent";
    const parts = [];
    for (const img of images || []) parts.push({ inlineData: { mimeType: "image/png", data: await fileBase64(img) } });
    parts.push({ text: user });
    const body = { contents: [{ role: "user", parts }], generationConfig: { temperature: 0.2 } };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    while (geminiActive >= 4) await sleep(50);
    geminiActive++;
    try {
      let lastErr;
      for (let attempt = 0; attempt < 4; attempt++) {
        let x;
        try {
          x = await Zotero.HTTP.request("POST", url, {
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json", "x-goog-api-key": key },
            responseType: "json", timeout: 120000,
          });
        } catch (e) {
          lastErr = e;
          const status = e && e.status;
          if (status === 429 || status >= 500) { await sleep(1500 * 2 ** attempt); continue; }
          let detail = "";
          try { const r = e.xmlhttp && e.xmlhttp.response; detail = (r && r.error && r.error.message) || ""; } catch (e2) {}
          throw new Error("Gemini 调用失败" + (status ? "（" + status + "）" : "") + "：" +
            (detail || (e && e.message) || e).toString().slice(0, 300));
        }
        return parseGeminiResponse(x.response);
      }
      throw new Error("Gemini 暂时不可用（限流或服务端错误）：" + ((lastErr && (lastErr.status || lastErr.message)) || lastErr));
    } finally { geminiActive--; }
  }
  // ------------------------------------------------------------- deepseek
  // OpenAI-compatible chat API (api.deepseek.com), reachable from mainland China without a VPN.
  // Thinking mode is on by default there; translation does not need it, so it is switched off (faster,
  // cheaper). deepseek-flash also reads images (formulas / figures); deepseek-v4-pro does not.
  function deepseekModel() { return (pref("deepseekModel") || "deepseek-flash").trim(); }
  function deepseekBase() { return (pref("deepseekBaseURL") || "https://api.deepseek.com").trim().replace(/\/+$/, ""); }
  function deepseekCanSee() { return /flash/i.test(deepseekModel()); }
  /** Pure: request body for a chat completion with optional base64 PNGs. */
  function buildDeepSeekBody(model, system, user, imagesB64) {
    const messages = [];
    if (system) messages.push({ role: "system", content: system });
    const content = imagesB64 && imagesB64.length
      ? [{ type: "text", text: user }].concat(imagesB64.map((b) => ({ type: "image_url", image_url: { url: "data:image/png;base64," + b } })))
      : user;
    messages.push({ role: "user", content });
    return { model, messages, thinking: { type: "disabled" }, temperature: 0.2, stream: false };
  }
  /** Pure: the answer text, or a readable error. */
  function parseDeepSeekResponse(d) {
    if (typeof d === "string") d = JSON.parse(d);
    const ch = d && Array.isArray(d.choices) ? d.choices[0] : null;
    const text = ch && ch.message && typeof ch.message.content === "string" ? ch.message.content.trim() : "";
    if (text) return text;
    throw new Error("DeepSeek 没有返回内容" + (ch && ch.finish_reason ? "（" + ch.finish_reason + "）" : ""));
  }
  /** Pure: DeepSeek's HTTP status → what the user should do. */
  function deepseekErrorText(status, detail) {
    const why = { 400: "请求格式不被接受", 401: "API Key 无效，请检查设置里的 DeepSeek API Key",
      402: "账户余额不足，请到 platform.deepseek.com 充值", 422: "参数不被接受（检查模型名是否正确）",
      429: "请求太频繁，已达到限速", 500: "DeepSeek 服务器内部错误", 503: "DeepSeek 服务器繁忙" }[status];
    return "DeepSeek 调用失败" + (status ? "（" + status + "）" : "") + "：" + (why || "") + (detail ? (why ? " · " : "") + String(detail).slice(0, 200) : "");
  }
  let deepseekActive = 0;
  async function callDeepSeek(system, user, images) {
    const key = (pref("deepseekApiKey") || "").trim();
    if (!key) throw new Error("DeepSeek 未配置：请在 Zotero 设置 → Verso 里填写 DeepSeek API Key（在 platform.deepseek.com 申请）");
    const b64 = [];
    for (const img of images || []) b64.push(await fileBase64(img));
    const body = buildDeepSeekBody(deepseekModel(), system, user, b64);
    while (deepseekActive >= 8) await sleep(50);
    deepseekActive++;
    try {
      let lastErr;
      for (let attempt = 0; attempt < 4; attempt++) {
        let x;
        try {
          x = await Zotero.HTTP.request("POST", deepseekBase() + "/chat/completions", {
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
            responseType: "json", timeout: 180000, errorDelayIntervals: [], errorDelayMax: 0,
          });
        } catch (e) {
          lastErr = e;
          const status = e && e.status;
          if (status === 429 || status === 500 || status === 503) { await sleep(1500 * 2 ** attempt); continue; }
          let detail = "";
          try { const r = e.xmlhttp && e.xmlhttp.response; detail = (r && r.error && r.error.message) || ""; } catch (e2) {}
          if (!status) throw new Error("DeepSeek 连接失败：" + String((e && e.message) || e).slice(0, 160) + "。请检查网络（DeepSeek 在国内可直连，不需要 VPN）。");
          throw new Error(deepseekErrorText(status, detail));
        }
        return parseDeepSeekResponse(x.response);
      }
      throw new Error(deepseekErrorText(lastErr && lastErr.status, "重试多次仍失败，请稍后再试"));
    } finally { deepseekActive--; }
  }

  function buildGeminiArgs(dropped) {
    const a = [];
    const model = geminiModel();
    if (model) a.push("-m", model);
    if (!dropped.has("-o")) a.push("-o", "text");
    // -p forces non-interactive mode; its text is appended to what we pipe on stdin
    a.push("-p", "Follow the instructions above exactly and output only the result.");
    return a;
  }
  async function callGeminiCLI(system, user) {
    const bin = resolveTool("gemini");
    if (!bin) throw new Error("Gemini 未配置：请登录 Antigravity（自带 agy 命令行），或在设置里填写 Gemini API Key");
    return withCliSlot(async () => {
      const stdin = (system ? system + "\n\n----- INPUT -----\n" : "") + user + "\n";
      const r = await runWithFlagFallback(
        bin, (d) => buildGeminiArgs(d), ["-o"],
        { stdin, workdir: tmpDir(), timeoutMs: (Number(pref("cliTimeoutSec")) || 180) * 1000, proxy: true },
      );
      if (r.exitCode !== 0) throw new Error("Gemini CLI 调用失败：" + errText(r) + await netHint(r.stderr + r.stdout + errText(r), "Gemini（Google）"));
      return r.stdout.trim();
    });
  }
  // Antigravity CLI ("agy"): Google's CLI for personal accounts (Gemini CLI's free tier moved there).
  function agyModel() { return (pref("agyModel") || "gemini-3.8-flash-low").trim(); }
  function buildAgyArgs(prompt) {
    const a = ["-p=" + prompt, "--disable-slash-commands", "--sandbox", "--output-format", "text"];
    const model = agyModel();
    if (model) a.push("--model", model);
    const t = Number(pref("cliTimeoutSec")) || 180;
    a.push("--print-timeout", t + "s");
    return a;
  }
  async function callAgy(system, user, images) {
    const bin = resolveTool("agy");
    if (!bin) throw new Error("找不到 Antigravity CLI（agy）");
    return withCliSlot(async () => {
      let pics = "";
      const dirs = new Set();
      if (images && images.length) {
        // agy's print mode takes no inline images: its agent opens the PNG files itself
        pics = "\n\nThe images, in order (open EVERY one with your file viewing tool before answering; " +
          "do not guess from the extracted text):\n" + images.map((p, i) => "[" + (i + 1) + "] " + p).join("\n");
        for (const p of images) dirs.add(String(p).replace(/[\\/][^\\/]*$/, ""));
      }
      let prompt = (system ? system + pics + "\n\n----- INPUT -----\n" : pics) + user;
      let promptFile = null;
      if (IS_WIN && prompt.length > 20000) {
        // Windows caps a command line at ~32k characters: hand a long prompt over as a file
        promptFile = joinPath(tmpDir(), "clitrans-agy-" + uid() + ".txt");
        await Zotero.File.putContentsAsync(promptFile, prompt);
        dirs.add(tmpDir());
        prompt = "Read the file " + promptFile + " with your file viewing tool. It contains your complete instructions " +
          "and input. Follow those instructions exactly and output only the result they ask for.";
      }
      const args = buildAgyArgs(prompt);
      for (const d of dirs) args.push("--add-dir", d);
      const r = await runProcess(bin, args, {
        workdir: tmpDir(), timeoutMs: ((Number(pref("cliTimeoutSec")) || 180) + 15) * 1000, proxy: true,
      });
      if (promptFile) { try { await IOUtils.remove(promptFile); } catch (e) {} }
      const out = String(r.stdout || "").trim();
      if (r.exitCode !== 0 || !out) throw new Error("Gemini（agy）调用失败：" + errText(r) + await netHint(r.stderr + r.stdout + errText(r), "Gemini（Google）"));
      return out;
    });
  }
  /** Which Gemini channel is in use: API key > Antigravity CLI > Gemini CLI. */
  function geminiChannel() {
    if ((pref("geminiApiKey") || "").trim()) return "api";
    if (resolveTool("agy")) return "agy";
    if (resolveTool("gemini")) return "cli";
    return null;
  }
  function callGemini(system, user, images) {
    const ch = geminiChannel();
    if (ch === "api") return callGeminiAPI(system, user, images);
    if (ch === "agy") return callAgy(system, user, images);
    if (images && images.length) throw new Error("Gemini CLI 渠道不支持看图，请改用 Antigravity（agy）或 API Key");
    return callGeminiCLI(system, user);
  }
  /** PNG bytes → base64 (for Claude / Gemini image input). */
  async function fileBase64(path) {
    const bytes = await IOUtils.read(path);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    const b64 = typeof btoa === "function" ? btoa : Zotero.getMainWindow().btoa.bind(Zotero.getMainWindow());
    return b64(bin);
  }

  // --------------------------------------------------------- subprocess
  function homeDir() {
    try { return env.Services.dirsvc.get("Home", Components.interfaces.nsIFile).path; } catch (e) { return ""; }
  }
  function joinPath(...p) {
    try { if (typeof PathUtils !== "undefined") return PathUtils.join(...p); } catch (e) {}
    return p.join("/").replace(/\/+/g, "/");
  }
  function fileExists(p) {
    try { return !!p && Zotero.File.pathToFile(p).exists(); } catch (e) { return false; }
  }
  // ---- platform: macOS / Linux / Windows
  const IS_WIN = (() => { try { return !!Zotero.isWin; } catch (e) { return false; } })();
  const IS_MAC = (() => { try { return !!Zotero.isMac; } catch (e) { return false; } })();
  const PATH_SEP = IS_WIN ? ";" : ":";
  function envVar(name) {
    try { return env.Services.env.get(name) || ""; } catch (e) { return ""; }
  }
  function winDirs() {
    const h = homeDir();
    const appdata = envVar("APPDATA") || joinPath(h, "AppData", "Roaming");
    const local = envVar("LOCALAPPDATA") || joinPath(h, "AppData", "Local");
    return [
      joinPath(h, ".local", "bin"), joinPath(appdata, "npm"), joinPath(h, ".cargo", "bin"), joinPath(h, ".bun", "bin"),
      joinPath(local, "Programs", "Antigravity", "bin"), joinPath(local, "Programs", "antigravity", "bin"),
      joinPath(local, "Volta", "bin"), joinPath(local, "pnpm"),
      joinPath(envVar("ProgramFiles") || "C:\\Program Files", "nodejs"),
    ];
  }
  function unixDirs() {
    const h = homeDir();
    return [
      "/opt/homebrew/bin", "/usr/local/bin", h + "/.local/bin", h + "/.npm-global/bin",
      h + "/.bun/bin", h + "/.volta/bin", h + "/.cargo/bin", h + "/.antigravity/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin",
    ];
  }
  /** PATH for child processes: the user's own PATH plus the usual install folders (Zotero is often
   *  started without the shell's PATH, especially on macOS). */
  function searchPATH() {
    const extra = IS_WIN ? winDirs() : unixDirs();
    const own = envVar("PATH").split(PATH_SEP).filter(Boolean);
    const seen = new Set();
    return (IS_WIN ? own.concat(extra) : extra.concat(own)).filter((d) => !seen.has(d) && seen.add(d)).join(PATH_SEP);
  }
  /** Look a command up in PATH (+ usual folders); on Windows also name.exe / .cmd / .bat. */
  function whichTool(name) {
    const exts = IS_WIN ? [".exe", ".cmd", ".bat", ""] : [""];
    for (const d of searchPATH().split(PATH_SEP)) {
      for (const x of exts) {
        const c = joinPath(d, name + x);
        if (fileExists(c)) return c;
      }
    }
    return null;
  }
  const CANDIDATES = {
    codex: () => IS_WIN ? [] : [
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
    ],
    claude: () => IS_WIN ? [joinPath(homeDir(), ".local", "bin", "claude.exe")] : [homeDir() + "/.claude/local/claude"],
    agy: () => IS_WIN ? [] : [homeDir() + "/.antigravity/bin/agy"],
    gemini: () => [],
    pdf2zh: () => [],
    uv: () => IS_WIN ? [joinPath(homeDir(), ".local", "bin", "uv.exe"), joinPath(homeDir(), ".cargo", "bin", "uv.exe")] : [],
  };
  const TOOL_NAMES = { codex: ["codex"], claude: ["claude"], agy: ["agy"], gemini: ["gemini"], pdf2zh: ["pdf2zh_next", "pdf2zh"], uv: ["uv"] };
  function resolveTool(kind) {
    const prefName = { codex: "codexPath", claude: "claudePath", gemini: "geminiPath", agy: "agyPath", pdf2zh: "pdf2zhPath" }[kind];
    const configured = prefName ? (pref(prefName) || "").trim() : "";
    if (configured) return fileExists(configured) ? configured : null;
    for (const c of CANDIDATES[kind]()) if (fileExists(c)) return c;
    for (const n of TOOL_NAMES[kind] || [kind]) {
      const w = whichTool(n);
      if (w) return w;
    }
    return null;
  }
  /** How to start a program. Windows cannot start npm's .cmd shims directly (and cmd.exe mangles
   *  long multi-line arguments), so a shim is turned back into "node <script.js>". */
  const launchCache = new Map();
  async function launchSpec(command) {
    if (!IS_WIN || !/\.(cmd|bat)$/i.test(command)) return { command, prefix: [] };
    if (launchCache.has(command)) return launchCache.get(command);
    let spec = null;
    try {
      const text = String(await Zotero.File.getContentsAsync(command));
      const dir = command.replace(/[\\/][^\\/]*$/, "");
      // npm shims: "%~dp0\node_modules\pkg\cli.js" (old) or "%dp0%\node_modules\pkg\cli.js" (new)
      const m = text.match(/"%(?:~dp0|dp0%)\\?([^"%]+?\.(?:js|cjs|mjs))"/i);
      if (m) {
        const script = joinPath(dir, ...m[1].split(/[\\/]/));
        const node = fileExists(joinPath(dir, "node.exe")) ? joinPath(dir, "node.exe") : whichTool("node");
        if (node && fileExists(script)) spec = { command: node, prefix: [script] };
      }
      const e = !spec && [...text.matchAll(/"%(?:~dp0|dp0%)\\?([^"%]+?\.exe)"/gi)].find((x) => !/(^|\\)node\.exe$/i.test(x[1]));
      if (e) {
        const exe = joinPath(dir, ...e[1].split(/[\\/]/));
        if (fileExists(exe)) spec = { command: exe, prefix: [] };
      }
    } catch (e) { LOG("shim parse failed", command, e); }
    if (!spec) {
      const comspec = envVar("ComSpec") || "C:\\Windows\\System32\\cmd.exe";
      spec = { command: comspec, prefix: ["/d", "/s", "/c", command] };
    }
    launchCache.set(command, spec);
    return spec;
  }

  // ---------------------------------------------------------------- proxy for AI command-line tools
  // Zotero started from the Dock / Start menu has no HTTPS_PROXY, and Codex / Claude Code / agy do not read
  // the macOS or Windows *system* proxy. Behind Clash & co. (system-proxy mode, not TUN) they then cannot
  // reach their servers ("Reconnecting… 5/5", "Falling back from WebSockets"). Zotero itself does use the
  // system proxy, so ask its proxy service which proxy it would take and hand that to the CLI.
  const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
  let proxyCache = null;
  /** Pure: environment for a CLI from a Firefox nsIProxyInfo-like {type, host, port}. */
  function proxyEnvFromInfo(pi, isWin = IS_WIN) {
    if (!pi || !pi.host || !(pi.port > 0) || pi.type === "direct") return {};
    const host = /:/.test(pi.host) && !/^\[/.test(pi.host) ? "[" + pi.host + "]" : pi.host;
    const scheme = pi.type === "socks" ? "socks5h" : pi.type === "socks4" ? "socks4" : "http";
    const url = scheme + "://" + host + ":" + pi.port;
    // Windows treats HTTPS_PROXY and https_proxy as the same variable: set each name once there
    const names = isWin ? PROXY_VARS.filter((k) => k === k.toUpperCase()).concat(["NO_PROXY"]) : PROXY_VARS.concat(["NO_PROXY", "no_proxy"]);
    const e = {};
    for (const k of names) e[k] = /^no_proxy$/i.test(k) ? "localhost,127.0.0.1,::1" : url;
    return e;
  }
  async function systemProxyInfo(url) {
    const pps = Components.classes["@mozilla.org/network/protocol-proxy-service;1"]
      .getService(Components.interfaces.nsIProtocolProxyService);
    const ch = env.Services.io.newChannelFromURI(env.Services.io.newURI(url), null,
      env.Services.scriptSecurityManager.getSystemPrincipal(), null,
      Components.interfaces.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL, Components.interfaces.nsIContentPolicy.TYPE_OTHER);
    return new Promise((resolve) => {
      try { pps.asyncResolve(ch, 0, { onProxyAvailable: (req, c, info) => resolve(info) }); } catch (e) { resolve(null); }
      env.setTimeout(() => resolve(null), 3000);
    });
  }
  /** Proxy variables for an AI CLI; {} when the user already exported some, or when there is no proxy. */
  async function aiProxyEnv() {
    if (pref("cliUseSystemProxy") === false) return {};
    if (PROXY_VARS.some((k) => envVar(k))) return {}; // the user's own variables win
    if (proxyCache && Date.now() - proxyCache.at < 60 * 1000) return proxyCache.env;
    let e = {};
    try { e = proxyEnvFromInfo(await systemProxyInfo("https://chatgpt.com/")); } catch (err) { LOG("proxy lookup failed", err); }
    proxyCache = { at: Date.now(), env: e };
    return e;
  }
  /** "127.0.0.1:7897" or "", for messages. */
  async function proxyLabel() {
    const e = await aiProxyEnv();
    if (e.HTTPS_PROXY) return e.HTTPS_PROXY.replace(/^\w+:\/\//, "");
    const own = PROXY_VARS.map(envVar).find(Boolean);
    return own ? own.replace(/^\w+:\/\//, "") + "（环境变量）" : "";
  }
  /** Adds a plain-language hint when a CLI failed because it could not reach its server. */
  async function netHint(text, service) {
    text = String(text || "");
    // login / region problems are not network problems: say so instead of blaming the proxy
    if (/authentication required|not logged in|please log ?in|run '?\w+'? to log ?in|login required|unauthori[sz]ed|\b401\b|invalid api key|OAuth/i.test(text))
      return "\n\n" + service + " 需要重新登录：在终端运行一次它的命令行工具（codex login / claude / agy）完成登录后重试。";
    if (/unsupported (country|region|location)|location is not supported|User location|not available in your (country|region)|不受支持的(国家|地区)|region.{0,20}not supported|\b403\b.{0,80}(region|country)/i.test(text))
      return "\n\n" + service + " 拒绝了当前地区的请求：请把代理节点换到它支持的地区（例如新加坡、日本、美国；Claude 不支持香港）。" +
        (/Gemini/.test(service) ? "如果换了节点仍然不行，可能是你的 Google 账号所在地区不支持 Antigravity：可以在设置里改填 Gemini API Key。" : "");
    if (!/Reconnecting|Falling back from WebSockets|stream disconnected|error sending request|request timed out|timed out|ECONNRESET|ENOTFOUND|getaddrinfo|Connection refused|Network ?Error|fetch failed|超时被终止/i.test(String(text || ""))) return "";
    const p = await proxyLabel();
    return "\n\n看起来 " + service + " 连不上它的服务器。" + (p
      ? "插件已经让它走代理 " + p + "，请确认代理软件正在运行、节点可用。"
      : "插件没有检测到代理：如果你需要通过代理 / VPN 访问 " + service + "，请打开代理软件的「系统代理」或 TUN 模式后重试。");
  }

  /** Pure: bytes → text. CLIs and Python write UTF-8, but cmd.exe and Windows itself answer in the
   *  console code page (GBK on Chinese Windows): "系统找不到指定的路径" used to arrive as mojibake. */
  function decodeOutput(bytes, isWin = IS_WIN) {
    if (!bytes || !bytes.length) return "";
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch (e) {}
    if (isWin) {
      for (const enc of ["gb18030", "big5", "shift_jis", "windows-1252"]) {
        try { return new TextDecoder(enc, { fatal: true }).decode(bytes); } catch (e) {}
      }
    }
    return new TextDecoder("utf-8").decode(bytes);
  }
  function concatBytes(chunks) {
    const n = chunks.reduce((a, c) => a + c.length, 0), out = new Uint8Array(n);
    let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  async function runProcess(command, args, opts = {}) {
    const { Subprocess, setTimeout, clearTimeout } = env;
    const spec = await launchSpec(command);
    const proxyEnv = opts.proxy ? await aiProxyEnv() : {};
    const proc = await Subprocess.call({
      command: spec.command,
      arguments: spec.prefix.concat(args),
      // UTF-8 everywhere: Windows would otherwise give Python a GBK/cp1252 stdout
      environment: Object.assign({ PATH: searchPATH(), NO_COLOR: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }, proxyEnv, opts.env || {}),
      environmentAppend: true,
      workdir: opts.workdir || undefined,
      stderr: "pipe",
    });
    if (opts.onStart) opts.onStart(proc);
    // the CLI may exit early (e.g. rejecting a flag) before reading stdin
    try { if (opts.stdin != null) await proc.stdin.write(opts.stdin); } catch (e) { LOG("stdin write failed", e); }
    try { await proc.stdin.close(); } catch (e) {}
    let killed = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => { killed = true; try { proc.kill(); } catch (e) {} }, opts.timeoutMs)
      : null;
    // raw bytes, decoded once at the end (UTF-8, else the Windows code page); live progress is UTF-8
    const pump = async (pipe) => {
      const chunks = [], live = new TextDecoder("utf-8");
      for (;;) {
        const buf = await pipe.read();
        const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf || 0);
        if (!u8.length) break;
        chunks.push(u8.slice());
        if (opts.onOutput) { const s = live.decode(u8, { stream: true }); if (s) opts.onOutput(s); }
      }
      return decodeOutput(concatBytes(chunks));
    };
    const [stdout, stderr] = await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
    const { exitCode } = await proc.wait();
    if (timer) clearTimeout(timer);
    return { exitCode, stdout, stderr, killed };
  }

  /** Run a CLI; if it rejects an optional flag (older version), drop it and retry. */
  async function runWithFlagFallback(command, buildArgs, optionalFlags, opts) {
    let dropped = new Set();
    for (let attempt = 0; attempt < 30; attempt++) {
      const args = buildArgs(dropped);
      const r = await runProcess(command, args, opts);
      if (r.exitCode === 0) return r;
      const text = r.stderr + "\n" + r.stdout;
      const fm = text.match(/Unknown feature flag:\s*([\w-]+)/i);
      if (fm && !dropped.has("feature:" + fm[1])) { dropped.add("feature:" + fm[1]); continue; }
      const m = text.match(/(?:unexpected argument|unknown option)\s+'([^']+)'/i);
      const bad = m && optionalFlags.find((f) => m[1] === f || m[1].startsWith(f));
      if (bad && !dropped.has(bad)) { LOG("drop unsupported flag", bad); dropped.add(bad); continue; }
      return r;
    }
    throw new Error("CLI 参数重试次数过多");
  }

  // simple semaphore so we never run too many CLI agents at once
  let active = 0;
  const waiters = [];
  async function withCliSlot(fn) {
    const max = Math.max(1, Number(pref("maxParallelCli")) || 2);
    if (active >= max) await new Promise((r) => waiters.push(r));
    active++;
    try { return await fn(); } finally {
      active--;
      const next = waiters.shift();
      if (next) next();
    }
  }

  function tmpDir() { return Zotero.getTempDirectory().path; }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function errText(r) {
    const t = (r.stderr || r.stdout || "").trim().split("\n").filter(Boolean).slice(-6).join("\n");
    return (r.killed ? "超时被终止。" : "退出码 " + r.exitCode + "。") + (t ? "\n" + t : "");
  }

  // Features that only add tool/skill/agent definitions to every request; translation needs none.
  const CODEX_DISABLE = [
    "multi_agent", "apps", "browser_use", "computer_use", "code_mode_host", "plugins", "skill_search",
    "shell_tool", "unified_exec", "image_generation", "view_image", "goals", "tool_suggest",
    "in_app_browser", "sleep_tool", "mentions_v2", "worktrees", "hooks",
  ];
  function buildCodexArgs(outFile, workdir, dropped, instructionsFile, modelOverride, images) {
    const a = ["exec"];
    for (const img of images || []) a.push("-i", img); // before any other flag: -i takes several values
    a.push("--skip-git-repo-check", "--sandbox", "read-only", "-C", workdir, "-o", outFile);
    const opt = (flag, ...rest) => { if (!dropped.has(flag)) a.push(flag, ...rest); };
    opt("--ephemeral");
    opt("--color", "never");
    if (pref("codexLite")) opt("--ignore-user-config");
    for (const f of CODEX_DISABLE) if (!dropped.has("feature:" + f)) a.push("--disable", f);
    if (instructionsFile) a.push("-c", "model_instructions_file=" + JSON.stringify(instructionsFile));
    const model = (modelOverride || pref("codexModel") || "").trim();
    if (model) a.push("-m", model);
    const effort = (pref("codexEffort") || "").trim();
    if (effort) a.push("-c", 'model_reasoning_effort="' + effort + '"');
    a.push("-");
    return a;
  }
  async function callCodex(system, user, images) {
    const codex = resolveTool("codex");
    if (!codex) throw new Error("找不到 Codex CLI，请在设置中填写路径");
    return withCliSlot(async () => {
      const work = tmpDir();
      const id = uid();
      const outFile = joinPath(work, "clitrans-codex-" + id + ".txt");
      const insFile = joinPath(work, "clitrans-codex-" + id + ".md");
      await Zotero.File.putContentsAsync(insFile, system || "You are a helpful assistant.");
      let r;
      try {
        r = await runWithFlagFallback(
          codex, (d) => buildCodexArgs(outFile, work, d, insFile, null, images),
          ["--ephemeral", "--color", "--ignore-user-config"],
          { stdin: user, workdir: work, timeoutMs: (Number(pref("cliTimeoutSec")) || 180) * 1000, proxy: true },
        );
      } finally { try { await IOUtils.remove(insFile); } catch (e) {} }
      let text = "";
      try { text = await Zotero.File.getContentsAsync(outFile); } catch (e) {}
      try { await IOUtils.remove(outFile); } catch (e) {}
      if (r.exitCode !== 0 && !text.trim()) throw new Error("Codex 调用失败：" + errText(r) + await netHint(r.stderr + r.stdout + errText(r), "Codex（OpenAI）"));
      return String(text || r.stdout).trim();
    });
  }
  /** Models the user's Codex account can use, from `codex debug models`. */
  async function listCodexModels() {
    const codex = resolveTool("codex");
    if (!codex) throw new Error("找不到 Codex CLI");
    const r = await runProcess(codex, ["debug", "models"], { workdir: tmpDir(), timeoutMs: 60000, proxy: true });
    const d = JSON.parse(r.stdout);
    return (d.models || []).filter((m) => m.visibility !== "hide")
      .map((m) => ({ id: m.slug, name: m.display_name || m.slug, description: m.description || "" }));
  }

  function buildClaudeArgs(system, dropped) {
    const a = ["-p", "--output-format", "text"];
    const opt = (flag, ...rest) => { if (!dropped.has(flag)) a.push(flag, ...rest); };
    opt("--tools", "");
    opt("--no-session-persistence");
    opt("--strict-mcp-config");
    opt("--setting-sources", "project");
    opt("--disable-slash-commands");
    if (system) a.push("--system-prompt", system);
    const model = (pref("claudeModel") || "").trim();
    if (model) a.push("--model", model);
    return a;
  }
  async function callClaude(system, user) {
    const claude = resolveTool("claude");
    if (!claude) throw new Error("找不到 Claude Code CLI，请在设置中填写路径");
    return withCliSlot(async () => {
      const r = await runWithFlagFallback(
        claude, (d) => buildClaudeArgs(system, d),
        ["--tools", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", "--disable-slash-commands"],
        { stdin: user, workdir: tmpDir(), timeoutMs: (Number(pref("cliTimeoutSec")) || 180) * 1000, proxy: true },
      );
      if (r.exitCode !== 0) throw new Error("Claude Code 调用失败：" + errText(r) + await netHint(r.stderr + r.stdout + errText(r), "Claude Code（Anthropic）"));
      return r.stdout.trim();
    });
  }

  async function callClaudeVision(system, user, images) {
    const claude = resolveTool("claude");
    if (!claude) throw new Error("找不到 Claude Code CLI，请在设置中填写路径");
    const content = [];
    for (const img of images) content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: await fileBase64(img) } });
    content.push({ type: "text", text: user });
    const stdin = JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
    return withCliSlot(async () => {
      const r = await runWithFlagFallback(
        claude, (d) => {
          const a = buildClaudeArgs(system, d);
          a.splice(a.indexOf("--output-format"), 2, "--input-format", "stream-json", "--output-format", "stream-json", "--verbose");
          return a;
        },
        ["--tools", "--no-session-persistence", "--strict-mcp-config", "--setting-sources", "--disable-slash-commands"],
        { stdin, workdir: tmpDir(), timeoutMs: (Number(pref("cliTimeoutSec")) || 180) * 1000, proxy: true },
      );
      let res = null;
      for (const line of String(r.stdout || "").split("\n")) {
        try { const d = JSON.parse(line); if (d && d.type === "result") res = d; } catch (e) {}
      }
      if (!res || res.is_error || !res.result) throw new Error("Claude Code 看图调用失败：" + ((res && res.result) || errText(r)));
      return String(res.result).trim();
    });
  }
  /** Engines that can read a picture (formulas, figures). */
  function visionCapable(engine) {
    if (engine === "codex" || engine === "claude") return true;
    if (engine === "gemini") { const ch = geminiChannel(); return ch === "api" || ch === "agy"; }
    if (engine === "deepseek") return deepseekCanSee();
    return false;
  }
  function callVision(engine, system, user, images) {
    if (engine === "claude") return callClaudeVision(system, user, images);
    if (engine === "gemini") return callGemini(system, user, images);
    if (engine === "deepseek") return callDeepSeek(system, user, images);
    return callCodex(system, user, images);
  }

  const ENGINES = {
    google: { label: "Google", free: true, llm: false },
    codex: { label: "GPT", free: false, llm: true, cli: true },
    claude: { label: "Claude", free: false, llm: true, cli: true },
    gemini: { label: "Gemini", free: false, llm: true },
    deepseek: { label: "DeepSeek", free: false, llm: true },
  };
  function engineLabel(engine) {
    const e = ENGINES[engine];
    if (!e) return engine;
    if (engine === "codex") return e.label + "（" + (pref("codexModel") || "默认") + "）";
    if (engine === "claude") return e.label + "（" + (pref("claudeModel") || "默认") + "）";
    if (engine === "gemini") return e.label + "（" + (geminiChannel() === "agy" ? agyModel() : geminiModel()) + "）";
    if (engine === "deepseek") return e.label + "（" + deepseekModel() + "）";
    return e.label;
  }
  /** Engines removed in 0.3.0 (microsoft, siliconflow) may still be stored in prefs. */
  function defaultEngine() {
    const e = pref("defaultEngine");
    return ENGINES[e] ? e : "google";
  }
  async function callLLM(engine, system, user) {
    if (engine === "codex") return callCodex(system, user);
    if (engine === "claude") return callClaude(system, user);
    if (engine === "gemini") return callGemini(system, user);
    if (engine === "deepseek") return callDeepSeek(system, user);
    throw new Error("未知引擎：" + engine);
  }

  async function translate(text, engine, { raw } = {}) {
    text = raw ? String(text || "") : cleanSelection(text);
    if (!text.trim()) return text;
    engine = engine || defaultEngine();
    const tl = pref("targetLang") || "zh-CN";
    if (engine === "google") return translateGoogle(text, tl);
    if (!ENGINES[engine]) throw new Error("未知引擎：" + engine);
    const gl = glossaryForText(parseGlossary(pref("glossary")), text);
    return callLLM(engine, translatorSystemPrompt(pref("targetLangName") || "简体中文", gl), text);
  }

  // ------------------------------------------- batched LLM translation (whole documents)
  function batchSystemPrompt(langName, glossary) {
    return translatorSystemPrompt(langName, glossary) +
      "\n\nThe input is a JSON object mapping ids to text segments from one academic paper. " +
      "Translate every segment independently and return ONLY a JSON object with exactly the same ids " +
      "mapping to the translations — no code fences, no comments. Copy placeholders and markup such as " +
      "{v1}, {{1}}, <b>…</b>, <style id='1'>…</style> unchanged: each one of a segment must appear in its " +
      "translation exactly once, at the place the formula or styled word belongs. " +
      "If a segment needs no translation (formula, code, name, reference), return it unchanged.";
  }
  function parseBatchResult(text) {
    let t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a < 0 || b <= a) throw new Error("模型没有返回 JSON");
    const obj = JSON.parse(t.slice(a, b + 1));
    const out = {};
    for (const [k, v] of Object.entries(obj)) if (typeof v === "string") out[String(k)] = v;
    return out;
  }
  const BATCH_LIMITS = {
    codex: { items: 40, chars: 9000 },
    claude: { items: 40, chars: 9000 },
    gemini: { items: 40, chars: 9000 },
    deepseek: { items: 40, chars: 9000 },
  };
  const queues = {};
  function enqueueBatch(engine, text) {
    const q = queues[engine] || (queues[engine] = { items: [], chars: 0, timer: null });
    return new Promise((resolve, reject) => {
      q.items.push({ text, resolve, reject });
      q.chars += text.length;
      const lim = BATCH_LIMITS[engine];
      if (q.items.length >= lim.items || q.chars >= lim.chars) flushBatch(engine);
      else if (!q.timer) q.timer = env.setTimeout(() => flushBatch(engine), 600);
    });
  }
  function flushBatch(engine) {
    const q = queues[engine];
    if (!q) return;
    if (q.timer) { env.clearTimeout(q.timer); q.timer = null; }
    const items = q.items.splice(0);
    q.chars = 0;
    if (items.length) runBatch(engine, items).catch((e) => LOG("batch error", e));
  }
  async function runBatch(engine, items, depth = 0) {
    const langName = pref("targetLangName") || "简体中文";
    const all = items.map((i) => i.text).join("\n");
    const sys = batchSystemPrompt(langName, glossaryForText(parseGlossary(pref("glossary")), all));
    const input = {};
    items.forEach((it, i) => (input[String(i + 1)] = it.text));
    let result = {};
    try {
      result = parseBatchResult(await callLLM(engine, sys, JSON.stringify(input, null, 1)));
    } catch (e) {
      if (items.length > 1 && depth < 2) {
        const mid = Math.ceil(items.length / 2);
        await Promise.all([runBatch(engine, items.slice(0, mid), depth + 1), runBatch(engine, items.slice(mid), depth + 1)]);
        return;
      }
      items.forEach((it) => it.reject(e));
      return;
    }
    const missing = [];
    items.forEach((it, i) => {
      const v = result[String(i + 1)];
      if (typeof v === "string" && v.trim()) it.resolve(v);
      else missing.push(it);
    });
    if (missing.length) {
      if (depth < 2) await runBatch(engine, missing, depth + 1);
      else missing.forEach((it) => it.resolve(it.text));
    }
  }
  // ---------------------------------------- segment guards (whole-document translation)
  // pdf2zh_next keeps a paragraph's original typesetting when the "translation" equals the source.
  // So for segments that cannot survive translation (formula-heavy proofs, merged reference lists,
  // broken fragments, or output whose placeholders got damaged) we hand the source text back.
  const PH_RE = /\{\s*v\s*\d+\s*\}|<\s*style\s+id\s*=\s*'\s*\d+\s*'\s*>|<\s*\/\s*style\s*>/g;
  const NON_LATIN_RE = /[Ѐ-ӿ぀-ヿ㐀-鿿가-힯]/;
  function normalizePlaceholders(t) {
    return String(t == null ? "" : t)
      .replace(/[｛{]\s*[vV]\s*(\d+)\s*[｝}]/g, "{v$1}")
      .replace(/<\s*style\s+id\s*=\s*["'‘’“”]\s*(\d+)\s*["'‘’“”]\s*>/gi, "<style id='$1'>")
      .replace(/<\s*\/\s*style\s*>/gi, "</style>");
  }
  function placeholderList(text) {
    return (String(text).match(PH_RE) || []).map((p) => p.replace(/\s+/g, "")).sort();
  }
  function placeholdersIntact(src, out) {
    const a = placeholderList(src), b = placeholderList(out);
    return a.length === b.length && a.every((p, i) => p === b[i]);
  }
  function proseWords(text) {
    return String(text).replace(PH_RE, " ").match(/[A-Za-z]{3,}/g) || [];
  }
  /** A proof or derivation: more formulas than words, or sub/superscripts that the PDF parser split off
   *  as loose letters right after a formula ("{v5}t , {v6}b"). Re-typesetting such a paragraph scrambles
   *  the math, so it is better left exactly as printed. */
  function isFormulaDense(text) {
    if (NON_LATIN_RE.test(text)) return false;
    const t = String(text);
    const n = (t.match(/\{\s*v\s*\d+\s*\}/g) || []).length;
    if (n >= 6 && proseWords(t).length < n) return true;
    return (t.match(/\{\s*v\s*\d+\s*\}[b-z] /g) || []).length >= 2;
  }
  /** One bibliography entry, or several merged into one block by the layout parser. */
  function isReferenceLike(text) {
    const t = String(text).trim();
    const years = (t.match(/\((?:19|20)\d{2}[a-z]?\)/g) || []).length +
      (t.match(/,\s*(?:19|20)\d{2}[a-z]?\./g) || []).length;
    const vols = (t.match(/\b\d+\s*\(\d+(?:[\/–-]\d+)?\)\s*[,:]\s*\d+/g) || []).length;
    const marks = (t.match(/\b(?:Working paper|Ph\.D\. thesis|eds?\.|doi\.org|https?:\/\/)/gi) || []).length;
    if (years >= 3 && vols >= 2) return true;
    const startsLikeEntry = /^(?:\[\d+\]\s*)?[A-Z][A-Za-z'’\-]+,?\s+(?:[A-Z]{1,3}\b|[A-Z]\.)/.test(t);
    return startsLikeEntry && t.length < 700 && years >= 1 && (vols >= 1 || marks >= 1);
  }
  /** A stray piece of a line ("ycara", "{v1}S", "(C.1)") — nothing meaningful to translate. */
  function isFragment(text) {
    const t = String(text).replace(PH_RE, "").trim();
    if (NON_LATIN_RE.test(t) || t.length >= 30) return false;
    if (!/[A-Za-z]/.test(t)) return true;                 // "(C.1)", "37(4)"
    if (/^[a-z][^\s]{0,6}$/.test(t)) return true;         // "etail.", "ycara": the tail of a split word
    return !/[A-Za-z]{4,}/.test(t);                       // "{v1}S", "K (2009) Sh"
  }
  /** U+FFFD / private-use glyphs: the PDF has no Unicode mapping for them (often math minus/relations).
   *  Re-typesetting such a paragraph prints "�", so the in-place layouts keep it as printed. */
  const GARBLED_RE = /[\uFFFD\uE000-\uF8FF]/;
  function segmentGuard(text) {
    if (GARBLED_RE.test(String(text).replace(PH_RE, ""))) return "garbled";
    if (isFragment(text)) return "fragment";
    if (pref("skipReferences") !== false && isReferenceLike(text)) return "refs";
    if (pref("keepFormulaDense") !== false && isFormulaDense(text)) return "formula";
    return null;
  }
  function strictPlaceholderPrompt(langName, glossary) {
    return translatorSystemPrompt(langName, glossary) +
      "\nThe text contains placeholders: {v1}, {v2}… stand for formulas and <style id='1'>…</style> wraps " +
      "formatted words. Every placeholder of the input must appear in your output exactly once and " +
      "unchanged — never add, drop, renumber, merge or translate one. Put each where the formula belongs " +
      "in the translated sentence.";
  }

  const docStats = { total: 0, formula: 0, refs: 0, fragment: 0, broken: 0, garbled: 0 };
  function resetDocStats() { for (const k of Object.keys(docStats)) docStats[k] = 0; }
  function keptSummary() {
    const kept = docStats.formula + docStats.refs + docStats.fragment + docStats.broken + docStats.garbled;
    if (!kept) return "";
    const parts = [];
    if (docStats.formula) parts.push("公式密集 " + docStats.formula);
    if (docStats.refs) parts.push("参考文献 " + docStats.refs);
    if (docStats.broken) parts.push("占位符损坏 " + docStats.broken);
    if (docStats.garbled) parts.push("含无法识别字符 " + docStats.garbled);
    if (docStats.fragment) parts.push("碎片 " + docStats.fragment);
    return "保留原文 " + kept + " 段（" + parts.join("、") + "）";
  }

  const freeLimits = { google: 6 };
  const freeActive = {};
  async function translateSegmentRaw(text, engine) {
    if (engine === "google") {
      const max = freeLimits[engine];
      while ((freeActive[engine] || 0) >= max) await sleep(50);
      freeActive[engine] = (freeActive[engine] || 0) + 1;
      try {
        for (let attempt = 0; ; attempt++) {
          try { return await translate(text, engine, { raw: true }); }
          catch (e) {
            if (attempt >= 2) throw e;
            await sleep(1000 * 2 ** attempt);
          }
        }
      } finally { freeActive[engine]--; }
    }
    if (!BATCH_LIMITS[engine]) throw new Error("未知引擎：" + engine);
    return enqueueBatch(engine, text);
  }
  // ------------------------- vision: paragraph images → translation with LaTeX formulas (GPT / Claude / Gemini)
  // Rebuilding fractions and scripts from PDF glyph positions is guesswork; a multimodal model reads
  // the formula from the picture of the paragraph and writes it as LaTeX, which interleave.py typesets.
  function visionPrompt(langName, glossary) {
    let p =
      "You are a professional academic translator. You are given images of paragraphs from one academic " +
      "paper, labelled [1], [2], … in the order the images are attached. Translate each paragraph into " +
      langName + ". Rules:\n" +
      "- Write EVERY mathematical expression (variables, sub/superscripts, fractions, equations, sets) in LaTeX " +
      "inside $...$, exactly as printed in the image, e.g. $V_i^{FG}=\\frac{\\beta_i}{16}\\left(\\alpha-\\frac{c}{\\beta_i}\\right)^2$. " +
      "A displayed equation on its own line goes inside $$...$$ (with its number, e.g. $$x=y \\qquad (3)$$) and stays at the " +
      "same place in the sentence as in the image: the translated words before it, then the equation, then the words after it " +
      "(e.g. \"…，满足 $$…$$ 其中…\"). Never move an equation to the end or drop it.\n" +
      "- Use only standard math LaTeX (\\frac, ^, _, \\left( \\right), Greek letters, \\max, \\arg\\max, \\overset, \\mathbb, \\mathrm). No \\begin environments.\n" +
      "- Keep citations, numbers and labels such as (i), (ii), Lemma 2 unchanged. Translate only what is in the image.\n" +
      "- Plain text only: no Markdown (no *, **, #, bullet lists), no notes or explanations.\n" +
      "- Output format, nothing else: for each paragraph a line \"@@@ N\" (N = its label number) followed by its translation.";
    if (glossary && glossary.length) {
      p += "\nUse this glossary strictly (source → target):\n" + glossary.map(([a, b]) => "- " + a + " → " + b).join("\n");
    }
    return p;
  }
  function figurePrompt(langName, glossary) {
    let p =
      "You are given the image of a figure from an academic paper. List every distinct piece of text in it " +
      "that a reader needs: panel titles, axis titles, legend entries, labels and annotations. Skip pure numbers " +
      "(axis ticks) and list text that repeats only once. For each, output exactly one line:\n" +
      "<text as printed> => <translation into " + langName + ">\n" +
      "Write every mathematical symbol or expression in LaTeX inside $...$ on BOTH sides, exactly as printed " +
      "(e.g. $K/\\alpha_t$, $\\Gamma_b^*$, $d_t^*$). Output nothing else.";
    if (glossary && glossary.length) {
      p += "\nUse this glossary strictly (source → target):\n" + glossary.map(([a, b]) => "- " + a + " → " + b).join("\n");
    }
    return p;
  }
  function parseVisionResult(text) {
    const out = {};
    const parts = String(text || "").split(/^\s*@@@\s*(\d+)\s*$/m);
    for (let i = 1; i + 1 < parts.length; i += 2) {
      const v = parts[i + 1].trim();
      if (v) out[parts[i]] = v;
    }
    return out;
  }
  const visionQueues = {};  // engine -> { items, timer }
  function enqueueVision(image, text, engine) {
    engine = engine || "codex";
    const q = visionQueues[engine] || (visionQueues[engine] = { items: [], timer: null });
    return new Promise((resolve, reject) => {
      q.items.push({ image, text, resolve, reject });
      if (q.items.length >= 4) flushVision(engine);
      else if (!q.timer) q.timer = env.setTimeout(() => flushVision(engine), 800);
    });
  }
  function flushVision(engine) {
    const q = visionQueues[engine];
    if (!q) return;
    if (q.timer) { env.clearTimeout(q.timer); q.timer = null; }
    const items = q.items.splice(0);
    if (items.length) runVisionBatch(items, 0, engine).catch((e) => LOG("vision batch error", e));
  }
  async function runVisionBatch(items, depth = 0, engine = "codex") {
    const all = items.map((i) => i.text).join("\n");
    const sys = visionPrompt(pref("targetLangName") || "简体中文", glossaryForText(parseGlossary(pref("glossary")), all));
    const user = items.map((it, i) => "[" + (i + 1) + "] (text extracted from the PDF, formulas may be garbled — trust the image): " +
      String(it.text || "").slice(0, 3000)).join("\n\n");
    let result;
    try {
      result = parseVisionResult(await callVision(engine, sys, user, items.map((i) => i.image)));
    } catch (e) {
      if (items.length > 1 && depth < 1) {
        await Promise.all(items.map((it) => runVisionBatch([it], depth + 1, engine)));
        return;
      }
      items.forEach((it) => it.reject(e));
      return;
    }
    const missing = [];
    items.forEach((it, i) => {
      const v = result[String(i + 1)];
      if (v) it.resolve(v);
      else missing.push(it);
    });
    if (missing.length && depth < 1) await Promise.all(missing.map((it) => runVisionBatch([it], depth + 1, engine)));
    else missing.forEach((it) => it.reject(new Error("模型没有返回这一段")));
  }

  /** Translation entry point used by pdf2zh_next and the 逐段对照 builder (one segment per HTTP request).
   *  mode "interleave": the original stays visible above the translation, so formula-heavy text is
   *  translated too and a translation with imperfect placeholders is still better than none. */
  async function translateSegment(text, engine, mode) {
    if (!text || !text.trim()) return text;
    const inter = mode === "interleave";
    if (!inter) docStats.total++;
    const why = inter
      ? (isFragment(text) ? "fragment" : pref("skipReferences") !== false && isReferenceLike(text) ? "refs" : null)
      : segmentGuard(text);
    if (why) { if (!inter) docStats[why]++; return text; }
    let out = normalizePlaceholders(await translateSegmentRaw(text, engine));
    if (placeholdersIntact(text, out)) return out;
    if (ENGINES[engine] && ENGINES[engine].llm) {
      try {
        const gl = glossaryForText(parseGlossary(pref("glossary")), text);
        out = normalizePlaceholders(await callLLM(engine, strictPlaceholderPrompt(pref("targetLangName") || "简体中文", gl), text));
        if (placeholdersIntact(text, out)) return out;
      } catch (e) { LOG("placeholder retry failed", e); }
    }
    if (inter) return out;
    docStats.broken++;
    return text;
  }

  // ---------------------------------------------------------------- notes
  function escapeHTML(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  function noteBlockHTML({ source, translation, engineLabel, pageLabel }) {
    const meta = [engineLabel, pageLabel ? "p. " + pageLabel : ""].filter(Boolean).join(" · ");
    return "<blockquote><p>" + escapeHTML(source) + "</p></blockquote>" +
      "<p>" + escapeHTML(translation).replace(/\n/g, "<br/>") + "</p>" +
      (meta ? '<p><span style="color:#888">— ' + escapeHTML(meta) + "</span></p>" : "") + "<hr/>";
  }
  async function saveToNote({ attachmentID, source, translation, engine, pageLabel }) {
    return appendNoteBlock(attachmentID, noteBlockHTML({ source, translation, engineLabel: engineLabel(engine), pageLabel }));
  }
  /** Pure: one Q&A exchange about a paragraph, as note HTML. */
  function qaNoteBlockHTML({ source, question, answer, engineLabel, pageLabel }) {
    const meta = ["AI 问答", engineLabel, pageLabel ? "p. " + pageLabel : ""].filter(Boolean).join(" · ");
    return "<blockquote><p>" + escapeHTML(source) + "</p></blockquote>" +
      "<p><strong>问：</strong>" + escapeHTML(question) + "</p>" +
      "<p><strong>答：</strong>" + escapeHTML(answer).replace(/\n/g, "<br/>") + "</p>" +
      '<p><span style="color:#888">— ' + escapeHTML(meta) + "</span></p><hr/>";
  }
  async function saveQAToNote({ attachmentID, source, question, answer, engine, pageLabel }) {
    return appendNoteBlock(attachmentID, qaNoteBlockHTML({ source, question, answer, engineLabel: engineLabel(engine), pageLabel }));
  }
  async function appendNoteBlock(attachmentID, block) {
    const att = Zotero.Items.get(attachmentID);
    const parent = att && att.parentItem;
    const title = pref("noteTitle") || "划词翻译笔记";
    let note = null;
    if (parent) {
      for (const id of parent.getNotes()) {
        const n = Zotero.Items.get(id);
        if (n && n.getNoteTitle() === title) { note = n; break; }
      }
    }
    if (note) {
      const html = note.getNote();
      const merged = html.includes("</div>")
        ? html.replace(/<\/div>\s*$/, block + "</div>")
        : html + block;
      note.setNote(merged);
    } else {
      note = new Zotero.Item("note");
      note.libraryID = att ? att.libraryID : Zotero.Libraries.userLibraryID;
      if (parent) note.parentID = parent.id;
      note.setNote('<div data-schema-version="9"><h1>' + escapeHTML(title) + "</h1>" + block + "</div>");
    }
    await note.saveTx();
    return note;
  }

  // ------------------------------------------------- paragraph Q&A (ask an LLM about this paragraph)
  // Borrowed from llm-for-zotero: quick-action prompts, answers grounded in the paper (title, abstract,
  // the page around the paragraph), follow-up questions, saving an exchange to the item's note.
  const QA_ENGINES = ["codex", "claude", "gemini", "deepseek"];
  const QA_QUICK = [
    ["解释这一段", "请解释这一段在说什么，抓住核心观点和论证逻辑。"],
    ["公式 / 符号", "这一段里的公式、符号或变量分别是什么意思？逐个说明，并解释公式表达的含义。", "para"],
    ["图表解读", "请解读这一页上的图或表：它展示了什么、关键数字或趋势是什么、和这一段的论点有什么关系。", "page"],
    ["说得通俗点", "请用通俗易懂的话，把这一段讲给非本专业的人听。"],
    ["在全文的作用", "这一段在整篇论文里起什么作用？和前后文是什么关系？"],
    ["局限与疑问", "这一段的方法、假设或结论可能有哪些局限？读者可以追问什么？"],
  ];
  function qaEngine() {
    for (const e of [pref("qaEngine"), pref("paraEngine"), pref("defaultEngine")]) if (QA_ENGINES.includes(e)) return e;
    return (pref("deepseekApiKey") || "").trim() ? "deepseek" : "codex";
  }
  /** Pure */
  function qaSystemPrompt(langName) {
    return "You are a careful research assistant helping a reader understand one paragraph of an academic paper. " +
      "Answer in " + (langName || "简体中文") + ". Base the answer on the paper context provided; when you add general " +
      "knowledge that is not in the paper, say so in a few words. If the context cannot answer the question, say that " +
      "plainly instead of guessing. Be concise (about 200 words unless the reader asks for more). Formatting: write every " +
      "formula, variable and symbol in LaTeX — inline as $…$, an important equation on its own line as $$…$$; to explain " +
      "symbols use a bullet list like \"- $c_1$：meaning\"; for numbers from a table or figure you may use a small Markdown " +
      "table. Use short paragraphs or bullet lists; no headings, no preamble, no closing pleasantries. If an image is " +
      "attached, it shows the text exactly as printed: trust it over the extracted text for formulas, symbols, figures and tables.";
  }
  /** Pure: the user message for one question, with the paper context and the conversation so far. */
  function buildQAPrompt({ title, abstract, pageText, paragraph, translation, history, question, imageNote }) {
    const cut = (s, n) => { s = String(s || "").trim(); return s.length > n ? s.slice(0, n) + " …" : s; };
    const parts = [];
    if (title) parts.push("Paper title: " + cut(title, 300));
    if (abstract) parts.push("Abstract:\n" + cut(abstract, 1800));
    if (pageText) parts.push("Text of the page that contains the paragraph (extracted from the PDF, may be imperfect):\n" + cut(pageText, 6000));
    parts.push("The paragraph the reader is asking about:\n\"\"\"\n" + cut(paragraph, 4000) + "\n\"\"\"");
    if (translation) parts.push("Its translation:\n" + cut(translation, 3000));
    const turns = (history || []).slice(-6);
    if (turns.length) parts.push("Conversation so far:\n" + turns.map((t) => "Q: " + cut(t.q, 800) + "\nA: " + cut(t.a, 1500)).join("\n\n"));
    if (imageNote) parts.push(imageNote);
    parts.push("Reader's question: " + String(question || "").trim());
    return parts.join("\n\n");
  }
  /** Pure: does extracted paragraph text carry formulas whose layout the text has probably lost? */
  function looksMathy(t) {
    t = String(t || "");
    const sym = (t.match(/[=<>≤≥≠≈∑∏∫∂√±×÷∈∉⊂∀∃∞λμσαβγδεθπρτφωΛΔΣΩ∗′^_]/g) || []).length;
    const vars = (t.match(/(?:^|[\s(])[A-Za-z](?:\s?[0-9]|\b)(?=[\s),.;:<>=+\-])/g) || []).length;
    return sym >= 2 || (sym >= 1 && vars >= 2) || vars >= 6;
  }
  /** PNG of a paragraph (pdf rect, padded) or of the whole page, cut from what pdf.js has drawn. */
  async function snapshotPage(view, rect, w) {
    const canvas = view && (view.canvas || (view.div && view.div.querySelector("canvas")));
    if (!canvas || !canvas.width) return null;
    const sx = canvas.width / view.viewport.width, sy = canvas.height / view.viewport.height;
    let x = 0, y = 0, cw = canvas.width, ch = canvas.height;
    if (rect) {
      const [a, b, c, d, e, f] = Array.from(view.viewport.transform, Number);
      const p1 = [a * rect[0] + c * rect[1] + e, b * rect[0] + d * rect[1] + f], p2 = [a * rect[2] + c * rect[3] + e, b * rect[2] + d * rect[3] + f];
      const pad = 10;
      x = Math.max(0, (Math.min(p1[0], p2[0]) - pad) * sx); y = Math.max(0, (Math.min(p1[1], p2[1]) - pad) * sy);
      cw = Math.min(canvas.width - x, (Math.abs(p2[0] - p1[0]) + 2 * pad) * sx); ch = Math.min(canvas.height - y, (Math.abs(p2[1] - p1[1]) + 2 * pad) * sy);
    }
    const out = canvas.ownerDocument.createElement("canvas");
    const k = Math.min(1, 1600 / Math.max(cw, ch)); // keep images small: faster, cheaper
    out.width = Math.max(1, Math.round(cw * k)); out.height = Math.max(1, Math.round(ch * k));
    const g = out.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, out.width, out.height);
    g.drawImage(canvas, x, y, cw, ch, 0, 0, out.width, out.height);
    const blob = await new Promise((res) => out.toBlob(res, "image/png"));
    if (!blob) return null;
    const path = joinPath(tmpDir(), "verso-qa-" + uid() + ".png");
    await IOUtils.write(path, new Uint8Array(await blob.arrayBuffer()));
    return path;
  }
  /** Pure-ish: plain text of a page from Zotero's char list (for context). */
  function pageTextOf(chars) {
    let t = "";
    for (const c of chars || []) { t += c.c == null ? "" : c.c; if (c.lineBreakAfter) t += "\n"; else if (c.spaceAfter) t += " "; }
    return t.replace(/-\n(?=[a-z])/g, "").replace(/\n(?!\n)/g, " ").replace(/[ \t]+/g, " ").trim();
  }
  // LaTeX → MathML with KaTeX (MIT, content/lib). Firefox draws MathML natively, so no fonts or CSS are needed.
  let katexLib = null;
  function katex() {
    if (katexLib === null) {
      try {
        const scope = { module: { exports: {} }, exports: {} };
        env.Services.scriptloader.loadSubScript(env.rootURI + "content/lib/katex.min.js", scope);
        katexLib = scope.module.exports && scope.module.exports.renderToString ? scope.module.exports : false;
      } catch (e) { LOG("KaTeX load failed", e); katexLib = false; }
    }
    return katexLib || null;
  }
  /** Pure: split text into [{t:"text"|"math"|"dmath", v}] — $…$, \(…\), $$…$$, \[…\]. money stays text (see the regex). */
  function splitMath(text) {
    const out = [], re = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g; // money stays text: "$5 and $10", "$5$10"
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push({ t: "text", v: text.slice(last, m.index) });
      if (m[1] != null || m[2] != null) out.push({ t: "dmath", v: (m[1] != null ? m[1] : m[2]).trim() });
      else out.push({ t: "math", v: (m[3] != null ? m[3] : m[4]).trim() });
      last = re.lastIndex;
    }
    if (last < text.length) out.push({ t: "text", v: text.slice(last) });
    return out;
  }
  function mathNode(doc, tex, display) {
    const k = katex();
    if (k) {
      try {
        const html = k.renderToString(tex, { output: "mathml", displayMode: !!display, throwOnError: false, strict: "ignore" });
        const parsed = new doc.defaultView.DOMParser().parseFromString("<body>" + html + "</body>", "text/html");
        const math = parsed.querySelector("math");
        if (math && !parsed.querySelector(".katex-error")) {
          const node = doc.importNode(math, true);
          node.style.cssText = display ? "display:block;margin:6px 0;font-size:1.08em;overflow-x:auto;" : "font-size:1.05em;";
          return node;
        }
      } catch (e) { LOG("KaTeX render failed", e); }
    }
    const c = doc.createElement("code"); // fallback: show the LaTeX, without the dollar signs
    c.textContent = tex;
    c.style.cssText = "font-size:.92em;padding:0 3px;border-radius:3px;background:rgba(15,110,110,.10);";
    return c;
  }
  /** Minimal Markdown → DOM: paragraphs, lists, tables, **bold**, `code`, LaTeX math; never innerHTML of model text. */
  function renderAnswer(doc, text) {
    const frag = doc.createDocumentFragment();
    const inline = (el, s) => {
      for (const seg of splitMath(String(s))) {
        if (seg.t !== "text") { el.appendChild(mathNode(doc, seg.v, seg.t === "dmath")); continue; }
        inlineText(el, seg.v);
      }
    };
    const inlineText = (el, s) => {
      for (const tok of String(s).split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
        if (!tok) continue;
        if (/^\*\*[^*]+\*\*$/.test(tok)) { const b = doc.createElement("strong"); inline(b, tok.slice(2, -2)); el.appendChild(b); }
        else if (/^`[^`]+`$/.test(tok)) { const c = doc.createElement("code"); c.textContent = tok.slice(1, -1); c.style.cssText = "font-size:.92em;padding:0 3px;border-radius:3px;background:rgba(15,110,110,.10);"; el.appendChild(c); }
        else el.appendChild(doc.createTextNode(tok));
      }
    };
    // $$ … $$ blocks may span lines: put each on a line of its own first
    const src = String(text || "").replace(/\r/g, "")
      .replace(/\$\$([\s\S]+?)\$\$/g, (m0, b) => "\n$$" + b.replace(/\n/g, " ") + "$$\n")
      .replace(/\\\[([\s\S]+?)\\\]/g, (m0, b) => "\n$$" + b.replace(/\n/g, " ") + "$$\n");
    const lines = src.split("\n");
    let list = null;
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li].replace(/^#{1,6}\s+/, "");
      // Markdown table: consecutive lines that start with "|"
      if (/^\s*\|.*\|\s*$/.test(line)) {
        const rows = [];
        while (li < lines.length && /^\s*\|.*\|\s*$/.test(lines[li])) rows.push(lines[li++]);
        li--;
        const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        const body = rows.filter((r) => !/^[\s|:-]+$/.test(r)); // drop the |---|---| separator row
        const table = doc.createElement("table");
        table.style.cssText = "border-collapse:collapse;margin:4px 0 8px;font-size:12.8px;width:100%;";
        body.forEach((r, ri) => {
          const tr = doc.createElement("tr");
          for (const c of cells(r)) {
            const td = doc.createElement(ri === 0 ? "th" : "td");
            td.style.cssText = "border:1px solid rgba(15,110,110,.25);padding:3px 6px;text-align:left;vertical-align:top;" + (ri === 0 ? "background:rgba(15,110,110,.08);font-weight:600;" : "");
            inline(td, c);
            tr.appendChild(td);
          }
          table.appendChild(tr);
        });
        frag.appendChild(table);
        list = null;
        continue;
      }
      // a line that is only display math
      const dm = line.trim().match(/^\$\$([\s\S]+)\$\$$/);
      if (dm) { list = null; frag.appendChild(mathNode(doc, dm[1].trim(), true)); continue; }
      const m = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (m) {
        if (!list) { list = doc.createElement(/^\s*\d/.test(line) ? "ol" : "ul"); list.style.cssText = "margin:2px 0 6px;padding-left:20px;"; frag.appendChild(list); }
        const li = doc.createElement("li"); inline(li, m[1]); list.appendChild(li);
        continue;
      }
      list = null;
      if (!line.trim()) continue;
      const p = doc.createElement("div"); p.style.cssText = "margin:0 0 6px;"; inline(p, line); frag.appendChild(p);
    }
    return frag;
  }
  /** The Q&A area of a paragraph card. ctx() → {title, abstract, pageText, paragraph, translation}. */
  function buildQAPanel(doc, { theme, ctx, attachmentID, pageLabel }) {
    const T = THEMES[theme] || THEMES.teal;
    const root = doc.createElement("div");
    root.style.cssText = "margin-top:10px;padding-top:9px;border-top:1px dashed " + T.line + ";font-family:system-ui,sans-serif;";
    const quick = doc.createElement("div");
    quick.style.cssText = "display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px;";
    const log = doc.createElement("div");
    log.style.cssText = "max-height:340px;overflow:auto;display:flex;flex-direction:column;gap:8px;";
    const row = doc.createElement("div");
    row.style.cssText = "display:flex;gap:6px;align-items:flex-end;margin-top:8px;";
    const input = doc.createElement("textarea");
    input.rows = 1;
    input.placeholder = "就这一段提问…（Enter 发送，Shift+Enter 换行）";
    input.style.cssText = "flex:1;min-width:0;resize:none;box-sizing:border-box;font:13.5px/1.5 system-ui,sans-serif;padding:6px 9px;" +
      "border-radius:8px;border:1px solid " + T.line + ";background:#FFFFFF;color:#1C1B19;max-height:120px;outline:none;";
    const send = mkPill(doc, "发送", () => ask(input.value));
    send.style.background = T.onBg; send.style.color = T.onFg; send.style.borderColor = T.onBg;
    const meta = doc.createElement("div");
    meta.style.cssText = "display:flex;flex-wrap:wrap;gap:5px;align-items:center;margin-top:7px;font-size:11.5px;color:" + T.sub + ";";
    const engLbl = doc.createElement("span");
    engLbl.textContent = "回答引擎：";
    meta.appendChild(engLbl);
    let engine = qaEngine();
    const engBtns = {};
    const paintEng = () => {
      for (const [k, b] of Object.entries(engBtns)) {
        const on = k === engine;
        b.style.background = on ? T.onBg : "transparent"; b.style.color = on ? T.onFg : T.fg; b.style.borderColor = on ? T.onBg : T.line;
      }
    };
    for (const k of QA_ENGINES) {
      engBtns[k] = mkPill(doc, ENGINES[k].label, () => { engine = k; paintEng(); });
      engBtns[k].style.fontSize = "11.5px"; engBtns[k].style.padding = "2px 9px";
      meta.appendChild(engBtns[k]);
    }
    paintEng();
    for (const [label, q, pic] of QA_QUICK) {
      const b = mkPill(doc, label, () => ask(q, label, pic));
      b.style.borderColor = T.line;
      quick.appendChild(b);
    }
    // pdf.js / the reader react to single keys (n, p, arrows…): keep typing inside the box
    for (const type of ["keydown", "keyup", "keypress"]) input.addEventListener(type, (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(input.value); }
    });
    input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(120, input.scrollHeight + 2) + "px"; });

    const history = [];
    let busy = false;
    const bubble = (who, text) => {
      const b = doc.createElement("div");
      b.style.cssText = who === "q"
        ? "align-self:flex-end;max-width:88%;padding:6px 10px;border-radius:10px 10px 2px 10px;font-size:13.5px;line-height:1.55;" +
          "background:" + T.onBg + ";color:" + T.onFg + ";white-space:pre-wrap;word-break:break-word;"
        : "align-self:stretch;padding:8px 11px;border-radius:2px 10px 10px 10px;font-size:13.8px;line-height:1.65;" +
          "background:rgba(255,255,255,.78);color:#1C1B19;word-break:break-word;user-select:text;-moz-user-select:text;cursor:text;";
      if (text != null) b.textContent = text;
      log.appendChild(b);
      log.scrollTop = log.scrollHeight;
      return b;
    };
    async function ask(question, shown, pic) {
      question = String(question || "").trim();
      if (!question || busy) return;
      busy = true; input.value = ""; input.style.height = "auto"; send.textContent = "…";
      bubble("q", shown || question);
      const a = bubble("a", null);
      const st = doc.createElement("div");
      st.style.cssText = "font-size:12px;color:#7A746A;";
      st.textContent = engineLabel(engine) + " 思考中…" + (ENGINES[engine].cli ? "约需几秒到十几秒" : "");
      a.appendChild(st);
      anim(st, [{ opacity: 0.4 }, { opacity: 1 }, { opacity: 0.4 }], { duration: 1200, iterations: Infinity });
      const t0 = Date.now(), eng = engine;
      try {
        const c = await ctx();
        // formulas and figures: let a vision engine look at the printed paragraph / page
        const want = pic || (c.mathy ? "para" : "");
        let images = [], imageNote = "", noVision = "";
        if (want && pref("qaVision") !== false && c.snapshot) {
          if (visionCapable(eng)) {
            const img = await c.snapshot(want).catch((e) => { LOG("snapshot failed", e); return null; });
            if (img) {
              images = [img];
              imageNote = want === "page" ? "Attached image: the whole PDF page as printed (read its figures and tables from it)."
                : "Attached image: the paragraph exactly as printed in the PDF (read formulas and symbols from it).";
            }
          } else noVision = engineLabel(eng) + " 不能看图，本次只根据提取的文字回答";
        }
        if (noVision) st.textContent += "（" + noVision + "）";
        const sys = qaSystemPrompt(pref("targetLangName") || "简体中文");
        const user = buildQAPrompt(Object.assign({}, c, { history, question, imageNote }));
        const text = String(images.length ? await callVision(eng, sys, user, images) : await callLLM(eng, sys, user)).trim();
        history.push({ q: question, a: text });
        a.textContent = "";
        a.appendChild(renderAnswer(doc, text));
        const foot = doc.createElement("div");
        foot.style.cssText = "display:flex;gap:5px;align-items:center;margin-top:4px;font-size:11px;color:#7A746A;";
        const lbl = doc.createElement("span");
        lbl.textContent = engineLabel(eng) + (images.length ? " · 看图" : "") + " · " + ((Date.now() - t0) / 1000).toFixed(1) + "s";
        lbl.style.marginRight = "auto";
        const cp = mkPill(doc, "复制", (b) => { try { Zotero.Utilities.Internal.copyTextToClipboard(text); b.textContent = "已复制 ✓"; } catch (e) {} });
        const sv = mkPill(doc, "存入笔记", async (b) => {
          try {
            await saveQAToNote({ attachmentID, source: cleanSelection(c.paragraph), question, answer: text, engine: eng, pageLabel });
            b.textContent = "已存入 ✓";
          } catch (e) { b.textContent = "失败"; LOG(e); }
        });
        for (const b of [cp, sv]) { b.style.fontSize = "11px"; b.style.padding = "1px 8px"; b.style.borderColor = "rgba(0,0,0,.18)"; b.style.color = "#1C1B19"; }
        foot.append(lbl, cp, sv);
        a.appendChild(foot);
        anim(a, [{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], { duration: 220, easing: "ease-out" });
      } catch (e) {
        a.textContent = "⚠️ " + ((e && e.message) || e);
        LOG(e);
      } finally {
        busy = false; send.textContent = "发送";
        log.scrollTop = log.scrollHeight;
        try { input.focus(); } catch (e) {}
      }
    }
    row.append(input, send);
    root.append(quick, log, row, meta);
    return { root, ask, focus: () => { try { input.focus(); } catch (e) {} } };
  }

  // ------------------------------------------------- translate panel (shared UI)
  const UI = { ink: "#1C1B19", red: "#D8432E", teal: "#0F6E6E", tealSoft: "#E4F1EE", tealText: "#0B4A4A" };
  const THEMES = {
    dark: { fg: "#FFFFFF", sub: "rgba(255,255,255,.62)", line: "rgba(255,255,255,.26)", onBg: "#FFFFFF", onFg: UI.ink, accent: UI.red },
    teal: { fg: UI.tealText, sub: "rgba(11,74,74,.66)", line: "rgba(15,110,110,.34)", onBg: UI.teal, onFg: "#FFFFFF", accent: UI.teal },
  };
  function anim(el, frames, opts) {
    try { return el.animate(frames, opts); } catch (e) { return null; }
  }
  function mkPill(doc, label, onClick) {
    const b = doc.createElement("button");
    b.textContent = label;
    b.style.cssText =
      "font:500 12px/1.4 system-ui,sans-serif;padding:3px 10px;border-radius:999px;border:1px solid transparent;" +
      "background:transparent;color:inherit;cursor:pointer;white-space:nowrap;margin:0;min-width:0;" +
      "appearance:none;-moz-appearance:none;";
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onClick(b); });
    b.addEventListener("mousedown", (e) => e.stopPropagation());
    return b;
  }
  /** Translation text + engine pills + copy / save-to-note. Used by the selection popup ("dark") and the
   *  paragraph card ("teal"). */
  function buildTranslatePanel(doc, { source, attachmentID, pageLabel, engine, auto, theme, onClose, qa, vision }) {
    const T = THEMES[theme] || THEMES.dark;
    const root = doc.createElement("div");
    root.style.cssText = "font-family:system-ui,sans-serif;text-align:left;color:" + T.fg + ";";
    const result = doc.createElement("div");
    result.style.cssText =
      "font-size:14.5px;line-height:1.7;max-height:280px;overflow:auto;white-space:pre-wrap;" +
      "word-break:break-word;user-select:text;-moz-user-select:text;cursor:text;";
    const loader = doc.createElement("div");
    loader.style.cssText = "display:none;padding:5px 0 3px;";
    [100, 92, 58].forEach((wd, i) => {
      const bar = doc.createElement("div");
      bar.style.cssText = "height:9px;border-radius:5px;margin-bottom:8px;width:" + wd + "%;background:" + T.line + ";";
      anim(bar, [{ opacity: 0.35 }, { opacity: 1 }, { opacity: 0.35 }], { duration: 1100, iterations: Infinity, delay: i * 160 });
      loader.appendChild(bar);
    });
    const foot = doc.createElement("div");
    foot.style.cssText = "display:flex;flex-wrap:wrap;gap:5px;align-items:center;margin-top:9px;";
    const status = doc.createElement("span");
    status.style.cssText = "font-size:11.5px;color:" + T.sub + ";margin-right:4px;white-space:nowrap;";
    const acts = doc.createElement("div"); // status + actions wrap to the next line together
    acts.style.cssText = "display:flex;gap:5px;align-items:center;margin-left:auto;";

    let current = { engine: null, text: "" };
    let runSeq = 0; // only the latest click may update the panel
    const engineBtns = {};
    const paint = (eng) => {
      for (const [k, b] of Object.entries(engineBtns)) {
        const on = k === eng;
        b.style.background = on ? T.onBg : "transparent";
        b.style.color = on ? T.onFg : T.fg;
        b.style.borderColor = on ? T.onBg : T.line;
      }
    };
    const run = async (eng) => {
      const seq = ++runSeq;
      paint(eng);
      result.textContent = "";
      loader.style.display = "block";
      status.textContent = engineLabel(eng) + " 翻译中…" + (ENGINES[eng].cli ? "约需几秒" : "");
      const t0 = Date.now();
      try {
        // paragraphs with formulas: the extracted text has lost fractions and scripts, so a vision engine
        // translates from a picture of the printed paragraph and writes the math as LaTeX (rendered below)
        let viaImage = false, text = null;
        if (vision && pref("paraVisionFormulas") !== false && visionCapable(eng) && looksMathy(source)) {
          const img = await vision.snapshot().catch((e) => { LOG("snapshot failed", e); return null; });
          if (img) {
            try {
              text = await callVision(eng, paraVisionPrompt(pref("targetLangName") || "简体中文",
                glossaryForText(parseGlossary(pref("glossary")), source)), "Extracted text (formulas may be garbled — trust the image):\n" + source, [img]);
              viaImage = true;
            } catch (e) { LOG("vision translation failed, falling back to text", e); }
          }
        }
        if (text == null) text = await translate(source, eng);
        if (seq !== runSeq) return;
        const clean = String(text).replace(/<\/?(?:sup|sub|b|i|em|strong|span|p|br)\b[^>]*>/gi, "").trim();
        current = { engine: eng, text: clean };
        loader.style.display = "none";
        result.textContent = "";
        if (viaImage || splitMath(clean).some((x) => x.t !== "text")) result.appendChild(renderAnswer(doc, clean));
        else result.textContent = clean;
        anim(result, [{ opacity: 0, transform: "translateY(5px)" }, { opacity: 1, transform: "none" }], { duration: 240, easing: "ease-out" });
        status.textContent = "Verso · " + engineLabel(eng) + (viaImage ? " · 看图" : "") + " · " + ((Date.now() - t0) / 1000).toFixed(1) + "s";
      } catch (e) {
        if (seq !== runSeq) { LOG(e); return; }
        loader.style.display = "none";
        status.textContent = "";
        result.textContent = "⚠️ " + (e && e.message ? e.message : e);
        LOG(e);
      }
    };

    for (const k of Object.keys(ENGINES)) {
      engineBtns[k] = mkPill(doc, ENGINES[k].label, () => run(k));
      foot.appendChild(engineBtns[k]);
    }
    paint(null);
    acts.appendChild(status);
    const copy = mkPill(doc, "复制", (b) => {
      if (!current.text) return;
      try { Zotero.Utilities.Internal.copyTextToClipboard(current.text); b.textContent = "已复制 ✓"; } catch (e) {}
    });
    copy.style.borderColor = T.line;
    const save = mkPill(doc, "存入笔记", async (b) => {
      if (!current.text) return;
      try {
        await saveToNote({ attachmentID, source: cleanSelection(source), translation: current.text, engine: current.engine, pageLabel });
        b.textContent = "已存入 ✓";
        anim(b, [{ transform: "scale(1)" }, { transform: "scale(1.12)" }, { transform: "scale(1)" }], { duration: 320 });
      } catch (e) { b.textContent = "失败"; LOG(e); }
    });
    save.style.background = T.accent;
    save.style.borderColor = T.accent;
    save.style.color = "#FFFFFF";
    if (qa && pref("qaEnabled") !== false) {
      let qp = null;
      const askBtn = mkPill(doc, "问 AI", () => {
        if (!qp) {
          qp = buildQAPanel(doc, { theme, attachmentID, pageLabel,
            ctx: async () => Object.assign({}, await qa.context(), { paragraph: source, translation: current.text }) });
          root.appendChild(qp.root);
          anim(qp.root, [{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }], { duration: 200 });
          askBtn.textContent = "收起问答";
          qp.focus();
        } else {
          const hide = qp.root.style.display !== "none";
          qp.root.style.display = hide ? "none" : "";
          askBtn.textContent = hide ? "问 AI" : "收起问答";
          if (!hide) qp.focus();
        }
      });
      askBtn.title = "就这一段向大模型提问（GPT / Claude / Gemini / DeepSeek）";
      askBtn.style.borderColor = T.accent;
      askBtn.style.color = T.accent;
      askBtn.style.fontWeight = "600";
      acts.appendChild(askBtn);
    }
    acts.append(copy, save);
    foot.appendChild(acts);
    if (onClose) {
      const x = mkPill(doc, "✕", onClose);
      x.title = "收起";
      x.style.padding = "3px 7px";
      acts.appendChild(x);
    }

    root.append(result, loader, foot);
    if (auto) run(ENGINES[engine] ? engine : defaultEngine());
    return { root, run };
  }

  // ------------------------------------------------------- reader popup
  function buildPopup(event) {
    const { reader, doc, params, append } = event;
    const source = params && params.annotation && params.annotation.text;
    if (!source || !source.trim()) return;
    const panel = buildTranslatePanel(doc, {
      source, attachmentID: reader.itemID, pageLabel: params.annotation.pageLabel,
      engine: defaultEngine(), auto: !!pref("autoTranslate"), theme: "dark",
    });
    panel.root.style.cssText +=
      "box-sizing:border-box;width:360px;max-width:360px;padding:13px 15px 11px;margin:6px 0 2px;" +
      "border-radius:12px;background:" + UI.ink + ";box-shadow:0 8px 22px rgba(0,0,0,.30);";
    append(panel.root);
    anim(panel.root, [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 200, easing: "ease-out" });
  }

  // ------------------------------------- paragraph translation (modifier key + click)
  /** Pure: the paragraph around a PDF point, from Zotero's per-page char list. */
  function findParagraph(chars, x, y) {
    if (!Array.isArray(chars) || !chars.length) return null;
    let hit = -1, best = Infinity;
    for (let i = 0; i < chars.length; i++) {
      const r = chars[i].rect;
      if (!r) continue;
      const dx = x < r[0] ? r[0] - x : x > r[2] ? x - r[2] : 0;
      const dy = y < r[1] ? r[1] - y : y > r[3] ? y - r[3] : 0;
      const d = dx * dx + dy * dy;
      if (d < best) { best = d; hit = i; if (!d) break; }
    }
    if (hit < 0 || best > 30 * 30) return null;
    // Zotero's paragraphBreakAfter misses breaks between justified paragraphs, so rebuild lines and
    // also break at indents, short last lines and large vertical gaps (PDF space: y grows upward).
    const lines = [];
    let cur = null;
    for (let i = 0; i < chars.length; i++) {
      const r = chars[i].rect;
      if (!cur) cur = { a: i, b: i, r: r ? r.slice() : [Infinity, Infinity, -Infinity, -Infinity] };
      cur.b = i;
      if (r) {
        cur.r[0] = Math.min(cur.r[0], r[0]); cur.r[1] = Math.min(cur.r[1], r[1]);
        cur.r[2] = Math.max(cur.r[2], r[2]); cur.r[3] = Math.max(cur.r[3], r[3]);
      }
      if (chars[i].lineBreakAfter || chars[i].paragraphBreakAfter || i === chars.length - 1) {
        cur.pb = !!chars[i].paragraphBreakAfter;
        lines.push(cur);
        cur = null;
      }
    }
    const L = lines.findIndex((l) => hit >= l.a && hit <= l.b);
    const h = Math.max(4, lines[L].r[3] - lines[L].r[1]);
    const near = (up, down) => {
      const ov = Math.min(up.r[2], down.r[2]) - Math.max(up.r[0], down.r[0]);
      const gap = up.r[1] - down.r[3];
      return ov > 0.4 * Math.min(up.r[2] - up.r[0], down.r[2] - down.r[0]) && gap < 0.9 * h && gap > -0.6 * h;
    };
    let lo = L, hi = L;
    while (lo > 0 && near(lines[lo - 1], lines[lo])) lo--;
    while (hi < lines.length - 1 && near(lines[hi], lines[hi + 1])) hi++;
    let left = Infinity, right = -Infinity;
    for (let k = lo; k <= hi; k++) { left = Math.min(left, lines[k].r[0]); right = Math.max(right, lines[k].r[2]); }
    const breaksBetween = (up, down) =>
      up.pb || down.r[0] - left > 0.8 * h || right - up.r[2] > 2.2 * h;
    let a = L, b = L;
    while (a > lo && !breaksBetween(lines[a - 1], lines[a])) a--;
    while (b < hi && !breaksBetween(lines[b], lines[b + 1])) b++;
    a = lines[a].a;
    b = lines[b].b;
    let text = "";
    const rect = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = a; i <= b; i++) {
      const c = chars[i];
      text += c.c == null ? "" : c.c;
      if (c.lineBreakAfter) text += "\n";
      else if (c.spaceAfter) text += " ";
      const r = c.rect;
      if (r) {
        rect[0] = Math.min(rect[0], r[0]); rect[1] = Math.min(rect[1], r[1]);
        rect[2] = Math.max(rect[2], r[2]); rect[3] = Math.max(rect[3], r[3]);
      }
    }
    return { text, rect, start: a, end: b };
  }
  const MODIFIERS = { alt: "altKey", ctrl: "ctrlKey", meta: "metaKey", shift: "shiftKey" };
  function modifierDown(ev) {
    const key = MODIFIERS[pref("paraModifier") || "alt"];
    return !!key && !!ev[key];
  }
  function pageOf(ev) {
    const t = ev.target;
    if (!t || !t.closest || t.closest(".clitrans-para-box")) return null;
    return t.closest(".page[data-page-number]");
  }
  function paraEngine() {
    const e = pref("paraEngine");
    return ENGINES[e] ? e : defaultEngine();
  }
  async function paragraphClick(ev, reader, pv, w) {
    const pageEl = pageOf(ev);
    if (!pageEl) return;
    const idx = Number(pageEl.dataset.pageNumber) - 1;
    const view = w.PDFViewerApplication.pdfViewer.getPageView(idx);
    if (!view || !view.viewport || !view.div) return;
    const host = view.div;
    const hr = host.getBoundingClientRect();
    // pdf.js lives in a content compartment: passing our arrays into its helpers throws
    // "Permission denied", so apply the viewport transform here.
    const [a, b, c, d, e, f] = Array.from(view.viewport.transform, Number);
    const det = a * d - b * c || 1;
    const toPdf = (vx, vy) => [(d * (vx - e) - c * (vy - f)) / det, (a * (vy - f) - b * (vx - e)) / det];
    const toView = (x, y) => [a * x + c * y + e, b * x + d * y + f];
    const [px, py] = toPdf(ev.clientX - hr.left - host.clientLeft, ev.clientY - hr.top - host.clientTop);
    const page = pv._pdfPages && pv._pdfPages[idx];
    const para = findParagraph(page && page.chars, px, py);
    const doc = w.document;
    // The card lives in the scrolling viewer, not in the page: a page clips its children, which used to
    // cut the card off for paragraphs near the bottom edge.
    const layer = host.offsetParent || host.parentNode;
    const toast = (msg) => {
      const tip = doc.createElement("div");
      tip.className = "clitrans-para-mark";
      tip.textContent = msg;
      tip.style.cssText = "position:absolute;z-index:9999;pointer-events:none;padding:5px 12px;border-radius:999px;" +
        "font:500 12px system-ui,sans-serif;background:" + UI.ink + ";color:#fff;white-space:nowrap;" +
        "left:" + (host.offsetLeft + ev.clientX - hr.left + 12) + "px;top:" + (host.offsetTop + ev.clientY - hr.top + 12) + "px;";
      layer.append(tip);
      env.setTimeout(() => { const a = anim(tip, [{ opacity: 1 }, { opacity: 0 }], { duration: 300 }); env.setTimeout(() => tip.remove(), a ? 280 : 0); }, 1500);
    };
    if (!page || !page.chars) { toast("这一页的文字还在加载，稍后再试"); return; }
    if (!para || !cleanSelection(para.text)) { toast("这里没有识别到段落文字"); return; }
    const id = "clitrans-para-" + idx + "-" + para.start;
    const old = doc.getElementById(id);
    if (old && old._clitransClose) { old._clitransClose(); return; } // click again to close

    const mark = doc.createElement("div");
    mark.className = "clitrans-para-mark";
    mark.style.cssText = "position:absolute;pointer-events:none;z-index:9998;border-radius:6px;" +
      "outline:2px solid " + UI.teal + ";outline-offset:4px;background:rgba(15,110,110,.07);";
    const box = doc.createElement("div");
    box.id = id;
    box.className = "clitrans-para-box";
    box.style.cssText =
      "position:absolute;z-index:9999;box-sizing:border-box;padding:11px 14px 10px;border-radius:8px;" +
      "background:" + UI.tealSoft + ";border-left:5px solid " + UI.teal + ";" +
      "box-shadow:0 8px 24px rgba(0,0,0,.20);";
    // positions follow the page: zooming resizes the page div, which re-runs place()
    const place = () => {
      const [a2, b2, c2, d2, e2, f2] = Array.from(view.viewport.transform, Number);
      const tv = (x, y) => [a2 * x + c2 * y + e2, b2 * x + d2 * y + f2];
      const p1 = tv(para.rect[0], para.rect[1]), p2 = tv(para.rect[2], para.rect[3]);
      const ox = host.offsetLeft + host.clientLeft, oy = host.offsetTop + host.clientTop;
      const left = Math.min(p1[0], p2[0]), right = Math.max(p1[0], p2[0]);
      const top = Math.min(p1[1], p2[1]), bottom = Math.max(p1[1], p2[1]);
      mark.style.left = ox + left + "px"; mark.style.top = oy + top + "px";
      mark.style.width = right - left + "px"; mark.style.height = bottom - top + "px";
      const width = Math.max(right - left + 8, 340);
      box.style.width = width + "px";
      box.style.left = ox + Math.max(4, Math.min(left - 4, host.clientWidth - width - 4)) + "px";
      box.style.top = oy + bottom + 12 + "px";
    };
    // keep the card on screen with the smallest scroll, also when it grows once the translation arrives
    const reveal = () => {
      try {
        const sc = doc.getElementById("viewerContainer") || layer;
        const over = box.getBoundingClientRect().bottom - sc.getBoundingClientRect().bottom + 14;
        if (over > 0) sc.scrollBy({ top: over, behavior: "smooth" });
      } catch (e) {}
    };
    let ro = null;
    const close = () => { try { ro && ro.disconnect(); } catch (e) {} mark.remove(); box.remove(); };
    box._clitransClose = close;
    for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "wheel"]) {
      box.addEventListener(type, (e) => e.stopPropagation());
    }
    const panel = buildTranslatePanel(doc, {
      source: para.text, attachmentID: reader.itemID, pageLabel: view.pageLabel || String(idx + 1),
      engine: paraEngine(), auto: true, theme: "teal", onClose: close,
      vision: { snapshot: () => snapshotPage(view, para.rect, w) },
      qa: {
        context: async () => {
          const it = Zotero.Items.get(reader.itemID), parent = it && it.parentItem;
          return {
            title: parent ? parent.getField("title") : "",
            abstract: parent ? parent.getField("abstractNote") : "",
            pageText: pref("qaPageContext") === false ? "" : pageTextOf(page && page.chars),
            mathy: looksMathy(para.text),
            snapshot: (what) => snapshotPage(view, what === "page" ? null : para.rect, w),
          };
        },
      },
    });
    box.append(panel.root);
    place();
    layer.append(mark, box);
    try { ro = new w.ResizeObserver(() => { try { place(); reveal(); } catch (e) {} }); ro.observe(host); } catch (e) { LOG(e); }
    anim(mark, [{ opacity: 0 }, { opacity: 1 }], { duration: 180 });
    anim(box, [{ opacity: 0, transform: "translateY(-8px)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: "ease-out" });
    try { ro.observe(box); } catch (e) {}
    reveal();
  }
  const attachedWins = new Map(); // PDF iframe window -> listeners
  async function attachReader(reader) {
    try {
      if (!reader || (reader._type && reader._type !== "pdf")) return;
      let pv = null, w = null;
      for (let i = 0; i < 160; i++) {
        pv = reader._internalReader && reader._internalReader._primaryView;
        const cand = pv && pv._iframeWindow;
        if (cand && cand.PDFViewerApplication && cand.PDFViewerApplication.pdfViewer && pv._pdfPages) { w = cand; break; }
        await sleep(250);
      }
      if (!w || attachedWins.has(w)) return;
      // swallow the whole press so the reader does not start a text selection under the modifier
      const onDown = (ev) => {
        if (ev.button === 0 && modifierDown(ev) && pageOf(ev)) { ev.preventDefault(); ev.stopImmediatePropagation(); }
      };
      const onClick = (ev) => {
        if (ev.button !== 0 || !modifierDown(ev) || !pageOf(ev)) return;
        ev.preventDefault();
        ev.stopPropagation();
        paragraphClick(ev, reader, pv, w).catch((e) => LOG("paragraph click failed", e));
        // the reader's own capture listeners run before ours and may have started a selection
        env.setTimeout(() => {
          try { w.getSelection().removeAllRanges(); } catch (e) {}
          try { pv._setSelectionRanges(); if (pv._render) pv._render(); } catch (e) {}
        }, 0);
      };
      for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "dblclick"]) w.addEventListener(t, onDown, true);
      w.addEventListener("click", onClick, true);
      attachedWins.set(w, { onDown, onClick });
    } catch (e) { LOG("attachReader failed", e); }
  }
  function attachAllReaders() {
    try { for (const r of Zotero.Reader._readers || []) attachReader(r); } catch (e) { LOG(e); }
  }
  function detachAllReaders() {
    for (const [w, h] of attachedWins) {
      try {
        for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "dblclick"]) w.removeEventListener(t, h.onDown, true);
        w.removeEventListener("click", h.onClick, true);
        for (const el of w.document.querySelectorAll(".clitrans-para-box,.clitrans-para-mark")) el.remove();
      } catch (e) {}
    }
    attachedWins.clear();
  }

  // ------------------------------------------------ reader toolbar: layout button
  function buildToolbar(event) {
    const { reader, doc, append } = event;
    attachReader(reader);
    const btn = doc.createElement("button");
    btn.className = "toolbar-button clitrans-layout-button";
    btn.textContent = "排版";
    btn.title = "Verso：切换双语排版方式";
    btn.style.cssText = "width:auto;padding:0 8px;font-size:12px;white-space:nowrap;";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleLayoutMenu(doc, btn, reader);
    });
    append(btn);
  }
  function toggleLayoutMenu(doc, btn, reader) {
    const existing = doc.getElementById("clitrans-layout-menu");
    if (existing) { existing.remove(); return; }
    const menu = doc.createElement("div");
    menu.id = "clitrans-layout-menu";
    const r = btn.getBoundingClientRect();
    const view = doc.defaultView;
    menu.style.cssText =
      "position:fixed;z-index:99999;min-width:250px;padding:4px;border-radius:8px;background:Canvas;" +
      "color:CanvasText;border:1px solid rgba(128,128,128,.5);box-shadow:0 4px 16px rgba(0,0,0,.25);" +
      "font:13px/1.5 system-ui,sans-serif;top:" + (r.bottom + 4) + "px;right:" +
      Math.max(4, view.innerWidth - r.right) + "px;";
    const close = () => { menu.remove(); doc.removeEventListener("pointerdown", onOutside, true); };
    const onOutside = (e) => { if (!menu.contains(e.target) && e.target !== btn) close(); };
    const cur = docLayout();
    for (const [k, l] of Object.entries(LAYOUTS)) {
      const it = doc.createElement("div");
      it.textContent = (k === cur ? "✓ " : "　 ") + l.label;
      it.style.cssText = "padding:4px 10px;border-radius:5px;cursor:pointer;";
      it.addEventListener("mouseenter", () => { it.style.background = "rgba(128,128,128,.2)"; });
      it.addEventListener("mouseleave", () => { it.style.background = ""; });
      it.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        close();
        setPref("docLayout", k);
        const win = Zotero.getMainWindow();
        try {
          await relayoutDocument(Zotero.Items.get(reader.itemID), win, k);
        } catch (err) {
          LOG(err);
          Zotero.alert(win, "Verso", String((err && err.message) || err));
        }
      });
      menu.append(it);
    }
    const hint = doc.createElement("div");
    hint.textContent = "选中后为这篇文献生成该排版并打开。已经翻译过的段落直接复用，不会重复消耗额度；没翻译过的会用上次的引擎翻译。";
    hint.style.cssText = "padding:4px 10px;font-size:11px;opacity:.65;max-width:260px;";
    menu.append(hint);
    doc.body.append(menu);
    doc.addEventListener("pointerdown", onOutside, true);
  }

  // ------------------------------------------- local OpenAI-compatible bridge
  function headerValue(headers, name) {
    if (!headers) return "";
    if (typeof headers.get === "function") return headers.get(name) || "";
    const k = Object.keys(headers).find((h) => h.toLowerCase() === name.toLowerCase());
    return k ? String(headers[k]) : "";
  }
  function contentToText(c) {
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map((p) => (p && (p.text || (typeof p === "string" ? p : ""))) || "").join("");
    return "";
  }
  function splitMessages(messages) {
    const sys = [], conv = [];
    for (const m of messages || []) {
      const t = contentToText(m.content);
      if (!t) continue;
      if (m.role === "system" || m.role === "developer") sys.push(t);
      else conv.push(m.role === "assistant" ? "[assistant]\n" + t : t);
    }
    return { system: sys.join("\n\n"), user: conv.join("\n\n") };
  }
  function pickEngineFromModel(model) {
    const m = String(model || "").toLowerCase();
    if (m.includes("claude")) return "claude";
    if (m.includes("gemini")) return "gemini";
    if (m.includes("deepseek")) return "deepseek";
    if (m.includes("codex") || m.includes("gpt")) return "codex";
    return null;
  }
  function chatCompletion(model, content) {
    return {
      id: "chatcmpl-" + uid(), object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }
  async function handleChatRequest(req) {
    const token = pref("bridgeToken");
    const auth = headerValue(req.headers, "Authorization");
    if (!token || auth !== "Bearer " + token) {
      return [401, "application/json", JSON.stringify({ error: { message: "invalid api key" } })];
    }
    let body = req.data;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
    if (!body || !Array.isArray(body.messages)) {
      return [400, "application/json", JSON.stringify({ error: { message: "messages required" } })];
    }
    const engine = pickEngineFromModel(body.model);
    if (!engine) return [400, "application/json", JSON.stringify({ error: { message: "model must be codex, claude, gemini or deepseek" } })];
    const { system, user } = splitMessages(body.messages);
    try {
      const text = await callLLM(engine, system, user);
      return [200, "application/json", JSON.stringify(chatCompletion(body.model, text))];
    } catch (e) {
      return [500, "application/json", JSON.stringify({ error: { message: String(e && e.message || e) } })];
    }
  }

  // ------------------------------------------------------------ MCP server
  const MCP_TOOLS = [
    {
      name: "search_library",
      description: "Search the user's Zotero library (title, creators, year, tags, full text). Returns item keys.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
    },
    {
      name: "get_item",
      description: "Get metadata (title, authors, year, venue, DOI, abstract, tags, attachments) of a Zotero item by key.",
      inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    },
    {
      name: "get_fulltext",
      description: "Get the extracted full text of the item's PDF. Use offset/max_chars to page through long papers.",
      inputSchema: { type: "object", properties: { key: { type: "string" }, offset: { type: "number" }, max_chars: { type: "number" } }, required: ["key"] },
    },
    {
      name: "get_notes_and_annotations",
      description: "Get the user's notes and PDF annotations (highlights + comments) for an item.",
      inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    },
    {
      name: "translate_text",
      description: "Translate text with the plugin's engines (google is free and fast; codex/claude use local CLIs; gemini uses an API key or CLI).",
      inputSchema: { type: "object", properties: { text: { type: "string" }, engine: { type: "string", enum: ["google", "codex", "claude", "deepseek", "gemini"] } }, required: ["text"] },
    },
  ];

  async function itemByKey(key) {
    const item = await Zotero.Items.getByLibraryAndKeyAsync(Zotero.Libraries.userLibraryID, String(key || "").trim());
    if (!item) throw new Error("找不到条目 " + key);
    return item.isAttachment() && item.parentItem ? item.parentItem : item;
  }
  function itemSummary(item) {
    return {
      key: item.key,
      title: item.getField("title"),
      creators: item.getCreators().map((c) => [c.firstName, c.lastName].filter(Boolean).join(" ")).join("; "),
      year: (item.getField("date", true, true) || "").slice(0, 4),
      type: item.itemType,
    };
  }
  async function bestPDF(item) {
    if (item.isAttachment()) return item;
    const att = await item.getBestAttachment();
    return att || null;
  }
  async function mcpCallTool(name, args) {
    args = args || {};
    if (name === "search_library") {
      const s = new Zotero.Search();
      s.libraryID = Zotero.Libraries.userLibraryID;
      s.addCondition("quicksearch-everything", "contains", String(args.query || ""));
      const ids = await s.search();
      const items = Zotero.Items.get(ids)
        .map((it) => (it.isRegularItem() ? it : it.parentItem))
        .filter((it) => it && it.isRegularItem());
      const seen = new Set(), out = [];
      for (const it of items) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        out.push(itemSummary(it));
        if (out.length >= Math.min(Number(args.limit) || 10, 50)) break;
      }
      return out;
    }
    if (name === "get_item") {
      const it = await itemByKey(args.key);
      const fields = {};
      for (const f of ["title", "abstractNote", "date", "publicationTitle", "volume", "issue", "pages", "DOI", "url"]) {
        try { const v = it.getField(f); if (v) fields[f] = v; } catch (e) {}
      }
      return {
        ...itemSummary(it), ...fields,
        tags: it.getTags().map((t) => t.tag),
        attachments: it.getAttachments().map((id) => Zotero.Items.get(id)).filter(Boolean)
          .map((a) => ({ key: a.key, title: a.getField("title"), contentType: a.attachmentContentType })),
      };
    }
    if (name === "get_fulltext") {
      const it = await itemByKey(args.key);
      const att = await bestPDF(it);
      if (!att) throw new Error("该条目没有 PDF 附件");
      const text = (await att.attachmentText) || "";
      const offset = Math.max(0, Number(args.offset) || 0);
      const max = Math.min(Number(args.max_chars) || 40000, 120000);
      return { key: it.key, total_chars: text.length, offset, text: text.slice(offset, offset + max) };
    }
    if (name === "get_notes_and_annotations") {
      const it = await itemByKey(args.key);
      const notes = it.isRegularItem()
        ? it.getNotes().map((id) => Zotero.Items.get(id)).filter(Boolean)
          .map((n) => Zotero.Utilities.unescapeHTML(n.getNote().replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim())
        : [];
      const annotations = [];
      for (const id of it.isRegularItem() ? it.getAttachments() : [it.id]) {
        const a = Zotero.Items.get(id);
        if (!a || !a.isAttachment() || !a.getAnnotations) continue;
        for (const an of a.getAnnotations()) {
          annotations.push({ type: an.annotationType, page: an.annotationPageLabel, text: an.annotationText || "", comment: an.annotationComment || "" });
        }
      }
      return { key: it.key, notes, annotations };
    }
    if (name === "translate_text") {
      return { translation: await translate(String(args.text || ""), args.engine || "google") };
    }
    throw new Error("未知工具 " + name);
  }

  async function mcpDispatch(msg) {
    const id = msg && msg.id;
    const isNotification = id === undefined || id === null;
    const ok = (result) => ({ jsonrpc: "2.0", id, result });
    const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return isNotification ? null : fail(-32600, "Invalid Request");
    if (isNotification) return null;
    switch (msg.method) {
      case "initialize":
        return ok({
          protocolVersion: (msg.params && msg.params.protocolVersion) || "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "zotero-clitrans", version: env.version || "0.1.0" },
          instructions: "Read-only access to the user's Zotero library: search, metadata, full text, notes and annotations; plus translation.",
        });
      case "ping": return ok({});
      case "tools/list": return ok({ tools: MCP_TOOLS });
      case "tools/call": {
        const p = msg.params || {};
        try {
          const r = await mcpCallTool(p.name, p.arguments);
          return ok({ content: [{ type: "text", text: JSON.stringify(r, null, 2) }], isError: false });
        } catch (e) {
          return ok({ content: [{ type: "text", text: "Error: " + (e && e.message || e) }], isError: true });
        }
      }
      default: return fail(-32601, "Method not found: " + msg.method);
    }
  }
  async function handleMcpRequest(req) {
    if (!pref("mcpEnabled")) return [404, "text/plain", "MCP disabled"];
    const token = (pref("mcpToken") || "").trim();
    if (token && headerValue(req.headers, "Authorization") !== "Bearer " + token) {
      return [401, "application/json", JSON.stringify({ error: "unauthorized" })];
    }
    if (req.method === "GET") return [405, "text/plain", "SSE stream not supported"];
    let body = req.data;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { return [400, "application/json", JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })]; } }
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(mcpDispatch))).filter(Boolean);
      return out.length ? [200, "application/json", JSON.stringify(out)] : [202, "text/plain", ""];
    }
    const res = await mcpDispatch(body);
    return res ? [200, "application/json", JSON.stringify(res)] : [202, "text/plain", ""];
  }

  async function handleTranslateRequest(req) {
    if (headerValue(req.headers, "Authorization") !== "Bearer " + pref("bridgeToken")) {
      return [401, "application/json", JSON.stringify({ error: "invalid token" })];
    }
    let body = req.data;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
    if (!body || typeof body.text !== "string") return [400, "application/json", JSON.stringify({ error: "text required" })];
    try {
      if (body.mode === "figure") {
        if (!visionCapable(body.engine || "")) throw new Error("该引擎不支持看图翻译");
        if (typeof body.image !== "string" || !/\.png$/i.test(body.image) || !fileExists(body.image)) throw new Error("image not found");
        const gl = glossaryForText(parseGlossary(pref("glossary")), body.text);
        const out = await callVision(body.engine, figurePrompt(pref("targetLangName") || "简体中文", gl),
          "Text extracted from the PDF (symbols may be garbled — trust the image): " + String(body.text || "").slice(0, 2500),
          [body.image]);
        return [200, "application/json", JSON.stringify({ translation: out })];
      }
      if (body.mode === "vision") {
        if (!visionCapable(body.engine || "")) throw new Error("该引擎不支持看图翻译");
        if (typeof body.image !== "string" || !/\.png$/i.test(body.image) || !fileExists(body.image)) throw new Error("image not found");
        return [200, "application/json", JSON.stringify({ translation: await enqueueVision(body.image, body.text, body.engine) })];
      }
      const translation = await translateSegment(body.text, body.engine || "google", body.mode);
      return [200, "application/json", JSON.stringify({ translation })];
    } catch (e) {
      return [502, "application/json", JSON.stringify({ error: String(e && e.message || e) })];
    }
  }

  const PATHS = {
    translate: "/clitrans/v1/translate",
    chat: "/clitrans/v1/chat/completions",
    models: "/clitrans/v1/models",
    mcp: "/clitrans/mcp",
  };
  function serverPort() {
    try { return Zotero.Prefs.get("httpServer.port") || 23119; } catch (e) { return 23119; }
  }
  function bridgeBaseURL() { return "http://127.0.0.1:" + serverPort() + "/clitrans/v1"; }
  function mcpURL() { return "http://127.0.0.1:" + serverPort() + PATHS.mcp; }

  function makeEndpoint(methods, handler) {
    const E = function () {};
    E.prototype = {
      supportedMethods: methods,
      supportedDataTypes: ["application/json", "text/plain"],
      permitBookmarklet: false,
      init: async function (req) {
        try { return await handler(req); } catch (e) {
          LOG("endpoint error", e);
          return [500, "application/json", JSON.stringify({ error: { message: String(e && e.message || e) } })];
        }
      },
    };
    return E;
  }
  function registerEndpoints() {
    const E = Zotero.Server.Endpoints;
    E[PATHS.chat] = makeEndpoint(["POST"], handleChatRequest);
    E[PATHS.translate] = makeEndpoint(["POST"], handleTranslateRequest);
    E[PATHS.models] = makeEndpoint(["GET"], async () => [200, "application/json", JSON.stringify({
      object: "list", data: ["codex", "claude", "gemini", "deepseek"].map((id) => ({ id, object: "model", owned_by: "local-cli" })),
    })]);
    E[PATHS.mcp] = makeEndpoint(["POST", "GET"], handleMcpRequest);
  }
  function unregisterEndpoints() {
    for (const p of Object.values(PATHS)) delete Zotero.Server.Endpoints[p];
  }

  // ------------------------------------------------ whole-document translation
  // 逐段对照 is built by interleave.py straight from the original PDF (originals are cropped, never
  // re-typeset). The other layouts use pdf2zh_next's in-place translated ("mono") PDF, composed with
  // the original by p2z_runner.py, so switching between them does not re-translate.
  const LAYOUTS = {
    interleave: { label: "逐段对照（每段原文下方紧接译文，推荐）", title: "逐段对照", suffix: "interleave" },
    side: { label: "左右对照（左原文·右译文）", title: "双语对照（左右）", suffix: "side" },
    alternate: { label: "交替页（一页原文·一页译文）", title: "双语对照（交替页）", suffix: "alt" },
    mono: { label: "仅译文", title: "译文", suffix: "mono" },
  };
  function docLayout(l) {
    l = l || pref("docLayout");
    if (l === "stacked") l = "interleave"; // 0.3.0's page-level "上下对照" was replaced by 逐段对照
    return LAYOUTS[l] ? l : "interleave";
  }
  const TRANSLATED_NAME = /\.(?:mono|dual|side|stacked|alt|interleave)\.pdf$/i; // .mono: 仅译文
  function isTranslationTitle(title, filename) {
    return /^(?:译文|双语对照|逐段对照|翻译)(?:\s*[·（(]|$)/.test(String(title || "")) || TRANSLATED_NAME.test(String(filename || ""));
  }
  function isTranslationAttachment(att) {
    try {
      return !!att && att.isAttachment() && isTranslationTitle(att.getField("title"), att.attachmentFilename);
    } catch (e) { return false; }
  }
  function isPDF(att) { return !!att && att.isAttachment() && att.attachmentContentType === "application/pdf"; }
  function pdfSiblings(item) {
    const parent = item.isAttachment() ? item.parentItem : item;
    if (!parent) return isPDF(item) ? [item] : [];
    return parent.getAttachments().map((id) => Zotero.Items.get(id)).filter(isPDF);
  }
  const byDateAdded = (a, b) => String(a.dateAdded).localeCompare(String(b.dateAdded));
  /** The source PDF of an item — never one of our own translated attachments. */
  async function originalPDF(item) {
    if (isPDF(item) && !isTranslationAttachment(item)) return item;
    const originals = pdfSiblings(item).filter((a) => !isTranslationAttachment(a)).sort(byDateAdded);
    if (originals.length) return originals[0];
    return item.isAttachment() ? null : bestPDF(item);
  }
  function latestMono(item) {
    const monos = pdfSiblings(item).filter((a) =>
      /\.mono\.pdf$/i.test(a.attachmentFilename || "") || /^译文(?:\s*·|$)/.test(a.getField("title") || ""));
    return monos.sort(byDateAdded).pop() || null;
  }

  /** Engine id of the most recent translation attached to an item ("译文 · GPT（…）" → "codex"). */
  function lastEngine(item) {
    const tr = pdfSiblings(item).filter(isTranslationAttachment).sort(byDateAdded).pop();
    const lbl = tr ? engineFromTitle(tr.getField("title")) : "";
    if (/^GPT/i.test(lbl)) return "codex";
    if (/^Claude/i.test(lbl)) return "claude";
    if (/^Gemini/i.test(lbl)) return "gemini";
    if (/^DeepSeek/i.test(lbl)) return "deepseek";
    if (/^Google/i.test(lbl)) return "google";
    return ENGINES[pref("docEngine")] ? pref("docEngine") : "google";
  }

  async function listPDFs(dir) {
    const out = [];
    await Zotero.File.iterateDirectory(dir, async (entry) => {
      if (!entry.isDir && /\.pdf$/i.test(entry.name)) out.push(entry);
    });
    return out;
  }
  function pdf2zhArgs({ input, outDir, engine, pages }) {
    const lang = pref("targetLang") || "zh-CN";
    // Concurrency: many in-flight segments let the plugin batch them into few LLM calls.
    const workers = ENGINES[engine] && ENGINES[engine].llm ? 120 : 12;
    const a = [input, "--output", outDir, "--lang-out", lang, "--watermark-output-mode", "no_watermark",
      "--google", "--qps", String(workers), "--pool-max-workers", String(workers), "--no-dual"];
    if (pref("translateTables") !== false) a.push("--translate-table-text");
    if (pages) a.push("--pages", String(pages));
    return a;
  }
  const STAGE_ZH = {
    "DetectScannedFile": "检测扫描件",
    "Parse PDF and Create Intermediate Representation": "解析 PDF",
    "Parse Page Layout": "识别版面",
    "Parse Paragraphs": "识别段落",
    "Parse Formulas and Styles": "识别公式与样式",
    "Parse Table": "识别表格",
    "Translate table text (experimental)": "翻译表格",
    "Automatic Term Extraction": "提取术语",
    "Translate Paragraphs": "翻译段落",
    "Typesetting": "排版",
    "Add Fonts": "嵌入字体",
    "Subset font": "精简字体",
    "Generate drawing instructions": "生成页面",
    "Save PDF": "保存 PDF",
    "Compose layout": "生成双语排版",
    "Analyze layout": "识别版面",
    "OCR figures": "识别图中文字",
    "Read formulas": "看图识别公式",
    "Prepare OCR": "准备文字识别（仅首次，约 30 秒）",
  };
  function friendlyError(msg) {
    msg = String(msg || "");
    if (isProxyFailure(msg)) return "代理连接失败（" + msg.slice(0, 160) + "）。设置了代理但代理软件没有在运行：请打开它，或关闭系统代理后重启 Zotero。";
    if (/SSLError|CERTIFICATE|ConnectError/i.test(msg)) return "网络连接失败（" + msg.slice(0, 160) + "）。请检查网络；如果使用代理 / VPN，请确认它在运行。";
    if (/401|invalid token/i.test(msg)) return "插件内部令牌不匹配，请重启 Zotero 后重试。";
    return msg.slice(-800);
  }
  function fmtDuration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(s / 60);
    return m ? m + "分" + String(s % 60).padStart(2, "0") + "秒" : s + "秒";
  }
  function formatProgress({ pct, stage, part, parts, cur, tot, elapsedMs }) {
    const parts_ = [Math.floor(pct) + "%"];
    if (stage) {
      let st = STAGE_ZH[stage] || stage;
      if (tot && cur != null && tot > 1) st += " " + cur + "/" + tot;
      if (parts > 1) st += "（第 " + part + "/" + parts + " 部分）";
      parts_.push(st);
    }
    parts_.push("已用 " + fmtDuration(elapsedMs));
    if (pct >= 3 && pct < 99) parts_.push("约剩 " + fmtDuration(elapsedMs * (100 - pct) / pct));
    return parts_.join(" · ");
  }
  /** uv's tool folder: $UV_TOOL_DIR, else ~/.local/share/uv/tools (macOS/Linux) or %APPDATA%\uv\tools. */
  function uvToolDirs() {
    const out = [];
    if (envVar("UV_TOOL_DIR")) out.push(envVar("UV_TOOL_DIR"));
    if (IS_WIN) {
      out.push(joinPath(envVar("APPDATA") || joinPath(homeDir(), "AppData", "Roaming"), "uv", "tools"));
      out.push(joinPath(envVar("APPDATA") || joinPath(homeDir(), "AppData", "Roaming"), "uv", "data", "tools"));
    } else {
      out.push(joinPath(envVar("XDG_DATA_HOME") || joinPath(homeDir(), ".local", "share"), "uv", "tools"));
    }
    return out;
  }
  function venvPython(venv) {
    return IS_WIN ? joinPath(venv, "Scripts", "python.exe") : joinPath(venv, "bin", "python");
  }
  /** The Python that has pdf2zh_next / BabelDOC installed (what 整篇翻译 runs on). */
  async function findPython() {
    const configured = (pref("pythonPath") || "").trim();
    if (configured && fileExists(configured)) return configured;
    for (const d of uvToolDirs()) {
      for (const name of ["pdf2zh-next", "pdf2zh_next"]) {
        const c = venvPython(joinPath(d, name));
        if (fileExists(c)) return c;
      }
    }
    const script = resolveTool("pdf2zh");
    if (script && !IS_WIN) {
      try {  // pip/uv entry script: its shebang names the venv's python
        const head = (await Zotero.File.getContentsAsync(script, null, 400)) || "";
        const m = String(head).match(/^#!\s*(\S+python[\d.]*)\s*$/m);
        if (m && fileExists(m[1])) return m[1];
      } catch (e) {}
    }
    if (script && IS_WIN) {  // uv/pip put pdf2zh_next.exe in <venv>\Scripts or a shim next to the venv
      const c = joinPath(script.replace(/[\\/][^\\/]*$/, ""), "python.exe");
      if (fileExists(c)) return c;
    }
    return null;
  }
  /** Read a text file shipped inside the plugin. Zotero 10's Zotero.HTTP rejects jar: URLs
   *  (the installed .xpi), so use the main window's fetch first and keep the old call as fallback. */
  async function readPackaged(rel) {
    const url = env.rootURI + rel;
    try {
      const win = Zotero.getMainWindow();
      const res = await win.fetch(url);
      const text = await res.text();
      if (text) return text;
    } catch (e) { LOG("fetch of packaged file failed, trying Zotero.File", e); }
    return Zotero.File.getContentsFromURLAsync(url);
  }
  async function writeRunner(dir) {
    try {
      for (const f of ["p2z_runner.py", "interleave.py", "ocr.swift", "setup_check.py"]) {
        const src = await readPackaged("content/" + f);
        if (!src) throw new Error("empty " + f);
        await Zotero.File.putContentsAsync(joinPath(dir, f), src);
      }
      return joinPath(dir, "p2z_runner.py");
    } catch (e) { LOG("runner write failed", e); return null; }
  }
  /** Python + runner script for a job directory, or a user-facing error. */
  async function prepareRunner(outDir) {
    const python = await findPython();
    if (!python) throw new Error("整篇翻译的运行环境还没有安装。\n请打开 Zotero 设置 → Verso → 「一键配置翻译环境」，等它装完再试（只需一次，约 5–15 分钟）。");
    const runner = await writeRunner(outDir);
    if (!runner) throw new Error("无法从插件包中读取翻译脚本 p2z_runner.py（插件 " + (env.version || "") + "）。请重新安装 Verso 插件后重试。");
    return { python, runner, interleave: joinPath(outDir, "interleave.py") };
  }
  /** Run the runner, feeding its "@@P {json}" lines to onEvent. */
  function runRunner(python, args, opts, onEvent) {
    let buf = "";
    return runProcess(python, args, Object.assign({}, opts, {
      onOutput: (s) => {
        buf += s;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const l = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (l.startsWith("@@P ")) { try { onEvent(JSON.parse(l.slice(4))); } catch (e) {} }
        }
      },
    }));
  }
  function engineFromTitle(title) {
    const m = String(title || "").match(/·\s*(.+)$/);
    return m ? m[1].trim() : "";
  }

  async function translateDocument(item, window, engineArg, opts = {}) {
    const att = await originalPDF(item);
    if (!isPDF(att)) throw new Error("没找到 PDF 附件");
    const input = await att.getFilePathAsync();
    if (!input) throw new Error("PDF 文件不在本地（可能只在云端）");
    const engine = engineArg || pref("docEngine") || "google";
    if (!ENGINES[engine]) throw new Error("未知引擎：" + engine);
    const layout = docLayout(opts.layout);
    ensureTokens();

    const outDir = joinPath(tmpDir(), "clitrans-doc-" + uid());
    await Zotero.File.createDirectoryIfMissingAsync(outDir);
    const title = att.getField("title") || "PDF";
    const shortTitle = title.length > 40 ? title.slice(0, 38) + "…" : title;
    const pw = new Zotero.ProgressWindow({ closeOnClick: false });
    pw.changeHeadline("整篇翻译 · " + engineLabel(engine) + " · " + LAYOUTS[layout].title);
    const line = new pw.ItemProgress(null, shortTitle);
    line.setText("启动 pdf2zh_next…（首次加载模型约 10–30 秒）");
    pw.show();
    const fail = (closeMs) => { line.setError(); pw.startCloseTimer(closeMs); };

    let python, runner, interleave;
    try { ({ python, runner, interleave } = await prepareRunner(outDir)); } catch (e) { fail(6000); throw e; }

    const t0 = Date.now();
    let pct = 0, lastUI = 0, lastError = "", warn = "";
    const update = (ev) => {
      if (ev.p != null) pct = Math.max(pct, Math.min(99, Number(ev.p) || 0));
      const now = Date.now();
      if (now - lastUI < 400) return;
      lastUI = now;
      line.setProgress(pct);
      line.setText(formatProgress({ pct, stage: ev.stage, part: ev.part, parts: ev.parts, cur: ev.cur, tot: ev.tot, elapsedMs: now - t0 }));
    };
    resetDocStats();
    const model = engine === "codex" ? pref("codexModel") : engine === "claude" ? pref("claudeModel") : engine === "gemini" ? (geminiChannel() || "") + "/" + (geminiChannel() === "agy" ? agyModel() : geminiModel()) : engine === "deepseek" ? deepseekModel() : "";
    // every layout is built by interleave.py: the original is never re-typeset (no garbled formulas),
    // translated formulas are typeset, figure/table text is translated. pdf2zh_next's in-place mode
    // remains below only as a fallback (pref "inPlaceLayout").
    if (!pref("inPlaceLayout")) {
      line.setText("启动…（加载版面识别模型约 5 秒）");
      const stem = String(att.attachmentFilename || "document.pdf").replace(/\.pdf$/i, "");
      const out = joinPath(outDir, stem + "." + (pref("targetLang") || "zh-CN") + "." + LAYOUTS[layout].suffix + ".pdf");
      let done = null;
      const ri = await runRunner(python, [interleave, input, out, "--layout", layout].concat(opts.pages ? ["--pages", String(opts.pages)] : []), {
        workdir: outDir,
        timeoutMs: 3 * 60 * 60 * 1000,
        env: {
          CLITRANS_TRANSLATE_URL: bridgeBaseURL() + "/translate", CLITRANS_TOKEN: pref("bridgeToken"),
          CLITRANS_ENGINE: engine,
          CLITRANS_VISION: visionCapable(engine) && pref("visionFormulas") !== false ? "1" : "",
          CLITRANS_FIGURES: pref("translateFigures") === false ? "0" : "1",
          CLITRANS_CACHE_KEY: [engine, model, pref("glossary") || "", pref("targetLang") || "zh-CN", "i1",
            pref("skipReferences") !== false ? 1 : 0].join(":"),
        },
      }, (ev) => {
        if (ev.error) { lastError = ev.error; LOG("interleave error", ev.error); }
        else if (ev.done) done = ev;
        else update(ev);
      });
      if (ri.exitCode !== 0 || !done || !fileExists(out)) {
        line.setText("失败");
        fail(8000);
        throw new Error(LAYOUTS[layout].title + "生成失败（" + engineLabel(engine) + "，插件 " + (env.version || "") + "）：\n" + friendlyError(lastError || errText(ri)));
      }
      const added = await Zotero.Attachments.importFromFile({
        file: out, parentItemID: att.parentItemID || null, libraryID: att.libraryID,
        title: LAYOUTS[layout].title + " · " + engineLabel(engine),
      });
      line.setProgress(100);
      line.setText("完成 · 用时 " + fmtDuration(Date.now() - t0) + " · 已翻译 " + done.translated + " 段" +
        (done.errors ? " · " + done.errors + " 段翻译失败（保留原文）" : ""));
      pw.startCloseTimer(done.errors ? 9000 : 4000);
      if (pref("openDualAfter")) { try { await Zotero.Reader.open(added.id); } catch (e) {} }
      return added;
    }
    const r = await runRunner(python, [runner, ...pdf2zhArgs({ input, outDir, engine, pages: opts.pages })], {
      workdir: outDir,
      timeoutMs: 3 * 60 * 60 * 1000,
      env: {
        CLITRANS_TRANSLATE_URL: bridgeBaseURL() + "/translate", CLITRANS_TOKEN: pref("bridgeToken"),
        CLITRANS_ENGINE: engine, CLITRANS_LAYOUT: layout,
        // translations are cached per text + this key; "g3" = guard rules version
        CLITRANS_CACHE_KEY: [engine, model, (pref("glossary") || "").length, "g3",
          pref("keepFormulaDense") !== false ? 1 : 0, pref("skipReferences") !== false ? 1 : 0].join(":"),
      },
    }, (ev) => {
      if (ev.error) { lastError = ev.error; LOG("pdf2zh error", ev.error, ev.details); }
      else if (ev.warn) { warn = ev.warn; LOG("runner warning", ev.warn); }
      else update(ev);
    });
    const pdfs = (await listPDFs(outDir)).filter((e) => e.path !== input);
    const mono = pdfs.find((e) => /\.mono\.pdf$/i.test(e.name));
    if (r.exitCode !== 0 || !mono) {
      line.setText("失败");
      fail(8000);
      throw new Error("整篇翻译失败（" + engineLabel(engine) + "，插件 " + (env.version || "") + "）：\n" + friendlyError(lastError || errText(r)));
    }
    const composed = layout === "mono" ? null
      : pdfs.find((e) => e.name.toLowerCase().endsWith("." + LAYOUTS[layout].suffix + ".pdf"));
    const parentItemID = att.parentItemID || null;
    const lbl = engineLabel(engine);
    let shown = null;
    if (composed) {
      shown = await Zotero.Attachments.importFromFile({
        file: composed.path, parentItemID, libraryID: att.libraryID, title: LAYOUTS[layout].title + " · " + lbl,
      });
    }
    const monoAtt = await Zotero.Attachments.importFromFile({
      file: mono.path, parentItemID, libraryID: att.libraryID, title: "译文 · " + lbl,
    });
    shown = shown || monoAtt;
    line.setProgress(100);
    const kept = keptSummary();
    line.setText("完成 · 用时 " + fmtDuration(Date.now() - t0) + (kept ? " · " + kept : "") +
      (layout !== "mono" && !composed ? " · 双语排版生成失败，仅附加译文" + (warn ? "（" + warn.slice(0, 80) + "）" : "") : ""));
    pw.startCloseTimer(kept ? 9000 : 4000);
    if (shown && pref("openDualAfter")) { try { await Zotero.Reader.open(shown.id); } catch (e) {} }
    return shown;
  }

  /** Build another bilingual layout from the original PDF + an existing translated PDF. No translation. */
  async function relayoutDocument(item, window, layoutArg) {
    if (!item) throw new Error("没找到条目");
    const layout = docLayout(layoutArg);
    // every layout is rebuilt from the original; translated paragraphs come from the local cache
    if (!pref("inPlaceLayout")) return translateDocument(item, window, lastEngine(item), { layout });
    const mono = latestMono(item);
    if (!mono) return translateDocument(item, window, lastEngine(item), { layout });
    if (layout === "mono") { await Zotero.Reader.open(mono.id); return mono; }
    const orig = await originalPDF(item);
    if (!isPDF(orig)) throw new Error("没找到原文 PDF");
    const origPath = await orig.getFilePathAsync();
    const monoPath = await mono.getFilePathAsync();
    if (!origPath || !monoPath) throw new Error("原文或译文 PDF 不在本地（可能只在云端）");

    const outDir = joinPath(tmpDir(), "clitrans-doc-" + uid());
    await Zotero.File.createDirectoryIfMissingAsync(outDir);
    const { python, runner } = await prepareRunner(outDir);
    const stem = String(orig.attachmentFilename || "document.pdf").replace(/\.pdf$/i, "");
    const out = joinPath(outDir, stem + "." + (pref("targetLang") || "zh-CN") + "." + LAYOUTS[layout].suffix + ".pdf");
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("重新排版 · " + LAYOUTS[layout].title);
    const line = new pw.ItemProgress(null, "用已有译文生成，不重新翻译…");
    pw.show();
    let lastError = "";
    const r = await runRunner(python, [runner, "--relayout", origPath, monoPath, layout, out],
      { workdir: outDir, timeoutMs: 10 * 60 * 1000 }, (ev) => { if (ev.error) lastError = ev.error; });
    if (r.exitCode !== 0 || !fileExists(out)) {
      line.setError();
      pw.startCloseTimer(6000);
      throw new Error("重新排版失败：" + (lastError || errText(r)).slice(-500));
    }
    const lbl = engineFromTitle(mono.getField("title"));
    const added = await Zotero.Attachments.importFromFile({
      file: out, parentItemID: orig.parentItemID || null, libraryID: orig.libraryID,
      title: LAYOUTS[layout].title + (lbl ? " · " + lbl : ""),
    });
    line.setProgress(100);
    line.setText("完成 · 已附加到条目");
    pw.startCloseTimer(3000);
    if (pref("openDualAfter")) { try { await Zotero.Reader.open(added.id); } catch (e) {} }
    return added;
  }

  // ------------------------------------------------------------ one-click setup (macOS / Windows / Linux)
  const PYPI_MIRROR = "https://pypi.tuna.tsinghua.edu.cn/simple";
  const PY_MIRROR = "https://registry.npmmirror.com/-/binary/python-build-standalone";
  function setupEnv(withPythonMirror) {
    const e = {};
    if (pref("useMirror")) {
      e.UV_DEFAULT_INDEX = PYPI_MIRROR;
      e.UV_INDEX_URL = PYPI_MIRROR;  // older uv
      if (withPythonMirror) e.UV_PYTHON_INSTALL_MIRROR = PY_MIRROR;
    }
    return e;
  }
  // A proxy that is configured but not running (Clash / v2rayN / an accelerator was closed while the system
  // proxy or HTTP(S)_PROXY stayed set) refuses every connection: uv says "tunnel error … os error 10061",
  // Python says "ProxyError". Setup then retries the download without any proxy.
  const PROXY_FAIL = new RegExp([
    "tunnel error", "ProxyError", "proxy error", "Unable to connect to proxy", "Cannot connect to proxy",
    "Tunnel connection failed", "os error 10061", "WinError 10061", "积极拒绝", "actively refused",
    "Failed to connect to (127\\.0\\.0\\.1|localhost) port",
    "\\[Errno (61|111)\\] Connection refused", // httpx (BabelDOC font / model download) on macOS / Linux
  ].join("|"), "i");
  function isProxyFailure(text) { return PROXY_FAIL.test(String(text || "")); }
  // NO_PROXY=* also covers the Windows system proxy (registry) that uv / Python would otherwise pick up
  const NO_PROXY_ENV = { NO_PROXY: "*", no_proxy: "*", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "",
    http_proxy: "", https_proxy: "", all_proxy: "" };
  let bypassProxy = false; // true once a download only worked without the proxy; reset at every setup
  const PROXY_DETECTED = "检测到代理连接失败：系统代理或环境变量里设置了代理，但对应的软件（如 Clash、v2rayN、加速器）没有在运行。改为不经代理、直接连接重试…";
  const PROXY_HELP = "不经代理直接连接也失败了。\n· 如果你的网络必须走代理才能上网：请先打开代理软件，再重试；\n" +
    "· 如果不需要代理：" + (IS_WIN ? "Windows 设置 → 网络和 Internet → 代理，关闭「使用代理服务器」" : "关闭系统设置里的网络代理") +
    "，并删除环境变量 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY，然后重启 Zotero。";
  function withNoProxy(opts) { return Object.assign({}, opts, { env: Object.assign({}, opts.env, NO_PROXY_ENV) }); }
  /** One setup command; on a dead proxy it is retried once without any proxy (opts.directArgs replace args). */
  async function runStep(cmd, args, log, opts = {}) {
    if (bypassProxy) return runStepOnce(cmd, opts.directArgs || args, log, withNoProxy(opts));
    try { return await runStepOnce(cmd, args, log, opts); } catch (e) {
      if (!isProxyFailure(e && e.message)) throw e;
      log("\n" + PROXY_DETECTED);
      bypassProxy = true;
      try { return await runStepOnce(cmd, opts.directArgs || args, log, withNoProxy(opts)); } catch (e2) {
        throw new Error(((e2 && e2.message) || e2) + "\n\n" + PROXY_HELP);
      }
    }
  }
  async function runStepOnce(cmd, args, log, opts = {}) {
    log("\n$ " + String(cmd).split(/[\\/]/).pop() + " " + args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" "));
    let last = 0;
    const r = await runProcess(cmd, args, Object.assign({
      workdir: tmpDir(), timeoutMs: 45 * 60 * 1000,
      onOutput: (s) => {  // uv/pip progress bars redraw constantly: show at most a few lines per second
        const now = Date.now();
        const lines = String(s).split(/\r|\n/).map((x) => x.trim()).filter(Boolean);
        if (lines.length && now - last > 300) { last = now; log(lines[lines.length - 1].slice(0, 200)); }
      },
    }, opts));
    if (r.exitCode !== 0) throw new Error(String(cmd).split(/[\\/]/).pop() + " 失败：" + errText(r));
    return r;
  }
  async function installUv(log) {
    if (IS_WIN) {
      const ps = joinPath(envVar("SystemRoot") || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const cmd = (direct) => ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
        (direct ? "[System.Net.WebRequest]::DefaultWebProxy = $null; " : "") + "irm https://astral.sh/uv/install.ps1 | iex"];
      await runStep(ps, cmd(false), log, { directArgs: cmd(true) });
    } else {
      await runStep("/bin/sh", ["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"], log);
    }
    launchCache.clear();
    const uv = resolveTool("uv");
    if (!uv) throw new Error("uv 安装后仍未找到。请手动安装 uv（https://docs.astral.sh/uv/）后重试。");
    return uv;
  }
  /** Run setup_check.py with the environment's Python; returns its JSON report. */
  async function checkPython(python, warmup, log) {
    const dir = joinPath(tmpDir(), "clitrans-setup");
    await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    const src = await readPackaged("content/setup_check.py");
    const script = joinPath(dir, "setup_check.py");
    await Zotero.File.putContentsAsync(script, src);
    const run = (direct) => runProcess(python, [script].concat(warmup ? ["--warmup"] : []), {
      workdir: dir, timeoutMs: (warmup ? 30 : 2) * 60 * 1000, env: direct ? NO_PROXY_ENV : undefined,
      onOutput: log ? (s) => { const l = String(s).trim().split("\n").pop(); if (l && !l.startsWith("@@S")) log(l.slice(0, 200)); } : undefined,
    });
    const parse = (r) => { const m = String(r.stdout).match(/^@@S (.+)$/m); return m ? JSON.parse(m[1]) : null; };
    let r = await run(bypassProxy), st = parse(r);
    if (warmup && !bypassProxy && isProxyFailure((st && st.asset_error) || errText(r))) {
      if (log) log("\n" + PROXY_DETECTED);
      bypassProxy = true;
      r = await run(true); st = parse(r);
      if (st && st.asset_error && isProxyFailure(st.asset_error)) st.asset_error += "\n" + PROXY_HELP;
    }
    if (!st) throw new Error("环境检查失败：" + errText(r));
    return st;
  }
  /** Everything 整篇翻译 needs: uv → pdf2zh_next (Python 3.12) → extras → font + layout model. */
  async function setupEnvironment(log) {
    log = log || (() => {});
    const t0 = Date.now();
    bypassProxy = false;
    log("== 1/4 安装工具 uv" + (pref("useMirror") ? "（使用国内镜像）" : ""));
    let uv = resolveTool("uv");
    if (uv) log("已安装：" + uv);
    else uv = await installUv(log);

    log("\n== 2/4 安装翻译引擎 pdf2zh_next / BabelDOC（首次约 5–15 分钟）");
    let python = await findPython();
    if (python) log("已安装：" + python);
    else {
      const args = ["tool", "install", "--python", "3.12", "pdf2zh_next"];
      try { await runStep(uv, args, log, { env: setupEnv(true) }); } catch (e) {
        if (!pref("useMirror")) throw e;
        log("镜像安装 Python 失败，改用官方源重试…");
        await runStep(uv, args, log, { env: setupEnv(false) });
      }
      python = await findPython();
      if (!python) throw new Error("pdf2zh_next 已安装，但找不到它的 Python。请在设置里手动填写 Python 路径。");
    }

    log("\n== 3/4 安装公式排版、模糊匹配与文字识别组件");
    await runStep(uv, ["pip", "install", "--python", python, "matplotlib", "rapidfuzz"], log, { env: setupEnv(false) });
    // RapidOCR reads figure text on Windows/Linux (macOS uses Vision); --no-deps keeps opencv single
    await runStep(uv, ["pip", "install", "--python", python, "--no-deps", "rapidocr_onnxruntime", "pyclipper", "shapely", "six", "pyyaml"],
      log, { env: setupEnv(false) });

    log("\n== 4/4 下载中文字体与版面识别模型");
    const st = await checkPython(python, true, log);
    if (bypassProxy) log("\n注意：本次配置绕过了一个没有在运行的代理。之后整篇翻译不受影响；如果不再使用该代理软件，建议关闭系统代理。");
    log("\n" + formatEnvReport(st) + "\n\n全部完成，用时 " + fmtDuration(Date.now() - t0) + "。现在可以在条目右键菜单里使用「Verso：整篇翻译」。");
    return st;
  }
  function formatEnvReport(st) {
    const ok = (b) => (b ? "✓" : "✗");
    return [
      "Python " + st.version + "：" + st.python,
      ok(st.pymupdf && st.babeldoc) + " PDF 解析与版面识别（PyMuPDF / BabelDOC）",
      ok(st.matplotlib) + " 公式排版（matplotlib）",
      ok(st.rapidfuzz) + " 图中文字匹配（rapidfuzz）",
      ok(!!st.ocr) + " 图片文字识别（" + (st.ocr === "vision" ? "macOS 系统 OCR" : st.ocr === "rapidocr" ? "RapidOCR" : "未安装") + "）",
      ok(st.font) + " 中文字体（思源宋体）",
      ok(st.model) + " 版面识别模型",
    ].concat(st.asset_error && !(st.font && st.model) ? ["  原因：" + st.asset_error] : []).join("\n");
  }
  // ------------------------------------------------------------ self-update
  // Zotero itself reads update.json about once a day, but raw.githubusercontent.com is often unreachable
  // from mainland China, so updates silently never arrive. 「检查更新」 and the daily background check
  // read the same update.json from GitHub first and jsDelivr (a CDN mirror of the repo) second, and
  // install the new .xpi in place: settings, glossary and translation cache are kept, no reinstall.
  const REPO = "zhouhuai09110v0/zotero-verso";
  const UPDATE_SOURCES = [
    { name: "GitHub", base: "https://raw.githubusercontent.com/" + REPO + "/main/" },
    { name: "jsDelivr", base: "https://cdn.jsdelivr.net/gh/" + REPO + "@main/" },
  ];
  const RELEASE_NOTES_URL = "https://github.com/" + REPO + "#更新日志";
  /** Pure: compares dotted versions ("0.7.10" > "0.7.9"); negative when a < b. */
  function cmpVersion(a, b) {
    const pa = String(a || "0").split(/[.-]/).map((n) => parseInt(n, 10) || 0);
    const pb = String(b || "0").split(/[.-]/).map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d < 0 ? -1 : 1;
    }
    return 0;
  }
  /** Pure: the newest entry of an update.json "updates" list. */
  function latestUpdate(list) {
    return (Array.isArray(list) ? list : []).filter((u) => u && u.version)
      .sort((x, y) => cmpVersion(y.version, x.version))[0] || null;
  }
  async function fetchUpdateManifest(sources = UPDATE_SOURCES) {
    const errors = [];
    for (const src of sources) {
      try {
        const xhr = await Zotero.HTTP.request("GET", src.base + "update.json?t=" + Date.now(), {
          responseType: "json", timeout: 12000, errorDelayIntervals: [], errorDelayMax: 0,
          headers: { "Cache-Control": "no-cache" },
        });
        let d = xhr.response;
        if (typeof d === "string") d = JSON.parse(d);
        const entry = d && d.addons && d.addons[env.pluginID];
        if (!entry || !Array.isArray(entry.updates) || !entry.updates.length) throw new Error("更新清单格式不对");
        return { src, list: entry.updates };
      } catch (e) {
        errors.push(src.name + "：" + String((e && (e.status ? "HTTP " + e.status : e.message)) || e).slice(0, 80));
      }
    }
    throw new Error("连不上更新服务器（" + errors.join("；") + "）。请检查网络后重试。");
  }
  /** { current, latest, available, file, hash, source } — never installs anything. */
  async function checkForUpdate(sources) {
    const { src, list } = await fetchUpdateManifest(sources);
    const latest = latestUpdate(list);
    const current = env.version || "0";
    setPref("lastUpdateCheck", String(Date.now()));
    return {
      current, latest: latest ? latest.version : current,
      available: !!latest && cmpVersion(latest.version, current) > 0,
      file: latest ? String(latest.update_link || "").split("/").pop() : "",
      hash: latest ? latest.update_hash || "" : "", source: src.name, notes: RELEASE_NOTES_URL,
    };
  }
  /** Downloads the .xpi (GitHub, then jsDelivr), checks its sha256 against update.json and installs it
   *  over the current version. Zotero restarts the plugin by itself; nothing to uninstall. */
  async function installUpdate(info, onProgress) {
    if (!info || !info.available || !info.file) throw new Error("没有可安装的新版本。");
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const errors = [];
    for (const src of UPDATE_SOURCES) {
      const url = src.base + info.file;
      try {
        const install = await AddonManager.getInstallForURL(url, {
          hash: info.hash || undefined, name: "Verso", version: info.latest,
          telemetryInfo: { source: "plugin" },
        });
        await new Promise((resolve, reject) => {
          install.addListener({
            onDownloadProgress: () => { if (onProgress && install.maxProgress > 0) onProgress(src.name, install.progress / install.maxProgress); },
            // AddonManager.ERROR_INCORRECT_HASH = -2, ERROR_CORRUPT_FILE = -3
            onDownloadFailed: () => reject(new Error(install.error === -2 ? "文件校验不通过（与 update.json 记录的 sha256 不一致），已拒绝安装"
              : install.error === -3 ? "下载的文件已损坏" : "下载失败（网络连接问题）")),
            onInstallFailed: () => reject(new Error("安装失败（文件校验未通过或被拒绝）")),
            onDownloadCancelled: () => reject(new Error("下载被取消")),
            onInstallCancelled: () => reject(new Error("安装被取消")),
            onInstallEnded: () => resolve(),
          });
          install.install();
        });
        return { version: info.latest, source: src.name };
      } catch (e) { errors.push(src.name + "：" + ((e && e.message) || e)); }
    }
    throw new Error("更新失败（" + errors.join("；") + "）。也可以到 GitHub 下载 " + info.file + " 手动安装，直接覆盖即可，不用卸载。");
  }
  // Background check: once a day, 20 s after Zotero starts; only tells the user, never installs by itself.
  let updateTimer = null;
  function startUpdateTimer(openSettings) {
    stopUpdateTimer();
    updateTimer = env.setTimeout(async () => {
      updateTimer = null;
      try {
        if (pref("autoCheckUpdate") === false) return;
        if (Date.now() - (Number(pref("lastUpdateCheck")) || 0) < 20 * 3600 * 1000) return;
        const info = await checkForUpdate();
        if (!info.available || pref("skipUpdateVersion") === info.latest) return;
        const pw = new Zotero.ProgressWindow({ closeOnClick: true });
        pw.changeHeadline("Verso 有新版本 " + info.latest);
        pw.addDescription("当前 " + info.current + "。点这里打开设置，按「检查更新」即可一键更新，不用卸载重装。");
        pw.show();
        try {
          const box = pw.progressWindow && pw.progressWindow.document;
          if (box && openSettings) box.addEventListener("click", () => { try { openSettings(); } catch (e) {} }, { once: true });
        } catch (e) {}
        pw.startCloseTimer(15000);
      } catch (e) { LOG("background update check failed", e); }
    }, 20000);
  }
  function stopUpdateTimer() { if (updateTimer) { try { env.clearTimeout(updateTimer); } catch (e) {} updateTimer = null; } }

  /** Status of everything, for the settings page. */
  async function checkEnvironment() {
    const lines = [];
    const uv = resolveTool("uv");
    const python = await findPython();
    lines.push("系统：" + (IS_WIN ? "Windows" : IS_MAC ? "macOS" : "Linux"));
    lines.push((uv ? "✓ uv：" + uv : "✗ uv 未安装（点「一键配置翻译环境」自动安装）"));
    if (python) {
      try { lines.push(formatEnvReport(await checkPython(python, false))); } catch (e) { lines.push("✗ Python 环境异常：" + e.message); }
    } else {
      lines.push("✗ 整篇翻译环境未安装（点「一键配置翻译环境」，只需一次）");
    }
    lines.push("", "翻译引擎：", "✓ Google（免费，无需配置）");
    const tool = (k, label, hint) => {
      const p = resolveTool(k);
      lines.push(p ? "✓ " + label + "：" + p : "✗ " + label + " 未找到 — " + hint);
    };
    tool("codex", "GPT（Codex CLI）", IS_WIN || !IS_MAC
      ? "安装 Node.js 后运行  npm install -g @openai/codex ，再运行  codex login  用 ChatGPT 账号登录"
      : "安装 ChatGPT 桌面版（自带 Codex），或  npm install -g @openai/codex  后  codex login");
    tool("claude", "Claude（Claude Code）", IS_WIN
      ? "先安装 Git for Windows，再在 PowerShell 运行  irm https://claude.ai/install.ps1 | iex ，然后运行  claude  登录"
      : "终端运行  curl -fsSL https://claude.ai/install.sh | bash ，再运行  claude  登录");
    const ch = geminiChannel();
    lines.push(ch === "api" ? "✓ Gemini：API Key" : ch === "agy" ? "✓ Gemini：Antigravity（" + resolveTool("agy") + "）"
      : ch === "cli" ? "✓ Gemini：Gemini CLI（不支持看图）"
        : "✗ Gemini 未配置 — 安装并登录 Antigravity，或在下方填写 Gemini API Key");
    lines.push((pref("deepseekApiKey") || "").trim() ? "✓ DeepSeek：API Key（" + deepseekModel() + "）"
      : "✗ DeepSeek 未配置 — 在 platform.deepseek.com 申请 API Key 后填在下方（国内可直连）");
    return lines.join("\n");
  }

  // ------------------------------------------------------------ test helper
  async function selfTest(engine) {
    const t0 = Date.now();
    const out = await translate("Supply chain finance improves working capital efficiency.", engine);
    return engineLabel(engine) + " ✓ " + ((Date.now() - t0) / 1000).toFixed(1) + "s → " + out;
  }
  function describeSetup() {
    ensureTokens();
    const mcp = mcpURL();
    const tok = (pref("mcpToken") || "").trim();
    const hdr = tok ? ' --header "Authorization: Bearer ' + tok + '"' : "";
    return {
      codex: resolveTool("codex"), claude: resolveTool("claude"), pdf2zh: resolveTool("pdf2zh"),
      gemini: geminiChannel() === "api" ? "API Key（" + geminiModel() + "）"
        : geminiChannel() === "agy" ? "Antigravity CLI " + resolveTool("agy") + "（" + agyModel() + "）"
          : resolveTool("gemini"),
      deepseek: (pref("deepseekApiKey") || "").trim() ? "API Key（" + deepseekModel() + "）" : "",
      bridge: bridgeBaseURL(), mcp,
      claudeMcpCmd: "claude mcp add --scope user --transport http zotero-library " + mcp + hdr,
      codexMcpCmd: "codex mcp add zotero-library --url " + mcp,
    };
  }

  return {
    // runtime
    ensureTokens, registerEndpoints, unregisterEndpoints, buildPopup, buildToolbar, attachAllReaders,
    detachAllReaders, translate, translateDocument, relayoutDocument, saveToNote, selfTest, describeSetup,
    setupEnvironment, checkEnvironment, findPython, IS_WIN,
    checkForUpdate, installUpdate, startUpdateTimer, stopUpdateTimer, version: env.version,
    resolveTool, ENGINES, LAYOUTS, engineLabel, docLayout, listCodexModels,
    // exported for tests
    _t: {
      parseGlossary, glossaryForText, glossaryToCSV, translatorSystemPrompt, cleanSelection,
      parseGoogleResponse, chunkText, buildCodexArgs, buildClaudeArgs, buildGeminiArgs, parseGeminiResponse,
      splitMessages, pickEngineFromModel, handleChatRequest, handleTranslateRequest, handleMcpRequest,
      parseBatchResult, batchSystemPrompt, parseVisionResult, visionPrompt, translateSegment, runBatch, mcpDispatch, pdf2zhArgs,
      noteBlockHTML, paraVisionPrompt, qaNoteBlockHTML, splitMath, looksMathy, renderAnswer, katex, buildQAPrompt, qaSystemPrompt, pageTextOf, qaEngine, runWithFlagFallback, decodeOutput, buildDeepSeekBody, parseDeepSeekResponse, deepseekErrorText, proxyEnvFromInfo, aiProxyEnv, netHint, isProxyFailure, friendlyError, cmpVersion, latestUpdate, fetchUpdateManifest, UPDATE_SOURCES, headerValue, formatProgress, fmtDuration,
      normalizePlaceholders, placeholdersIntact, isFormulaDense, isReferenceLike, isFragment, segmentGuard,
      findParagraph, isTranslationTitle, engineFromTitle, docStats, docLayout,
      attached: () => [...attachedWins.keys()].map((w) => { try { return w.location.href.slice(0, 80); } catch (e) { return "?"; } }),
      isAttached: (w) => attachedWins.has(w),
    },
  };
}
