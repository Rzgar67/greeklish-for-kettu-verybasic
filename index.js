(function () {
  const { before, after } = vendetta.patcher;
  const { findByProps, findByStoreName } = vendetta.metro;
  const { React, ReactNative, stylesheet, FluxDispatcher } = vendetta.metro.common;
  const { findInReactTree } = vendetta.utils;
  const { getAssetIDByName } = vendetta.ui.assets;
  const { semanticColors } = vendetta.ui;
  const { Forms } = vendetta.ui.components;
  const { storage } = vendetta.plugin;
  const { useProxy } = vendetta.storage;
  const { registerCommand } = vendetta.commands;

  const LazyActionSheet = findByProps("openLazy", "hideActionSheet");
  const ActionSheetRow = findByProps("ActionSheetRow")?.ActionSheetRow ?? Forms.FormRow;
  const MessageStore = findByStoreName("MessageStore");
  const ChannelStore = findByStoreName("ChannelStore");

  const styles = stylesheet.createThemedStyleSheet({
    iconComponent: {
      width: 24,
      height: 24,
      tintColor: semanticColors.INTERACTIVE_NORMAL,
    },
  });

  // ---------- settings defaults ----------
  const defaults = {
    useAI: false,
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "",
    contextCount: "5",
  };
  for (const k in defaults) if (storage[k] === undefined) storage[k] = defaults[k];

  // messageId -> original content (so we can revert)
  let cache = {};

  // ---------- Greeklish -> Greek (rule based, used for Google mode) ----------
  const digraphs = [
    ["th", "θ"], ["ps", "ψ"], ["ks", "ξ"], ["ch", "χ"], ["ou", "ου"],
    ["ai", "αι"], ["ei", "ει"], ["oi", "οι"], ["mp", "μπ"], ["nt", "ντ"],
    ["gk", "γκ"], ["gg", "γγ"], ["ts", "τσ"], ["tz", "τζ"], ["dh", "δ"],
  ];
  const singles = {
    a: "α", b: "β", c: "κ", d: "δ", e: "ε", f: "φ", g: "γ", h: "η",
    i: "ι", j: "ζ", k: "κ", l: "λ", m: "μ", n: "ν", o: "ο", p: "π",
    q: "κ", r: "ρ", s: "σ", t: "τ", u: "υ", v: "β", w: "ω", x: "χ",
    y: "υ", z: "ζ", "8": "θ", "3": "ε",
  };

  function greeklishToGreek(text) {
    let out = "";
    const lower = text.toLowerCase();
    for (let i = 0; i < lower.length; ) {
      const pair = lower.slice(i, i + 2);
      const d = digraphs.find((x) => x[0] === pair);
      if (d) { out += d[1]; i += 2; continue; }
      const ch = lower[i];
      out += singles[ch] ?? ch;
      i++;
    }
    return out.replace(/σ(?![α-ωά-ώ])/g, "ς");
  }

  async function translateGoogle(text) {
    const placeholders = [];
    const safe = text.replace(/<(a?):\w+:\d+>|<@[!&]?\d+>|<#\d+>|https?:\/\/\S+/g, (m) => {
      placeholders.push(m);
      return ` zzph${placeholders.length - 1}zz `;
    });
    const greek = greeklishToGreek(safe).replace(/ζζπη(\d+)ζζ/g, (_, n) => ` zzph${n}zz `);
    const url =
      "https://translate.googleapis.com/translate_a/single?client=gtx&sl=el&tl=en&dt=t&q=" +
      encodeURIComponent(greek);
    const res = await fetch(url);
    const json = await res.json();
    const english = json[0].map((s) => s[0]).join("");
    return english
      .replace(/zzph(\d+)zz/gi, (_, n) => placeholders[Number(n)] ?? "")
      .trim();
  }

  // ---------- AI translation (any OpenAI-compatible API) ----------
  const SYSTEM_PROMPT = `You translate Discord chat messages written in "Greeklish" (Greek typed with Latin letters) into natural English.
People may try to hide their meaning, so expect:
- vowels dropped or heavily abbreviated words (e.g. "kl" = "καλά" = good, "pxndi" = "παιχνίδι" = game)
- slang, typos, numbers used as letters (8 = θ, 3 = ε), mixed English/Turkish words, names and nicknames left as-is
- messages that are already English or another language: just translate/keep them naturally
Use the recent chat messages (if given) to resolve ambiguity.
Examples:
"Ga s token ps sai" -> "Hey token, how are you?"
"kl es?" -> "Good, you?"
"xromai" -> "I'm glad"
"Anpmn ga t pxndi" -> "I can't wait for the game"
Keep mentions (<@123>), emojis (<:name:123>) and links exactly as written.
Reply with ONLY the English translation. No quotes, no explanations. If you are unsure of a word, give your best guess and put "(?)" after it.`;

  function getContext(msg) {
    const n = parseInt(storage.contextCount, 10) || 0;
    if (n <= 0) return "";
    try {
      const col = MessageStore.getMessages(msg.channel_id);
      let arr = col?.toArray?.() ?? col?._array ?? [];
      arr = [...arr].sort((a, b) => a.id.length - b.id.length || (a.id < b.id ? -1 : 1));
      const i = arr.findIndex((m) => m.id === msg.id);
      const prev = (i >= 0 ? arr.slice(Math.max(0, i - n), i) : arr.slice(-n))
        .filter((m) => m.content)
        .map((m) => `${m.author?.username ?? "?"}: ${m.content}`);
      return prev.join("\n");
    } catch (e) {
      return "";
    }
  }

  async function aiRequest(userContent) {
    const base = String(storage.baseUrl || "").trim().replace(/\/+$/, "");
    const res = await fetch(base + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + String(storage.apiKey).trim(),
      },
      body: JSON.stringify({
        model: String(storage.model).trim(),
        temperature: 0.2,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = await res.json();
    return String(json.choices[0].message.content).trim();
  }

  async function translateAI(text, msg) {
    const ctx = getContext(msg);
    const user = (ctx ? `Recent chat (context only, do not translate):\n${ctx}\n\n` : "") +
      `Translate this message:\n${text}`;
    return aiRequest(user);
  }

  const aiReady = () =>
    storage.useAI && storage.apiKey && storage.baseUrl && storage.model;

  // ---------- edit the message locally ----------
  function updateMessage(msg, content) {
    FluxDispatcher.dispatch({
      type: "MESSAGE_UPDATE",
      message: {
        id: msg.id,
        channel_id: msg.channel_id,
        guild_id: ChannelStore?.getChannel?.(msg.channel_id)?.guild_id,
        content,
      },
      log_edit: false,
      otherPluginBypass: true,
    });
  }

  async function toggle(msg, content) {
    try {
      if (cache[msg.id] !== undefined) {
        updateMessage(msg, cache[msg.id]);
        delete cache[msg.id];
        return;
      }
      if (!content?.trim()) return;

      let english;
      let tag = "en";
      if (aiReady()) {
        try {
          english = await translateAI(content, msg);
          tag = "ai-en";
        } catch (e) {
          console.error("[Greeklish] AI failed, falling back to Google:", e);
        }
      }
      if (english === undefined) english = await translateGoogle(content);

      cache[msg.id] = content;
      updateMessage(msg, `${content}\n${english} \`[${tag}]\``);
    } catch (e) {
      console.error("[Greeklish]", e);
      try {
        ReactNative.Alert.alert("Greeklish Translator", "Translation failed. Check debug logs.");
      } catch (_) {}
    }
  }

  // ---------- settings page ----------
  function Settings() {
    useProxy(storage);
    const { ScrollView } = ReactNative;
    const { FormSection, FormInput, FormSwitchRow, FormText, FormRow, FormDivider } = Forms;

    return React.createElement(
      ScrollView,
      { style: { flex: 1 } },
      React.createElement(
        FormSection,
        { title: "AI translation", titleStyleType: "no_border" },
        React.createElement(FormSwitchRow, {
          label: "Use AI for translating",
          subLabel: "Much better at vowel-less / slangy Greeklish. Uses your own API key. Falls back to Google if it fails.",
          value: !!storage.useAI,
          onValueChange: (v) => { storage.useAI = v; },
        }),
        React.createElement(FormDivider),
        React.createElement(FormInput, {
          title: "API base URL (OpenAI-compatible)",
          placeholder: "https://api.openai.com/v1",
          value: storage.baseUrl,
          onChange: (v) => { storage.baseUrl = v; },
          autoCapitalize: "none",
          autoCorrect: false,
        }),
        React.createElement(FormInput, {
          title: "API key",
          placeholder: "sk-...",
          value: storage.apiKey,
          onChange: (v) => { storage.apiKey = v; },
          secureTextEntry: true,
          autoCapitalize: "none",
          autoCorrect: false,
        }),
        React.createElement(FormInput, {
          title: "Model name",
          placeholder: "exact model id from your provider",
          value: storage.model,
          onChange: (v) => { storage.model = v; },
          autoCapitalize: "none",
          autoCorrect: false,
        }),
        React.createElement(FormInput, {
          title: "Previous messages sent as context (0 = none)",
          placeholder: "5",
          value: String(storage.contextCount),
          onChange: (v) => { storage.contextCount = v.replace(/[^0-9]/g, ""); },
          keyboardType: "number-pad",
        }),
        React.createElement(FormRow, {
          label: "Test AI connection",
          onPress: async () => {
            try {
              if (!aiReady()) throw new Error("Turn on AI and fill in URL, key and model first.");
              const out = await aiRequest("Translate this message:\nAnpmn ga t pxndi");
              ReactNative.Alert.alert("AI works ✅", `"Anpmn ga t pxndi" →\n${out}`);
            } catch (e) {
              ReactNative.Alert.alert("AI test failed ❌", String(e?.message ?? e));
            }
          },
        }),
        React.createElement(FormText, {
          style: { padding: 16, opacity: 0.7 },
          children:
            "Your key is stored only on this device and only sent to the base URL above. When AI is on, the message you translate (plus the context messages) is sent to that provider.",
        })
      )
    );
  }

  // ---------- Patch the message long-press sheet (same method as Dislate) ----------
  const unpatchOpenLazy = before("openLazy", LazyActionSheet, ([component, key, msg]) => {
    const message = msg?.message;
    if (key !== "MessageLongPressActionSheet" || !message) return;

    component.then((instance) => {
      const unpatch = after("default", instance, (_, component) => {
        React.useEffect(() => () => { unpatch(); }, []);

        const original = MessageStore?.getMessage?.(message.channel_id, message.id);
        const target = original ?? message;
        const messageId = target.id ?? message.id;
        const isTranslated = cache[messageId] !== undefined;
        const content = isTranslated ? cache[messageId] : (original?.content ?? message.content);
        if (!content) return;

        const icon = isTranslated
          ? getAssetIDByName("ic_highlight")
          : getAssetIDByName("LanguageIcon") ?? getAssetIDByName("ic_locale_24px");

        const row = React.createElement(ActionSheetRow, {
          label: isTranslated ? "Revert Greeklish" : "Translate Greeklish",
          icon: ActionSheetRow.Icon
            ? React.createElement(ActionSheetRow.Icon, {
                source: icon,
                IconComponent: () =>
                  React.createElement(ReactNative.Image, {
                    resizeMode: "cover",
                    style: styles.iconComponent,
                    source: icon,
                  }),
              })
            : undefined,
          onPress: () => {
            try { LazyActionSheet.hideActionSheet(); } catch (e) {}
            toggle({ id: messageId, channel_id: message.channel_id }, content);
          },
        });

        const groups = findInReactTree(
          component,
          (c) => Array.isArray(c) && c[0]?.type?.name === "ActionSheetRowGroup"
        );

        if (groups?.length) {
          for (let gi = 0; gi < groups.length; gi++) {
            const groupChildren = findInReactTree(
              groups[gi],
              (c) => Array.isArray(c) && c.some((child) => child?.type?.name === "ActionSheetRow")
            );
            if (groupChildren) {
              groupChildren.unshift(row);
              return;
            }
          }
        }

        const buttons = findInReactTree(
          component,
          (x) => Array.isArray(x) && x[0]?.type?.name === "ActionSheetRow"
        );
        if (buttons) buttons.unshift(row);
      });
    }).catch((err) => console.error("[Greeklish] LazyActionSheet failed:", err));
  });

  // ---------- /greeklish slash command (config without the settings page) ----------
  const ClydeUtils = findByProps("sendBotMessage");
  const mask = (k) => (k ? String(k).slice(0, 4) + "…" + String(k).slice(-3) : "(none)");
  const statusText = () =>
    "**Greeklish config**\n" +
    `AI: ${storage.useAI ? "on" : "off"}\n` +
    `URL: ${storage.baseUrl || "(none)"}\n` +
    `Model: ${storage.model || "(none)"}\n` +
    `Key: ${mask(storage.apiKey)}\n` +
    `Context messages: ${storage.contextCount}`;

  const opt = (name, description, type) => ({
    name,
    displayName: name,
    description,
    displayDescription: description,
    type,
    required: false,
  });

  const unregisterCommand = registerCommand({
    name: "greeklish",
    displayName: "greeklish",
    description: "Configure the Greeklish translator (AI mode, key, model...)",
    displayDescription: "Configure the Greeklish translator (AI mode, key, model...)",
    applicationId: "-1",
    type: 1,
    inputType: 1,
    options: [
      opt("ai", "Turn AI translation on or off", 5),
      opt("url", "API base URL (OpenAI-compatible)", 3),
      opt("key", "API key", 3),
      opt("model", "Model name", 3),
      opt("context", "How many previous messages to send as context (0 = none)", 3),
      opt("test", "Test the AI connection", 5),
    ],
    async execute(args, ctx) {
      const get = (n) => args.find((a) => a.name === n)?.value;
      let out = [];
      try {
        if (get("ai") !== undefined) { storage.useAI = !!get("ai"); out.push(`AI turned ${storage.useAI ? "on" : "off"}.`); }
        if (get("url") !== undefined) { storage.baseUrl = String(get("url")).trim(); out.push("URL saved."); }
        if (get("key") !== undefined) { storage.apiKey = String(get("key")).trim(); out.push("Key saved."); }
        if (get("model") !== undefined) { storage.model = String(get("model")).trim(); out.push("Model saved."); }
        if (get("context") !== undefined) { storage.contextCount = String(get("context")).replace(/[^0-9]/g, "") || "0"; out.push("Context saved."); }
        if (get("test")) {
          if (!aiReady()) {
            out.push("❌ Test failed: turn AI on and set url, key and model first.");
          } else {
            try {
              const r = await aiRequest("Translate this message:\nAnpmn ga t pxndi");
              out.push(`✅ AI works: "Anpmn ga t pxndi" → ${r}`);
            } catch (e) {
              out.push(`❌ AI test failed: ${String(e?.message ?? e)}`);
            }
          }
        }
      } catch (e) {
        out.push(`Error: ${String(e?.message ?? e)}`);
      }
      ClydeUtils.sendBotMessage(ctx.channel.id, (out.length ? out.join("\n") + "\n\n" : "") + statusText());
    },
  });

  return {
    onUnload: () => {
      unpatchOpenLazy();
      try { unregisterCommand(); } catch (e) {}
    },
    settings: Settings,
  };
})();
