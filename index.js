(function () {
  const { before, after } = vendetta.patcher;
  const { findByProps } = vendetta.metro;
  const { React, ReactNative } = vendetta.metro.common;
  const { findInReactTree } = vendetta.utils;
  const { getAssetIDByName } = vendetta.ui.assets;
  const { showToast } = vendetta.ui.toasts;
  const { showConfirmationAlert } = vendetta.ui.alerts;

  const LazyActionSheet = findByProps("openLazy", "hideActionSheet");
  const ActionSheetRow = findByProps("ActionSheetRow")?.ActionSheetRow;

  const patches = [];

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
    // final sigma
    return out.replace(/σ(?![α-ωά-ώ])/g, "ς");
  }

  async function translate(text) {
    const greek = greeklishToGreek(text);
    const url =
      "https://translate.googleapis.com/translate_a/single?client=gtx&sl=el&tl=en&dt=t&q=" +
      encodeURIComponent(greek);
    const res = await fetch(url);
    const json = await res.json();
    const english = json[0].map((s) => s[0]).join("");
    return { greek, english };
  }

  async function handle(content) {
    if (!content?.trim()) return showToast("no text to translate", getAssetIDByName("Small"));
    showToast("translating...", getAssetIDByName("ic_locale_24px"));
    try {
      const { greek, english } = await translate(content);
      showConfirmationAlert({
        title: "Greeklish Translation",
        content: `🇬🇷 ${greek}\n\n🇬🇧 ${english}`,
        confirmText: "Copy English",
        cancelText: "Close",
        onConfirm: () => {
          try { ReactNative.Clipboard.setString(english); showToast("copied", getAssetIDByName("toast_copy_link")); } catch (e) {}
        },
      });
    } catch (e) {
      showToast("translation failed :(", getAssetIDByName("Small"));
    }
  }

  // ---------- Patch message long-press sheet ----------
  patches.push(
    before("openLazy", LazyActionSheet, ([component, key, msg]) => {
      const message = msg?.message;
      if (key !== "MessageLongPressActionSheet" || !message) return;

      component.then((instance) => {
        const unpatch = after("default", instance, (_, comp) => {
          React.useEffect(() => () => { unpatch(); }, []);

          const buttons = findInReactTree(
            comp,
            (x) => Array.isArray(x) && x[0]?.type?.name === "ButtonRow"
          );
          if (!buttons) return;

          const Row = ActionSheetRow ?? buttons[0].type;
          const row = React.createElement(Row, {
            label: "Translate Greeklish",
            icon: React.createElement(Row.Icon ?? (() => null), {
              source: getAssetIDByName("ic_locale_24px"),
            }),
            onPress: () => {
              LazyActionSheet.hideActionSheet();
              handle(message.content);
            },
          });
          buttons.splice(1, 0, row);
        });
      });
    })
  );

  return {
    onUnload: () => patches.forEach((p) => p()),
  };
})();
