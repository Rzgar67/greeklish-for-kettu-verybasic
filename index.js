(function () {
  const { before, after } = vendetta.patcher;
  const { findByProps, findByStoreName } = vendetta.metro;
  const { React, ReactNative, stylesheet, FluxDispatcher } = vendetta.metro.common;
  const { findInReactTree } = vendetta.utils;
  const { getAssetIDByName } = vendetta.ui.assets;
  const { semanticColors } = vendetta.ui;
  const { Forms } = vendetta.ui.components;

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

  // messageId -> original content (so we can revert)
  let cache = {};

  // ---------- Greeklish -> Greek ----------
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

  async function translate(text) {
    // keep mentions / emojis / channels / links untouched
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
    const restore = (s) =>
      s.replace(/zzph(\d+)zz/gi, (_, n) => placeholders[Number(n)] ?? "");
    return restore(english).trim();
  }

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
      // Revert
      if (cache[msg.id] !== undefined) {
        updateMessage(msg, cache[msg.id]);
        delete cache[msg.id];
        return;
      }
      // Translate
      if (!content?.trim()) return;
      const english = await translate(content);
      cache[msg.id] = content;
      updateMessage(msg, `${content}\n${english} \`[en]\``);
    } catch (e) {
      console.error("[Greeklish]", e);
      try {
        ReactNative.Alert.alert("Greeklish Translator", "Translation failed. Check debug logs.");
      } catch (_) {}
    }
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
        // when already translated, original text comes from the cache
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

        // fallback
        const buttons = findInReactTree(
          component,
          (x) => Array.isArray(x) && x[0]?.type?.name === "ActionSheetRow"
        );
        if (buttons) buttons.unshift(row);
      });
    }).catch((err) => console.error("[Greeklish] LazyActionSheet failed:", err));
  });

  return {
    onUnload: () => unpatchOpenLazy(),
  };
})();
