/* Verso — preference pane script (runs in the settings window) */
(function () {
  let tries = 0;
  function init() {
    const out = document.getElementById("clitrans-test-out");
    const gl = document.getElementById("clitrans-glossary");
    if (!out || !gl) {
      if (tries++ < 50) setTimeout(init, 100);
      return;
    }
    if (gl.dataset.clitransReady) return;
    gl.dataset.clitransReady = "1";
    const api = Zotero.CLITrans;
    if (!api) { out.textContent = "插件尚未加载完成，请重新打开设置。"; return; }

    // glossary textarea is bound manually
    gl.value = Zotero.Prefs.get("clitrans.glossary") || "";
    gl.addEventListener("input", () => Zotero.Prefs.set("clitrans.glossary", gl.value));

    // ---- version & update
    const ver = document.getElementById("clitrans-ver");
    const updOut = document.getElementById("clitrans-upd-out");
    const updBtn = document.getElementById("clitrans-upd-check");
    const insBtn = document.getElementById("clitrans-upd-install");
    ver.textContent = "Verso " + (api.version || "");
    const say = (t) => { updOut.hidden = false; updOut.textContent = t; };
    let found = null;
    updBtn.addEventListener("command", async () => {
      updBtn.disabled = true; insBtn.hidden = true; found = null;
      say("正在检查更新…");
      try {
        const info = await api.checkForUpdate();
        if (info.available) {
          found = info;
          insBtn.hidden = false;
          say("发现新版本 " + info.latest + "（当前 " + info.current + "，来源：" + info.source + "）。\n点「立即更新」直接覆盖安装，不用卸载。\n更新内容：" + info.notes);
        } else {
          say("已是最新版本 " + info.current + "（来源：" + info.source + "）。");
        }
      } catch (e) { say("⚠️ " + ((e && e.message) || e)); }
      finally { updBtn.disabled = false; }
    });
    insBtn.addEventListener("command", async () => {
      if (!found) return;
      insBtn.disabled = true; updBtn.disabled = true;
      say("正在下载 " + found.latest + "…");
      try {
        const r = await api.installUpdate(found, (src, f) => say("正在从 " + src + " 下载 " + found.latest + "… " + Math.round(f * 100) + "%"));
        insBtn.hidden = true;
        say("✓ 已更新到 " + r.version + "（来源：" + r.source + "）。新版本已生效；关闭并重新打开设置页即可看到新的选项。");
      } catch (e) { say("⚠️ " + ((e && e.message) || e)); insBtn.disabled = false; }
      finally { updBtn.disabled = false; }
    });

    const showSetup = () => {
      const s = api.describeSetup();
      document.getElementById("clitrans-mcp-cmds").textContent =
        "# Claude Code\n" + s.claudeMcpCmd + "\n\n# Codex\n" + s.codexMcpCmd + "\n\nMCP 地址：" + s.mcp;
      return s;
    };
    showSetup();

    const test = (engine) => async () => {
      out.textContent = api.ENGINES[engine].label + " 测试中…";
      try { out.textContent = await api.selfTest(engine); }
      catch (e) { out.textContent = "⚠️ " + ((e && e.message) || e); }
    };
    document.getElementById("clitrans-test-google").addEventListener("command", test("google"));
    document.getElementById("clitrans-test-codex").addEventListener("command", test("codex"));
    document.getElementById("clitrans-test-claude").addEventListener("command", test("claude"));
    document.getElementById("clitrans-test-gemini").addEventListener("command", test("gemini"));
    document.getElementById("clitrans-test-deepseek").addEventListener("command", test("deepseek"));
    document.getElementById("clitrans-codex-models").addEventListener("command", async () => {
      out.textContent = "读取 Codex 模型列表…";
      try {
        const models = await api.listCodexModels();
        const ml = document.getElementById("clitrans-codex-model");
        const popup = document.getElementById("clitrans-codex-model-popup");
        const keep = ml.value;
        popup.replaceChildren();
        for (const m of models) {
          const it = document.createXULElement("menuitem");
          it.setAttribute("label", m.id);
          it.setAttribute("value", m.id);
          it.setAttribute("description", m.description);
          popup.append(it);
        }
        ml.value = keep;
        out.textContent = "你的 Codex 可用模型：\n" + models.map((m) => "• " + m.id + " — " + m.description).join("\n");
      } catch (e) { out.textContent = "⚠️ " + ((e && e.message) || e); }
    });
    const envOut = document.getElementById("clitrans-env-out");
    let busy = false;
    document.getElementById("clitrans-env-check").addEventListener("command", async () => {
      if (busy) return;
      envOut.textContent = "检测中…";
      try { envOut.textContent = await api.checkEnvironment(); }
      catch (e) { envOut.textContent = "⚠️ " + ((e && e.message) || e); }
    });
    document.getElementById("clitrans-env-setup").addEventListener("command", async () => {
      if (busy) return;
      busy = true;
      const btn = document.getElementById("clitrans-env-setup");
      btn.disabled = true;
      let text = "";
      const log = (s) => {
        text = (text + "\n" + s).slice(-8000);
        envOut.textContent = text.trim();
        envOut.scrollTop = envOut.scrollHeight;
      };
      try {
        await api.setupEnvironment(log);
        log("\n" + await api.checkEnvironment());
      } catch (e) {
        const msg = String((e && e.message) || e);
        log("\n⚠️ 配置中断：" + msg + "\n可以再点一次「一键配置翻译环境」继续（已装好的部分会跳过）。" +
          (/代理/.test(msg) ? "" : "网络慢时勾选「使用国内镜像」。"));
      } finally { busy = false; btn.disabled = false; }
    });
    document.getElementById("clitrans-detect").addEventListener("command", () => {
      const s = showSetup();
      out.textContent =
        "Codex：" + (s.codex || "未找到") + "\nClaude Code：" + (s.claude || "未找到") +
        "\nGemini：" + (s.gemini || "未配置（填 API Key 或安装 Gemini CLI）") +
        "\nDeepSeek：" + (s.deepseek || "未配置（填 DeepSeek API Key）") +
        "\npdf2zh_next：" + (s.pdf2zh || "未找到") + "\n本地接口：" + s.bridge;
    });
  }
  init();
})();
