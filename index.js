(function () {
  const { before, after } = vendetta.patcher;
  const { findByProps, findByStoreName } = vendetta.metro;
  const { React, ReactNative, stylesheet } = vendetta.metro.common;
  const { findInReactTree } = vendetta.utils;
  const { getAssetIDByName } = vendetta.ui.assets;
  const { semanticColors } = vendetta.ui;
  const { Forms } = vendetta.ui.components;
  const { showToast } = vendetta.ui.toasts;
  const { showConfirmationAlert } = vendetta.ui.alerts;

  const LazyActionSheet = findByProps("openLazy", "hideActionSheet");
  const ActionSheetRow = findByProps("ActionSheetRow")?.ActionSheetRow ?? Forms.FormRow;
  const MessageStore = findByStoreName("MessageStore");

  const styles = stylesheet.createThemedStyleSheet({
    iconComponent: {
      width: 24,
      height: 24,
      tintColor: semanticColors.INTERACTIVE_NORMAL,
    },
  });

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
    // keep mentions / emojis / channels untouched
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
    let english = json[0].map((s) => s[0]).join("");
    const restore = (s) =>
      s.replace(/zzph(\d+)zz/gi, (_, n) => placeholders[Number(n)] ?? "");
    return { greek: restore(greek), english: restore(english) };
  }

  async function handle(content) {
    if (!content?.trim()) return showToast("no text to translate", getAssetIDByName("Small"));
    showToast("translating...", getAssetIDByName("LanguageIcon"));
    try {
      const { greek, english } = await translate(content);
      showConfirmationAlert({
        title: "Greeklish Translation",
        content: `🇬🇷 ${greek.trim()}\n\n🇬🇧 ${english.trim()}`,
        confirmText: "Copy English",
        cancelText: "Close",
        onConfirm: () => {
          try { ReactNative.Clipboard.setString(english.trim()); showToast("copied"); } catch (e) {}
        },
      });
    } catch (e) {
      console.error("[Greeklish]", e);
      showToast("translation failed :(", getAssetIDByName("Small"));
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
        const content = original?.content ?? message.content;
        if (!content) return;

        const icon = getAssetIDByName("LanguageIcon") ?? getAssetIDByName("ic_locale_24px");

        const row = React.createElement(ActionSheetRow, {
          label: "Translate Greeklish",
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
            handle(content);
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
