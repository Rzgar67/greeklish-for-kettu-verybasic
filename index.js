(function () {
  const { before, after } = vendetta.patcher;
  const { findByProps } = vendetta.metro;
  const { React, ReactNative } = vendetta.metro.common;
  const { findInReactTree } = vendetta.utils;
  const { getAssetIDByName } = vendetta.ui.assets;
  const { showToast } = vendetta.ui.toasts;
  const { showConfirmationAlert } = vendetta.ui.alerts;

  const LazyActionSheet = findByProps("openLazy", "hideActionSheet");
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
    if (!content?.trim()) return showToast("no text to translate");
    showToast("translating...");
    try {
      const { greek, english } = await translate(content);
      showConfirmationAlert({
        title: "Greeklish Translation",
        content: `🇬🇷 ${greek}\n\n🇬🇧 ${english}`,
        confirmText: "Copy English",
        cancelText: "Close",
        onConfirm: () => {
          try { ReactNative.Clipboard.setString(english); showToast("copied"); } catch (e) {}
        },
      });
    } catch (e) {
      showToast("translation failed :(");
    }
  }

  // ---------- Find rows in the sheet by label ----------
  const isRow = (x) =>
    x && typeof x === "object" && x.props && typeof x.props.label === "string" && x.type;

  function findRowArray(tree) {
    return findInReactTree(
      tree,
      (x) => Array.isArray(x) && x.length > 0 && x.some(isRow)
    );
  }

  function makeRow(sibling, message, key) {
    const iconId = getAssetIDByName("ic_locale_24px") ?? getAssetIDByName("ic_globe_24px");
    const oldIcon = sibling.props.icon;
    let icon = oldIcon;
    try {
      if (oldIcon && oldIcon.type) {
        icon = React.createElement(oldIcon.type, { ...oldIcon.props, source: iconId });
      }
    } catch (e) {}
    return React.createElement(sibling.type, {
      ...sibling.props,
      key,
      label: "Translate Greeklish",
      icon,
      onPress: () => {
        try { LazyActionSheet.hideActionSheet(); } catch (e) {}
        handle(message.content);
      },
      // strip props that would make it behave like the sibling
      trailing: undefined,
      subLabel: undefined,
      variant: undefined,
      destructive: undefined,
      arrow: undefined,
    });
  }

  patches.push(
    before("openLazy", LazyActionSheet, ([component, key, msg]) => {
      const message = msg?.message;
      if (!message || !String(key).includes("MessageLongPress")) return;

      component.then((instance) => {
        const unpatch = after("default", instance, (_, comp) => {
          React.useEffect(() => () => { unpatch(); }, []);

          const rows = findRowArray(comp);
          if (!rows) return;
          if (rows.some((r) => r?.props?.label === "Translate Greeklish")) return;

          const idx = rows.findIndex((r) => isRow(r) && /copy text/i.test(r.props.label));
          const sibling = rows[idx >= 0 ? idx : 0];
          if (!isRow(sibling)) return;

          rows.splice(idx >= 0 ? idx + 1 : 1, 0, makeRow(sibling, message, "greeklish-translate"));
        });
      });
    })
  );

  return {
    onUnload: () => patches.forEach((p) => p()),
  };
})();
